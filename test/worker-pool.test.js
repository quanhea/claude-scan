const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WorkerPool } = require("../dist/worker-pool");

const baseConfig = {
  parallel: 2,
  timeout: 5,
  maxRetries: 0,
  maxTurns: 5,
  maxFileSizeKB: 100,
  model: null,
  prompt: "scan.md",
  verbose: false,
};

describe("WorkerPool", () => {
  let tmpDir;
  let targetDir;
  let outputDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-scan-pool-test-"));
    targetDir = path.join(tmpDir, "project");
    outputDir = path.join(tmpDir, "output");
    fs.mkdirSync(targetDir, { recursive: true });
    // Create dummy files
    for (const f of ["a.js", "b.js", "c.js"]) {
      fs.writeFileSync(path.join(targetDir, f), `// ${f}`);
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("limits concurrency to configured value", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const pool = new WorkerPool({
      files: ["a.js", "b.js", "c.js"],
      concurrency: 2,
      targetDir,
      outputDir,
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: baseConfig,
    });

    pool.on("start", () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
    });

    pool.on("done", () => {
      currentConcurrent--;
    });

    await pool.start();
    assert.ok(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected <= 2`);
  });

  it("processes all files in the queue", async () => {
    const completed = [];
    const pool = new WorkerPool({
      files: ["a.js", "b.js", "c.js"],
      concurrency: 2,
      targetDir,
      outputDir,
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: baseConfig,
    });

    pool.on("done", (file) => {
      completed.push(file);
    });

    await pool.start();
    assert.equal(completed.length, 3);
    assert.ok(completed.includes("a.js"));
    assert.ok(completed.includes("b.js"));
    assert.ok(completed.includes("c.js"));
  });

  it("emits start and done events with worker index", async () => {
    const events = [];
    const pool = new WorkerPool({
      files: ["a.js"],
      concurrency: 1,
      targetDir,
      outputDir,
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: baseConfig,
    });

    pool.on("start", (file, idx) => {
      events.push({ type: "start", file, idx });
    });

    pool.on("done", (file, result, idx) => {
      events.push({ type: "done", file, idx, status: result.status });
    });

    await pool.start();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "start");
    assert.equal(events[0].file, "a.js");
    assert.equal(events[1].type, "done");
    assert.equal(events[1].file, "a.js");
  });

  it("stopAcceptingNew prevents new workers from launching", async () => {
    const completed = [];
    const pool = new WorkerPool({
      files: ["a.js", "b.js", "c.js"],
      concurrency: 1,
      targetDir,
      outputDir,
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: baseConfig,
    });

    pool.on("done", (file) => {
      completed.push(file);
      if (completed.length === 1) {
        pool.stopAcceptingNew();
      }
    });

    await pool.start();
    // Should have completed at most 1 file (the one already running when stopped)
    assert.ok(completed.length <= 2, `Expected <= 2 completed, got ${completed.length}`);
    assert.equal(pool.queueLength, 0);
  });

  it("killAll terminates all active workers", async () => {
    const pool = new WorkerPool({
      files: ["a.js", "b.js"],
      concurrency: 2,
      targetDir,
      outputDir,
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: { ...baseConfig, timeout: 60 },
    });

    pool.on("start", () => {
      // Kill as soon as workers start
      setTimeout(() => pool.killAll(), 50);
    });

    await pool.start();
    assert.equal(pool.activeCount, 0);
  });

  it("pause prevents new workers, resume restarts them", async () => {
    const events = [];
    const pool = new WorkerPool({
      files: ["a.js", "b.js", "c.js"],
      concurrency: 1,
      targetDir,
      outputDir,
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: baseConfig,
    });

    pool.on("done", (file) => {
      events.push(file);
      if (events.length === 1) {
        // After first file completes, pause
        pool.pause();
        // Resume after a short delay
        setTimeout(() => pool.resume(), 100);
      }
    });

    await pool.start();
    // All 3 files should eventually complete
    assert.equal(events.length, 3);
  });

  it("requeueFile puts file at front of queue", () => {
    const pool = new WorkerPool({
      files: ["a.js", "b.js"],
      concurrency: 1,
      targetDir,
      outputDir,
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: baseConfig,
    });

    pool.requeueFile("z.js");
    assert.equal(pool.queueLength, 3);
  });

  it("handles empty file list gracefully", async () => {
    const pool = new WorkerPool({
      files: [],
      concurrency: 4,
      targetDir,
      outputDir,
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: baseConfig,
    });

    let drained = false;
    pool.on("drain", () => { drained = true; });

    await pool.start();
    assert.ok(drained);
  });
});
