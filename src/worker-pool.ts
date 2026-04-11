// src/worker-pool.ts — manages N concurrent claude child processes
import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import { spawnWorker, SpawnOptions } from "./worker";
import { WorkerResult, ScanConfig } from "./types";

export interface PoolEvents {
  start: (file: string, workerIndex: number) => void;
  done: (file: string, result: WorkerResult, workerIndex: number) => void;
  drain: () => void;
}

export class WorkerPool extends EventEmitter {
  private queue: string[];
  private active: Map<string, { child: ChildProcess; kill: () => void; index: number }> =
    new Map();
  private concurrency: number;
  private originalConcurrency: number;
  private targetDir: string;
  private outputDir: string;
  private promptTemplate: string;
  private config: ScanConfig;
  private stopped = false;
  private drainResolve: (() => void) | null = null;
  private consecutiveSuccesses = 0;

  constructor(options: {
    files: string[];
    concurrency: number;
    targetDir: string;
    outputDir: string;
    promptTemplate: string;
    config: ScanConfig;
  }) {
    super();
    this.queue = [...options.files];
    this.concurrency = Math.min(options.concurrency, options.files.length);
    this.originalConcurrency = this.concurrency;
    this.targetDir = options.targetDir;
    this.outputDir = options.outputDir;
    this.promptTemplate = options.promptTemplate;
    this.config = options.config;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  getActiveFiles(): Map<string, number> {
    const result = new Map<string, number>();
    for (const [file, { index }] of this.active) {
      result.set(file, index);
    }
    return result;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.drainResolve = resolve;
      this.fillWorkers();
    });
  }

  stopAcceptingNew(): void {
    this.stopped = true;
    this.queue = [];
  }

  killAll(): void {
    this.stopped = true;
    this.queue = [];
    for (const [, { kill }] of this.active) {
      kill();
    }
  }

  private fillWorkers(): void {
    while (
      !this.stopped &&
      this.active.size < this.concurrency &&
      this.queue.length > 0
    ) {
      const file = this.queue.shift()!;
      this.launchWorker(file);
    }

    // Check if we're done
    if (this.active.size === 0 && this.queue.length === 0 && this.drainResolve) {
      this.emit("drain");
      this.drainResolve();
      this.drainResolve = null;
    }
  }

  private launchWorker(file: string): void {
    const workerIndex = this.findFreeIndex();

    this.emit("start", file, workerIndex);

    const spawnOpts: SpawnOptions = {
      targetDir: this.targetDir,
      outputDir: this.outputDir,
      filePath: file,
      promptTemplate: this.promptTemplate,
      config: this.config,
    };

    const { child, promise, kill } = spawnWorker(spawnOpts);
    this.active.set(file, { child, kill, index: workerIndex });

    promise.then((result) => {
      this.active.delete(file);
      this.emit("done", file, result, workerIndex);

      // Adaptive concurrency on rate limit
      if (result.error === "rate_limit" || result.error === "overloaded") {
        this.consecutiveSuccesses = 0;
        if (this.concurrency > 1) {
          this.concurrency--;
        }
      } else if (result.status === "COMPLETED") {
        this.consecutiveSuccesses++;
        if (
          this.consecutiveSuccesses >= 5 &&
          this.concurrency < this.originalConcurrency
        ) {
          this.concurrency++;
          this.consecutiveSuccesses = 0;
        }
      }

      // Fill slots with more work
      this.fillWorkers();
    });
  }

  private findFreeIndex(): number {
    const used = new Set<number>();
    for (const [, { index }] of this.active) {
      used.add(index);
    }
    for (let i = 0; ; i++) {
      if (!used.has(i)) return i;
    }
  }
}
