// src/progress.ts — terminal progress display (TTY vs non-TTY)
import { ScanStats } from "./types";

export interface ProgressState {
  stats: ScanStats;
  activeFiles: Map<string, { index: number; startedAt: number }>;
  elapsed: number;
}

const isTTY = process.stdout.isTTY ?? false;
let lineCount = 0;

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function renderProgressBar(done: number, total: number, width = 30): string {
  if (total === 0) return "░".repeat(width);
  const filled = Math.round((done / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function formatLogLine(
  event: "START" | "DONE" | "FAIL" | "TIMEOUT" | "SKIP",
  file: string,
  extra?: string,
): string {
  const time = new Date().toTimeString().slice(0, 8);
  const padded = event.padEnd(7);
  return extra
    ? `[${time}] ${padded} ${file} — ${extra}`
    : `[${time}] ${padded} ${file}`;
}

export function printLogLine(
  event: "START" | "DONE" | "FAIL" | "TIMEOUT" | "SKIP",
  file: string,
  extra?: string,
): void {
  console.log(formatLogLine(event, file, extra));
}

export function renderTTYProgress(state: ProgressState): string {
  const { stats, activeFiles, elapsed } = state;
  const done = stats.completed + stats.failed + stats.timeout + stats.skipped;
  const pct = stats.totalFiles > 0 ? ((done / stats.totalFiles) * 100).toFixed(1) : "0.0";

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `  Progress: [${renderProgressBar(done, stats.totalFiles)}] ${done}/${stats.totalFiles} (${pct}%)`,
  );
  lines.push("");

  // Worker status lines
  const maxWorkers = Math.max(activeFiles.size, 1);
  const sortedWorkers = [...activeFiles.entries()].sort(
    ([, a], [, b]) => a.index - b.index,
  );

  for (const [file, { index, startedAt }] of sortedWorkers) {
    const dur = formatDuration(Date.now() - startedAt);
    lines.push(`  Worker ${index + 1}: ● scanning ${file} (${dur})`);
  }

  // Fill idle worker slots up to expected concurrency
  for (let i = sortedWorkers.length; i < maxWorkers; i++) {
    lines.push(`  Worker ${i + 1}: ◌ idle`);
  }

  lines.push("");
  lines.push(
    `  Completed: ${stats.completed} | Failed: ${stats.failed} | Timeout: ${stats.timeout} | Skipped: ${stats.skipped} | Remaining: ${stats.pending}`,
  );
  lines.push(`  Elapsed: ${formatDuration(elapsed)}`);
  lines.push("");

  return lines.join("\n");
}

export function clearLines(count: number): void {
  if (!isTTY) return;
  for (let i = 0; i < count; i++) {
    process.stdout.write("\x1b[A\x1b[2K");
  }
}

export function printTTYProgress(state: ProgressState): void {
  if (!isTTY) return;
  clearLines(lineCount);
  const output = renderTTYProgress(state);
  process.stdout.write(output);
  lineCount = output.split("\n").length;
}

export { isTTY };
