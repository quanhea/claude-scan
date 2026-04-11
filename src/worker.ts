// src/worker.ts — spawn a single claude -p process for one file
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { WorkerResult, STATUS, ScanConfig } from "./types";
import { renderPrompt } from "./prompt";

export interface SpawnOptions {
  targetDir: string;
  outputDir: string;
  filePath: string;
  promptTemplate: string;
  config: ScanConfig;
}

export function fileToSlug(filePath: string): string {
  return filePath.replace(/\//g, "__");
}

export function spawnWorker(options: SpawnOptions): {
  child: ChildProcess;
  promise: Promise<WorkerResult>;
  kill: () => void;
} {
  const { targetDir, outputDir, filePath, promptTemplate, config } = options;

  const slug = fileToSlug(filePath);
  const reportDir = path.join(outputDir, "reports");
  const logDir = path.join(outputDir, "logs");
  const rawDir = path.join(outputDir, "raw");

  fs.mkdirSync(reportDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });

  const reportPath = path.join(reportDir, slug + ".md");
  const logPath = path.join(logDir, slug + ".log");

  // Build the prompt with the exact Carlini scaffold template
  const absFilePath = path.join(targetDir, filePath);
  const prompt = renderPrompt(promptTemplate, absFilePath, reportPath);

  // Build claude args
  const args: string[] = [
    "--dangerously-skip-permissions",
    "--bare",
    "-p",
    prompt,
    "--max-turns",
    String(config.maxTurns),
    "--output-format",
    "json",
    "--no-session-persistence",
  ];

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.verbose) {
    args.push("--verbose");
  }

  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  const child = spawn("claude", args, {
    cwd: targetDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let killed = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let hangTimer: NodeJS.Timeout | null = null;
  let lastActivity = Date.now();

  // Stream output to log file — never buffer in memory
  if (child.stdout) {
    child.stdout.on("data", () => {
      lastActivity = Date.now();
    });
    child.stdout.pipe(logStream);
  }
  if (child.stderr) {
    child.stderr.on("data", () => {
      lastActivity = Date.now();
    });
    child.stderr.pipe(logStream);
  }

  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
    // Force kill after 5 seconds if still alive
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, 5000);
  };

  // Timeout timer
  if (config.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      if (!killed) kill();
    }, config.timeout * 1000);
  }

  // Hang detection: no output for 2 minutes
  const HANG_CHECK_INTERVAL = 30_000;
  const HANG_THRESHOLD = 120_000;
  hangTimer = setInterval(() => {
    if (Date.now() - lastActivity > HANG_THRESHOLD && !killed) {
      kill();
    }
  }, HANG_CHECK_INTERVAL);

  const startTime = Date.now();

  const promise = new Promise<WorkerResult>((resolve) => {
    child.on("exit", (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (hangTimer) clearInterval(hangTimer);
      logStream.end();

      const durationMs = Date.now() - startTime;
      const exitCode = code ?? (signal ? 128 + (signalNumber(signal) || 0) : 1);

      // Determine status
      let status: string = STATUS.COMPLETED;
      if (killed) {
        status = STATUS.TIMEOUT;
      } else if (exitCode !== 0) {
        status = STATUS.FAILED;
      }

      // Try to save raw JSON output
      try {
        if (fs.existsSync(logPath)) {
          const logContent = fs.readFileSync(logPath, "utf-8");
          // If output-format is json, the log contains json
          try {
            JSON.parse(logContent);
            fs.copyFileSync(logPath, path.join(rawDir, slug + ".json"));
          } catch {
            // Not valid JSON, that's fine
          }
        }
      } catch {
        // Non-critical
      }

      // Try to detect error type from log
      let error: string | undefined;
      if (status === STATUS.FAILED) {
        try {
          const log = fs.readFileSync(logPath, "utf-8").slice(-1000);
          if (log.includes("rate_limit") || log.includes("429")) {
            error = "rate_limit";
          } else if (log.includes("401") || log.includes("auth")) {
            error = "auth_error";
          } else if (log.includes("overloaded") || log.includes("529")) {
            error = "overloaded";
          } else {
            error = `exit_code_${exitCode}`;
          }
        } catch {
          error = `exit_code_${exitCode}`;
        }
      }

      resolve({
        file: filePath,
        status: status as WorkerResult["status"],
        exitCode,
        durationMs,
        error,
      });
    });

    child.on("error", (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (hangTimer) clearInterval(hangTimer);
      logStream.end();

      resolve({
        file: filePath,
        status: STATUS.FAILED,
        exitCode: null,
        durationMs: Date.now() - startTime,
        error: err.message.includes("ENOENT")
          ? "claude_not_found"
          : err.message,
      });
    });
  });

  return { child, promise, kill };
}

function signalNumber(signal: string): number | undefined {
  const signals: Record<string, number> = {
    SIGTERM: 15,
    SIGKILL: 9,
    SIGINT: 2,
  };
  return signals[signal];
}
