// src/state.ts — scan state persistence, atomic writes, resume logic
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  STATUS,
  STATE_VERSION,
  FileStatus,
  FileEntry,
  ScanState,
  ScanStats,
  ScanConfig,
} from "./types";

export function initState(
  targetDir: string,
  files: string[],
  config: ScanConfig,
): ScanState {
  const fileEntries: Record<string, FileEntry> = {};
  for (const f of files) {
    fileEntries[f] = { status: STATUS.PENDING, attempts: 0 };
  }
  return {
    version: STATE_VERSION,
    scanId: crypto.randomBytes(4).toString("hex"),
    targetDir: path.resolve(targetDir),
    startedAt: new Date().toISOString(),
    config,
    stats: computeStats(fileEntries),
    files: fileEntries,
  };
}

export function computeStats(files: Record<string, FileEntry>): ScanStats {
  const stats: ScanStats = {
    totalFiles: 0,
    completed: 0,
    failed: 0,
    timeout: 0,
    skipped: 0,
    pending: 0,
    running: 0,
  };
  for (const entry of Object.values(files)) {
    stats.totalFiles++;
    switch (entry.status) {
      case STATUS.COMPLETED:
        stats.completed++;
        break;
      case STATUS.FAILED:
        stats.failed++;
        break;
      case STATUS.TIMEOUT:
        stats.timeout++;
        break;
      case STATUS.SKIPPED:
        stats.skipped++;
        break;
      case STATUS.RUNNING:
        stats.running++;
        break;
      case STATUS.PENDING:
      case STATUS.INTERRUPTED:
        stats.pending++;
        break;
    }
  }
  return stats;
}

export function saveState(state: ScanState, outputDir: string): void {
  state.stats = computeStats(state.files);
  const statePath = path.join(outputDir, "state.json");
  const tmpPath = statePath + ".tmp";
  const data = JSON.stringify(state, null, 2);

  const fd = fs.openSync(tmpPath, "w");
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  fs.renameSync(tmpPath, statePath);
}

export function loadState(outputDir: string): ScanState | null {
  const statePath = path.join(outputDir, "state.json");
  if (!fs.existsSync(statePath)) return null;

  const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  if (raw.version > STATE_VERSION) {
    throw new Error(
      `State file is from a newer version (v${raw.version}). Update claude-scan.`,
    );
  }
  return raw as ScanState;
}

export function resetStaleRunning(state: ScanState): number {
  let count = 0;
  for (const entry of Object.values(state.files)) {
    if (
      entry.status === STATUS.RUNNING ||
      entry.status === STATUS.INTERRUPTED
    ) {
      entry.status = STATUS.PENDING;
      count++;
    }
  }
  state.stats = computeStats(state.files);
  return count;
}

export function resetFailed(state: ScanState): number {
  let count = 0;
  for (const entry of Object.values(state.files)) {
    if (
      entry.status === STATUS.FAILED ||
      entry.status === STATUS.TIMEOUT ||
      entry.status === STATUS.SKIPPED
    ) {
      entry.status = STATUS.PENDING;
      entry.attempts = 0;
      count++;
    }
  }
  state.stats = computeStats(state.files);
  return count;
}

export function mergeNewFiles(state: ScanState, files: string[]): number {
  let count = 0;
  for (const f of files) {
    if (!state.files[f]) {
      state.files[f] = { status: STATUS.PENDING, attempts: 0 };
      count++;
    }
  }
  state.stats = computeStats(state.files);
  return count;
}

export function updateFileStatus(
  state: ScanState,
  filePath: string,
  status: FileStatus,
  extra: Partial<FileEntry> = {},
): void {
  const entry = state.files[filePath];
  if (!entry) return;
  entry.status = status;
  Object.assign(entry, extra);
  state.stats = computeStats(state.files);
}

export function getPendingFiles(state: ScanState): string[] {
  return Object.entries(state.files)
    .filter(([, e]) => e.status === STATUS.PENDING)
    .map(([f]) => f);
}

export function shouldRetry(
  state: ScanState,
  filePath: string,
  maxRetries: number,
): boolean {
  const entry = state.files[filePath];
  if (!entry) return false;
  return entry.attempts < maxRetries;
}

export function markForRetry(
  state: ScanState,
  filePath: string,
  maxRetries: number,
): void {
  const entry = state.files[filePath];
  if (!entry) return;
  if (entry.attempts < maxRetries) {
    entry.status = STATUS.PENDING;
  } else {
    entry.status = STATUS.SKIPPED;
  }
  state.stats = computeStats(state.files);
}
