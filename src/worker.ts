// src/worker.ts — spawn claude -p processes
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { WorkerResult, STATUS, ScanConfig } from "./types";
import { renderPrompt } from "./prompt";

// --- Shared claude spawner (used by both per-file scan and summary) ---

export interface ClaudeSpawnOptions {
  prompt: string;
  cwd: string;
  logPath: string;
  rawPath: string;
  config: ScanConfig;
}

export interface ClaudeSpawnResult {
  exitCode: number | null;
  durationMs: number;
  killed: boolean;
  isError: boolean;
  error?: string;
  result?: string;
  cost?: number;
}

export function spawnClaude(options: ClaudeSpawnOptions): {
  child: ChildProcess;
  promise: Promise<ClaudeSpawnResult>;
  kill: () => void;
} {
  const { prompt, cwd, logPath, rawPath, config } = options;

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });

  const args: string[] = [
    "--dangerously-skip-permissions",
    "-p",
    prompt,
    "--max-turns",
    String(config.maxTurns),
    "--output-format",
    "json",
    "--no-session-persistence",
  ];

  if (config.model) args.push("--model", config.model);
  if (config.verbose) args.push("--verbose");

  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  const child = spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let killed = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let hangTimer: NodeJS.Timeout | null = null;
  let lastActivity = Date.now();
  let lastStdoutChunk = "";

  if (child.stdout) {
    child.stdout.on("data", (data: Buffer) => {
      lastActivity = Date.now();
      lastStdoutChunk = data.toString();
    });
    child.stdout.pipe(logStream);
  }
  if (child.stderr) {
    child.stderr.on("data", () => { lastActivity = Date.now(); });
    child.stderr.pipe(logStream);
  }

  const kill = () => {
    if (killed) return;
    killed = true;
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
  };

  if (config.timeout > 0) {
    timeoutTimer = setTimeout(() => { if (!killed) kill(); }, config.timeout * 1000);
  }

  // Hang detection only with --verbose (json mode has no output until done)
  if (config.verbose) {
    const HANG_CHECK_INTERVAL = 30_000;
    const HANG_THRESHOLD = 120_000;
    hangTimer = setInterval(() => {
      if (Date.now() - lastActivity > HANG_THRESHOLD && !killed) kill();
    }, HANG_CHECK_INTERVAL);
  }

  const startTime = Date.now();

  const promise = new Promise<ClaudeSpawnResult>((resolve) => {
    child.on("exit", (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (hangTimer) clearInterval(hangTimer);
      logStream.end();

      const durationMs = Date.now() - startTime;
      const exitCode = code ?? (signal ? 128 + (signalNumber(signal) || 0) : 1);

      // Parse JSON response
      let isError = false;
      let claudeResult: string | undefined;
      let cost: number | undefined;

      try {
        const raw = lastStdoutChunk.trim() ||
          (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8").trim() : "");
        if (raw) {
          const parsed = JSON.parse(raw);
          fs.writeFileSync(rawPath, JSON.stringify(parsed, null, 2));
          isError = parsed.is_error === true;
          claudeResult = parsed.result;
          cost = parsed.total_cost_usd;
        }
      } catch {}

      // Classify error
      let error: string | undefined;
      if (killed || exitCode !== 0 || isError) {
        const msg = claudeResult || "";
        if (msg.includes("Not logged in") || msg.includes("/login")) {
          error = "auth_error";
        } else if (msg.includes("rate_limit") || msg.includes("429")) {
          error = "rate_limit";
        } else if (msg.includes("overloaded") || msg.includes("529")) {
          error = "overloaded";
        } else {
          error = msg || `exit_code_${exitCode}`;
        }
      }

      resolve({ exitCode, durationMs, killed, isError, error, result: claudeResult, cost });
    });

    child.on("error", (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (hangTimer) clearInterval(hangTimer);
      logStream.end();
      resolve({
        exitCode: null,
        durationMs: Date.now() - startTime,
        killed: false,
        isError: true,
        error: err.message.includes("ENOENT") ? "claude_not_found" : err.message,
      });
    });
  });

  return { child, promise, kill };
}

// --- Per-file scan worker (thin wrapper) ---

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

  fs.mkdirSync(path.join(outputDir, "reports"), { recursive: true });

  const reportPath = path.join(outputDir, "reports", slug + ".md");
  const logPath = path.join(outputDir, "logs", slug + ".log");
  const rawPath = path.join(outputDir, "raw", slug + ".json");

  const prompt = renderPrompt(promptTemplate, {
    FILE_PATH: path.join(targetDir, filePath),
    REPORT_PATH: reportPath,
  });

  const { child, promise: claudePromise, kill } = spawnClaude({
    prompt, cwd: targetDir, logPath, rawPath, config,
  });

  const promise = claudePromise.then((r): WorkerResult => {
    let status: string = STATUS.COMPLETED;
    if (r.killed) status = STATUS.TIMEOUT;
    else if (r.exitCode !== 0 || r.isError) status = STATUS.FAILED;

    return {
      file: filePath,
      status: status as WorkerResult["status"],
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      error: r.error,
    };
  });

  return { child, promise, kill };
}

function signalNumber(signal: string): number | undefined {
  const signals: Record<string, number> = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2 };
  return signals[signal];
}
