const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  initState,
  computeStats,
  saveState,
  loadState,
  resetStaleRunning,
  resetFailed,
  mergeNewFiles,
  updateFileStatus,
  getPendingFiles,
  markForRetry,
} = require("../dist/state");

const testConfig = {
  parallel: 4,
  timeout: 300,
  maxRetries: 2,
  maxTurns: 30,
  maxFileSizeKB: 100,
  model: null,
  prompt: "scan.md",
  verbose: false,
};

describe("initState", () => {
  it("creates state with all files PENDING", () => {
    const state = initState("/tmp/project", ["a.ts", "b.ts", "c.ts"], testConfig);
    assert.equal(state.version, 1);
    assert.equal(state.targetDir, "/tmp/project");
    assert.ok(state.scanId);
    assert.ok(state.startedAt);
    assert.equal(Object.keys(state.files).length, 3);
    assert.equal(state.files["a.ts"].status, "PENDING");
    assert.equal(state.files["a.ts"].attempts, 0);
    assert.equal(state.stats.totalFiles, 3);
    assert.equal(state.stats.pending, 3);
  });
});

describe("computeStats", () => {
  it("counts each status correctly", () => {
    const files = {
      "a.ts": { status: "COMPLETED", attempts: 1 },
      "b.ts": { status: "COMPLETED", attempts: 1 },
      "c.ts": { status: "FAILED", attempts: 2 },
      "d.ts": { status: "TIMEOUT", attempts: 1 },
      "e.ts": { status: "SKIPPED", attempts: 3 },
      "f.ts": { status: "PENDING", attempts: 0 },
      "g.ts": { status: "RUNNING", attempts: 1 },
      "h.ts": { status: "INTERRUPTED", attempts: 1 },
    };
    const stats = computeStats(files);
    assert.equal(stats.totalFiles, 8);
    assert.equal(stats.completed, 2);
    assert.equal(stats.failed, 1);
    assert.equal(stats.timeout, 1);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.pending, 2); // PENDING + INTERRUPTED
    assert.equal(stats.running, 1);
  });
});

describe("saveState / loadState round-trip", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-scan-state-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads state identically", () => {
    const state = initState("/tmp/project", ["x.ts", "y.ts"], testConfig);
    state.files["x.ts"].status = "COMPLETED";
    state.files["x.ts"].attempts = 1;
    state.files["x.ts"].durationMs = 5000;

    saveState(state, tmpDir);

    const loaded = loadState(tmpDir);
    assert.ok(loaded);
    assert.equal(loaded.scanId, state.scanId);
    assert.equal(loaded.files["x.ts"].status, "COMPLETED");
    assert.equal(loaded.files["x.ts"].durationMs, 5000);
    assert.equal(loaded.files["y.ts"].status, "PENDING");
    assert.equal(loaded.stats.completed, 1);
    assert.equal(loaded.stats.pending, 1);
  });

  it("atomic write does not corrupt on valid write", () => {
    const state = initState("/tmp/project", ["a.ts"], testConfig);
    saveState(state, tmpDir);

    // Verify no .tmp file left behind
    const tmpFile = path.join(tmpDir, "state.json.tmp");
    assert.ok(!fs.existsSync(tmpFile));

    // Verify state.json is valid JSON
    const raw = fs.readFileSync(path.join(tmpDir, "state.json"), "utf-8");
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  it("returns null when no state file exists", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-"));
    const loaded = loadState(emptyDir);
    assert.equal(loaded, null);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe("resetStaleRunning", () => {
  it("resets RUNNING and INTERRUPTED to PENDING", () => {
    const state = initState("/tmp/p", ["a.ts", "b.ts", "c.ts", "d.ts"], testConfig);
    state.files["a.ts"].status = "RUNNING";
    state.files["b.ts"].status = "INTERRUPTED";
    state.files["c.ts"].status = "COMPLETED";
    state.files["d.ts"].status = "PENDING";

    const count = resetStaleRunning(state);
    assert.equal(count, 2);
    assert.equal(state.files["a.ts"].status, "PENDING");
    assert.equal(state.files["b.ts"].status, "PENDING");
    assert.equal(state.files["c.ts"].status, "COMPLETED");
    assert.equal(state.stats.pending, 3);
    assert.equal(state.stats.completed, 1);
  });
});

describe("resetFailed", () => {
  it("resets FAILED, TIMEOUT, and SKIPPED to PENDING with attempts=0", () => {
    const state = initState("/tmp/p", ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], testConfig);
    state.files["a.ts"].status = "FAILED";
    state.files["a.ts"].attempts = 2;
    state.files["b.ts"].status = "TIMEOUT";
    state.files["b.ts"].attempts = 1;
    state.files["c.ts"].status = "SKIPPED";
    state.files["c.ts"].attempts = 3;
    state.files["d.ts"].status = "COMPLETED";
    state.files["e.ts"].status = "PENDING";

    const count = resetFailed(state);
    assert.equal(count, 3);
    assert.equal(state.files["a.ts"].status, "PENDING");
    assert.equal(state.files["a.ts"].attempts, 0);
    assert.equal(state.files["b.ts"].status, "PENDING");
    assert.equal(state.files["b.ts"].attempts, 0);
    assert.equal(state.files["c.ts"].status, "PENDING");
    assert.equal(state.files["c.ts"].attempts, 0);
    assert.equal(state.files["d.ts"].status, "COMPLETED");
    assert.equal(state.files["e.ts"].status, "PENDING");
    assert.equal(state.stats.pending, 4);
    assert.equal(state.stats.completed, 1);
  });

  it("returns 0 when no failed files", () => {
    const state = initState("/tmp/p", ["a.ts"], testConfig);
    state.files["a.ts"].status = "COMPLETED";
    const count = resetFailed(state);
    assert.equal(count, 0);
  });
});

describe("mergeNewFiles", () => {
  it("adds new files as PENDING without touching existing", () => {
    const state = initState("/tmp/p", ["a.ts", "b.ts"], testConfig);
    state.files["a.ts"].status = "COMPLETED";
    state.files["a.ts"].attempts = 1;

    const count = mergeNewFiles(state, ["a.ts", "b.ts", "c.ts", "d.ts"]);
    assert.equal(count, 2); // c.ts and d.ts are new
    assert.equal(state.files["a.ts"].status, "COMPLETED"); // untouched
    assert.equal(state.files["a.ts"].attempts, 1);
    assert.equal(state.files["c.ts"].status, "PENDING");
    assert.equal(state.files["c.ts"].attempts, 0);
    assert.equal(state.files["d.ts"].status, "PENDING");
    assert.equal(state.stats.totalFiles, 4);
  });

  it("returns 0 when no new files", () => {
    const state = initState("/tmp/p", ["a.ts"], testConfig);
    const count = mergeNewFiles(state, ["a.ts"]);
    assert.equal(count, 0);
  });
});

describe("updateFileStatus", () => {
  it("updates status and extra fields", () => {
    const state = initState("/tmp/p", ["a.ts"], testConfig);
    updateFileStatus(state, "a.ts", "RUNNING", {
      startedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(state.files["a.ts"].status, "RUNNING");
    assert.equal(state.files["a.ts"].startedAt, "2026-01-01T00:00:00Z");
    assert.equal(state.stats.running, 1);
  });

  it("ignores unknown file paths", () => {
    const state = initState("/tmp/p", ["a.ts"], testConfig);
    assert.doesNotThrow(() => updateFileStatus(state, "nope.ts", "FAILED"));
  });
});

describe("getPendingFiles", () => {
  it("returns only PENDING files", () => {
    const state = initState("/tmp/p", ["a.ts", "b.ts", "c.ts"], testConfig);
    state.files["b.ts"].status = "COMPLETED";
    const pending = getPendingFiles(state);
    assert.deepEqual(pending, ["a.ts", "c.ts"]);
  });
});

describe("markForRetry", () => {
  it("resets to PENDING when attempts < maxRetries", () => {
    const state = initState("/tmp/p", ["a.ts"], testConfig);
    state.files["a.ts"].status = "FAILED";
    state.files["a.ts"].attempts = 1;
    markForRetry(state, "a.ts", 2);
    assert.equal(state.files["a.ts"].status, "PENDING");
  });

  it("marks SKIPPED when attempts >= maxRetries", () => {
    const state = initState("/tmp/p", ["a.ts"], testConfig);
    state.files["a.ts"].status = "FAILED";
    state.files["a.ts"].attempts = 2;
    markForRetry(state, "a.ts", 2);
    assert.equal(state.files["a.ts"].status, "SKIPPED");
  });
});
