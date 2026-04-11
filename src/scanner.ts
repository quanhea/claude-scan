// src/scanner.ts — top-level orchestrator
import * as path from "path";
import { ScanOptions, STATUS, DEFAULTS } from "./types";
import { runPreflight, removeLockFile } from "./preflight";
import { discoverFiles } from "./discovery";
import { loadPrompt } from "./prompt";
import {
  initState,
  loadState,
  saveState,
  resetStaleRunning,
  updateFileStatus,
  getPendingFiles,
  markForRetry,
  computeStats,
} from "./state";
import { WorkerPool } from "./worker-pool";
import { fileToSlug } from "./worker";
import { writeSummary } from "./reporter";
import {
  isTTY,
  printLogLine,
  printTTYProgress,
  formatDuration,
} from "./progress";

export async function scan(options: ScanOptions): Promise<number> {
  const {
    targetDir,
    outputDir,
    parallel,
    timeout,
    maxRetries,
    maxTurns,
    maxFileSizeKB,
    model,
    promptFile,
    include,
    exclude,
    resume,
    dryRun,
    force,
    verbose,
  } = options;

  const absTarget = path.resolve(targetDir);
  const absOutput = path.resolve(outputDir);

  // Preflight
  const preflight = runPreflight(absTarget, absOutput, { force });

  // Load prompt template
  const promptTemplate = loadPrompt(promptFile);

  // Build config
  const config = {
    parallel,
    timeout,
    maxRetries,
    maxTurns,
    maxFileSizeKB,
    model,
    prompt: promptFile ?? DEFAULTS.prompt,
    verbose,
  };

  // Discover or resume
  let state;
  if (resume) {
    state = loadState(absOutput);
    if (!state) {
      removeLockFile(absOutput);
      throw new Error("No previous scan found. Run without --resume first.");
    }
    const resetCount = resetStaleRunning(state);
    if (resetCount > 0) {
      console.log(`Resumed: reset ${resetCount} interrupted scans to pending.`);
    }
    // Apply new config overrides
    state.config = config;
  } else {
    // Discover files
    let files: string[];
    if (preflight.singleFile) {
      files = [path.relative(absTarget, preflight.singleFile) || path.basename(preflight.singleFile)];
    } else {
      files = discoverFiles(absTarget, { include, exclude, maxFileSizeKB });
    }

    if (files.length === 0) {
      removeLockFile(absOutput);
      console.log("No files to scan.");
      return 0;
    }

    state = initState(absTarget, files, config);
  }

  const pendingFiles = getPendingFiles(state);

  // Dry run
  if (dryRun) {
    removeLockFile(absOutput);
    console.log(`Would scan ${pendingFiles.length} files:`);
    for (const f of pendingFiles) {
      console.log(`  ${f}`);
    }
    return 0;
  }

  console.log(
    `Scanning ${pendingFiles.length} files with ${parallel} workers...`,
  );

  // Save initial state
  saveState(state, absOutput);

  // Create pool
  const pool = new WorkerPool({
    files: pendingFiles,
    concurrency: parallel,
    targetDir: absTarget,
    outputDir: absOutput,
    promptTemplate,
    config,
  });

  const startTime = Date.now();
  const activeStartTimes = new Map<string, number>();

  // Periodic state checkpoint
  const checkpointInterval = setInterval(() => {
    saveState(state, absOutput);
  }, 30_000);

  // TTY progress update
  let progressInterval: NodeJS.Timeout | null = null;
  if (isTTY) {
    progressInterval = setInterval(() => {
      const activeFiles = new Map<string, { index: number; startedAt: number }>();
      for (const [file, idx] of pool.getActiveFiles()) {
        activeFiles.set(file, {
          index: idx,
          startedAt: activeStartTimes.get(file) ?? Date.now(),
        });
      }
      printTTYProgress({
        stats: state.stats,
        activeFiles,
        elapsed: Date.now() - startTime,
      });
    }, 500);
  }

  // Signal handling
  let shuttingDown = false;
  const handleSignal = () => {
    if (shuttingDown) {
      // Second signal — force kill
      console.log("\nForce stopping...");
      pool.killAll();
      // Mark running as interrupted
      for (const [file] of pool.getActiveFiles()) {
        updateFileStatus(state, file, STATUS.INTERRUPTED);
      }
      saveState(state, absOutput);
      removeLockFile(absOutput);
      if (progressInterval) clearInterval(progressInterval);
      clearInterval(checkpointInterval);
      process.exit(130);
    }
    shuttingDown = true;
    const active = pool.activeCount;
    console.log(
      `\nStopping gracefully... waiting for ${active} running scan${active !== 1 ? "s" : ""}.`,
    );
    console.log("Ctrl+C again to force quit.");
    pool.stopAcceptingNew();
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // Wire pool events
  pool.on("start", (file: string, workerIndex: number) => {
    activeStartTimes.set(file, Date.now());
    updateFileStatus(state, file, STATUS.RUNNING, {
      startedAt: new Date().toISOString(),
      attempts: (state.files[file]?.attempts ?? 0) + 1,
    });
    if (!isTTY) {
      printLogLine("START", file, `worker ${workerIndex + 1}`);
    }
  });

  pool.on("done", (file: string, result: { status: string; durationMs: number; exitCode: number | null; error?: string }, workerIndex: number) => {
    activeStartTimes.delete(file);

    const reportPath = path.join(absOutput, "reports", fileToSlug(file) + ".md");

    if (result.status === STATUS.COMPLETED) {
      updateFileStatus(state, file, STATUS.COMPLETED, {
        completedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        reportPath,
      });
      if (!isTTY) {
        printLogLine("DONE", file, `${formatDuration(result.durationMs)}`);
      }
    } else if (result.status === STATUS.TIMEOUT) {
      updateFileStatus(state, file, STATUS.TIMEOUT, {
        completedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        lastError: "timeout",
      });
      markForRetry(state, file, maxRetries);
      if (!isTTY) {
        printLogLine("TIMEOUT", file, `exceeded ${timeout}s`);
      }
    } else {
      updateFileStatus(state, file, STATUS.FAILED, {
        completedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        lastError: result.error,
      });
      markForRetry(state, file, maxRetries);
      if (!isTTY) {
        printLogLine("FAIL", file, result.error ?? "unknown error");
      }
    }

    // Save state after each completion
    saveState(state, absOutput);
  });

  // Run pool
  await pool.start();

  // Cleanup
  clearInterval(checkpointInterval);
  if (progressInterval) clearInterval(progressInterval);
  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);

  // Final state
  state.stats = computeStats(state.files);
  saveState(state, absOutput);

  // Generate summary
  const summaryPath = writeSummary(absOutput, state);

  // Final output
  const elapsed = formatDuration(Date.now() - startTime);
  console.log("");
  console.log(
    `Done. ${state.stats.completed} files scanned in ${elapsed}.`,
  );
  if (state.stats.failed > 0 || state.stats.timeout > 0) {
    console.log(
      `  ${state.stats.failed} failed, ${state.stats.timeout} timed out.`,
    );
  }
  console.log(`  Summary: ${summaryPath}`);

  removeLockFile(absOutput);

  return state.stats.failed > 0 ? 1 : 0;
}
