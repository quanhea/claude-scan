// src/scanner.ts — top-level orchestrator
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { ScanOptions, STATUS, DEFAULTS } from "./types";
import { runPreflight, removeLockFile } from "./preflight";
import { discoverFiles } from "./discovery";
import { loadPrompt } from "./prompt";
import {
  initState,
  loadState,
  saveState,
  resetStaleRunning,
  resetFailed,
  mergeNewFiles,
  pruneExcludedFiles,
  updateFileStatus,
  getPendingFiles,
  markForRetry,
  computeStats,
} from "./state";
import { WorkerPool } from "./worker-pool";
import { fileToSlug } from "./worker";
import { writeSummary, summarizeWithClaude, SummarizeResult } from "./reporter";
import {
  isTTY,
  printLogLine,
  printTTYProgress,
  printEventAboveProgress,
  clearProgress,
  formatDuration,
  formatLogLine,
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
    includeTests,
    summarize,
    retry,
    dryRun,
    force,
    verbose,
  } = options;
  let resume = options.resume;

  const absTarget = path.resolve(targetDir);
  const absOutput = path.resolve(outputDir);

  // --summarize: re-generate summary from existing reports, skip scanning
  if (summarize) {
    const existingState = loadState(absOutput);
    if (!existingState) {
      throw new Error("No previous scan found. Run a scan first.");
    }
    const summaryPath = path.join(absOutput, "summary.md");
    try { fs.unlinkSync(summaryPath); } catch {}
    const sumConfig = {
      parallel, timeout, maxRetries, maxTurns, maxFileSizeKB,
      model, prompt: promptFile ?? DEFAULTS.prompt, verbose,
    };
    const modelLabel = model ? ` (${model})` : "";
    process.stdout.write(`Generating AI summary${modelLabel}...`);
    const ticker = setInterval(() => process.stdout.write("."), 3000);
    const result = await summarizeWithClaude({
      outputDir: absOutput, state: existingState, config: sumConfig,
    });
    clearInterval(ticker);
    console.log("");
    printSummarizeResult(result);
    console.log(`  Summary: ${summaryPath}`);
    return 0;
  }

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

  // Check for existing scan — prompt to resume if incomplete
  if (!resume && !dryRun && !summarize && process.stdin.isTTY) {
    const existing = loadState(absOutput);
    if (existing) {
      const done = existing.stats.completed;
      const total = existing.stats.totalFiles;
      const incomplete = total - done;
      if (incomplete > 0) {
        console.log(`Previous scan found: ${done}/${total} completed.`);
        const answer = await askYesNo("Resume previous scan?");
        if (answer) {
          resume = true;
        }
      }
    }
  }

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
    if (retry) {
      const retryCount = resetFailed(state);
      if (retryCount > 0) {
        console.log(`Retry: reset ${retryCount} failed/timed-out files to pending.`);
      }
    }
    // Re-run discovery and merge new files (e.g. --include-tests on second run)
    const freshFiles = discoverFiles(absTarget, { include, exclude, maxFileSizeKB, includeTests });
    const newCount = mergeNewFiles(state, freshFiles);
    if (newCount > 0) {
      console.log(`Found ${newCount} new files to scan.`);
    }
    const prunedCount = pruneExcludedFiles(state, freshFiles);
    if (prunedCount > 0) {
      console.log(`Removed ${prunedCount} files no longer matching filters.`);
    }
    // Apply new config overrides
    state.config = config;
  } else {
    // Discover files
    let files: string[];
    if (preflight.singleFile) {
      files = [path.relative(absTarget, preflight.singleFile) || path.basename(preflight.singleFile)];
    } else {
      files = discoverFiles(absTarget, { include, exclude, maxFileSizeKB, includeTests });
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
        concurrency: parallel,
        reportsDir: path.join(absOutput, "reports"),
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

  // Fatal error detection — halt on auth failures
  let consecutiveAuthErrors = 0;

  // Rate limit auto-pause — wait until reset time, or retry every 15 min
  let rateLimitPaused = false;
  let rateLimitTimer: NodeJS.Timeout | null = null;
  const DEFAULT_RATE_LIMIT_RETRY_MS = 15 * 60 * 1000;
  // +60s penalty ensures we don't probe exactly at the reset boundary
  const PENALTY_MS = 60 * 1000;

  function scheduleRateLimitRetry(retryAfterMs?: number): void {
    const delay = retryAfterMs
      ? retryAfterMs + PENALTY_MS
      : DEFAULT_RATE_LIMIT_RETRY_MS;
    rateLimitTimer = setTimeout(() => {
      rateLimitPaused = false;
      pool.resume();
    }, delay);
  }
  const FATAL_AUTH_THRESHOLD = 3;

  // Wire pool events
  pool.on("start", (file: string, _workerIndex: number) => {
    activeStartTimes.set(file, Date.now());
    updateFileStatus(state, file, STATUS.RUNNING, {
      startedAt: new Date().toISOString(),
      attempts: (state.files[file]?.attempts ?? 0) + 1,
    });
  });

  pool.on("done", (file: string, result: { status: string; durationMs: number; exitCode: number | null; error?: string; retryAfterMs?: number }, _workerIndex: number) => {
    activeStartTimes.delete(file);

    const reportPath = path.join(absOutput, "reports", fileToSlug(file) + ".md");

    if (result.status === STATUS.COMPLETED) {
      consecutiveAuthErrors = 0;
      if (rateLimitPaused) {
        rateLimitPaused = false;
        printEventAboveProgress("Rate limit cleared. Resuming scan.");
      }
      updateFileStatus(state, file, STATUS.COMPLETED, {
        completedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        reportPath,
      });
      printEventAboveProgress(
        formatLogLine("DONE", file, formatDuration(result.durationMs)),
      );
    } else if (result.status === STATUS.TIMEOUT) {
      consecutiveAuthErrors = 0;
      updateFileStatus(state, file, STATUS.TIMEOUT, {
        completedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        lastError: "timeout",
      });
      printEventAboveProgress(
        formatLogLine("TIMEOUT", file, `exceeded ${timeout}s`),
      );
    } else {
      // FAILED
      updateFileStatus(state, file, STATUS.FAILED, {
        completedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        lastError: result.error,
      });
      printEventAboveProgress(
        formatLogLine("FAIL", file, result.error ?? "unknown error"),
      );

      // Detect fatal auth errors — halt the entire scan
      if (result.error === "auth_error") {
        consecutiveAuthErrors++;
        if (consecutiveAuthErrors >= FATAL_AUTH_THRESHOLD) {
          printEventAboveProgress(
            "Error: Claude is not authenticated. Run: claude auth login",
          );
          pool.killAll();
        }
      } else if (result.error === "rate_limit" || result.error === "overloaded") {
        // Requeue the file and pause — auto-resume when limit resets
        pool.requeueFile(file);
        updateFileStatus(state, file, STATUS.PENDING);
        if (!rateLimitPaused) {
          rateLimitPaused = true;
          pool.pause();
          const retryAfterMs = result.retryAfterMs;
          if (retryAfterMs) {
            const resumeAt = new Date(Date.now() + retryAfterMs + 60000);
            printEventAboveProgress(
              `Rate limited. Auto-resume at ${resumeAt.toLocaleTimeString()}.`,
            );
          } else {
            printEventAboveProgress(
              "Rate limited. Will auto-resume when ready.",
            );
          }
          scheduleRateLimitRetry(retryAfterMs);
        }
      } else {
        consecutiveAuthErrors = 0;
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
  if (rateLimitTimer) clearTimeout(rateLimitTimer);
  clearProgress();
  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);

  // Final state
  state.stats = computeStats(state.files);
  saveState(state, absOutput);

  // Generate summary — basic fallback first, then AI-powered
  let summaryPath = writeSummary(absOutput, state);
  if (state.stats.completed > 0) {
    const modelLabel = model ? ` (${model})` : "";
    process.stdout.write(`Generating AI summary${modelLabel}...`);
    const ticker = setInterval(() => process.stdout.write("."), 3000);
    const sumResult = await summarizeWithClaude({
      outputDir: absOutput, state, config,
    });
    clearInterval(ticker);
    console.log("");
    summaryPath = sumResult.summaryPath;
    printSummarizeResult(sumResult);
  }

  // Final output
  const elapsed = formatDuration(Date.now() - startTime);
  console.log(
    `Done. ${state.stats.completed} files scanned in ${elapsed}.`,
  );
  if (state.stats.failed > 0 || state.stats.timeout > 0) {
    console.log(
      `  ${state.stats.failed} failed, ${state.stats.timeout} timed out.`,
    );
  }
  console.log(`  Summary: ${summaryPath}`);

  // Completed files list
  const completedFiles = Object.entries(state.files)
    .filter(([, e]) => e.status === STATUS.COMPLETED)
    .sort(([, a], [, b]) => (a.durationMs ?? 0) - (b.durationMs ?? 0));

  if (completedFiles.length > 0) {
    console.log("");
    console.log(`  Completed (${completedFiles.length}):`);
    const SHOW_MAX = 10;
    for (const [f, e] of completedFiles.slice(0, SHOW_MAX)) {
      const dur = e.durationMs ? formatDuration(e.durationMs) : "";
      console.log(`    ${f} (${dur})`);
    }
    if (completedFiles.length > SHOW_MAX) {
      console.log(`    ... +${completedFiles.length - SHOW_MAX} more (see summary.md)`);
    }
  }

  // Exit hints
  if (state.stats.pending > 0) {
    console.log("");
    console.log(`  ${state.stats.pending} files still pending.`);
    console.log("  To continue:  claude-scan --resume");
  }
  const failedCount = state.stats.failed + state.stats.timeout;
  if (failedCount > 0) {
    console.log("");
    console.log(`  ${failedCount} files failed or timed out.`);
    console.log("  To retry:     claude-scan --resume --retry");
  }

  removeLockFile(absOutput);

  return state.stats.failed > 0 ? 1 : 0;
}

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function printSummarizeResult(result: SummarizeResult): void {
  const elapsed = formatDuration(result.durationMs);
  const costStr = result.cost !== undefined ? ` | cost: $${result.cost.toFixed(4)}` : "";
  if (result.success) {
    console.log(`  Done in ${elapsed}${costStr}`);
  } else {
    console.log(`  Failed after ${elapsed}: ${result.error ?? "unknown"}`);
    console.log("  Using basic fallback summary.");
    console.log(`  Debug log: ${path.join(path.dirname(result.summaryPath), "logs", "summary.log")}`);
  }
}
