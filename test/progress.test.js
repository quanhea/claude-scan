const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatDuration,
  renderProgressBar,
  formatLogLine,
  renderTTYProgress,
} = require("../dist/progress");

describe("formatDuration", () => {
  it("formats seconds", () => {
    assert.equal(formatDuration(5000), "0m 05s");
    assert.equal(formatDuration(65000), "1m 05s");
    assert.equal(formatDuration(3661000), "61m 01s");
  });

  it("handles zero", () => {
    assert.equal(formatDuration(0), "0m 00s");
  });
});

describe("renderProgressBar", () => {
  it("renders empty bar for 0 progress", () => {
    const bar = renderProgressBar(0, 100, 10);
    assert.equal(bar, "░░░░░░░░░░");
  });

  it("renders full bar for complete", () => {
    const bar = renderProgressBar(100, 100, 10);
    assert.equal(bar, "██████████");
  });

  it("renders partial bar", () => {
    const bar = renderProgressBar(50, 100, 10);
    assert.equal(bar, "█████░░░░░");
  });

  it("handles zero total", () => {
    const bar = renderProgressBar(0, 0, 10);
    assert.equal(bar, "░░░░░░░░░░");
  });
});

describe("formatLogLine", () => {
  it("formats START event", () => {
    const line = formatLogLine("START", "src/app.ts");
    assert.match(line, /\[\d{2}:\d{2}:\d{2}\] START\s+src\/app\.ts/);
  });

  it("formats DONE event with extra", () => {
    const line = formatLogLine("DONE", "src/app.ts", "2 findings (45s)");
    assert.match(line, /DONE\s+src\/app\.ts — 2 findings/);
  });

  it("pads event names to 7 chars", () => {
    const start = formatLogLine("START", "f");
    const done = formatLogLine("DONE", "f");
    // Both should have the event at the same position
    const startIdx = start.indexOf("START");
    const doneIdx = done.indexOf("DONE");
    assert.equal(startIdx, doneIdx);
  });
});

describe("renderTTYProgress", () => {
  it("renders progress state", () => {
    const state = {
      stats: {
        totalFiles: 100,
        completed: 40,
        failed: 2,
        timeout: 1,
        skipped: 0,
        pending: 55,
        running: 2,
      },
      activeFiles: new Map([
        ["src/auth.ts", { index: 0, startedAt: Date.now() - 60000 }],
        ["src/db.ts", { index: 1, startedAt: Date.now() - 30000 }],
      ]),
      elapsed: 300000,
    };

    const output = renderTTYProgress(state);
    assert.ok(output.includes("43/100"));
    assert.ok(output.includes("43.0%"));
    assert.ok(output.includes("Worker 1"));
    assert.ok(output.includes("src/auth.ts"));
    assert.ok(output.includes("Worker 2"));
    assert.ok(output.includes("src/db.ts"));
    assert.ok(output.includes("Completed: 40"));
    assert.ok(output.includes("Failed: 2"));
  });

  it("shows idle workers", () => {
    const state = {
      stats: {
        totalFiles: 10,
        completed: 0,
        failed: 0,
        timeout: 0,
        skipped: 0,
        pending: 9,
        running: 1,
      },
      activeFiles: new Map([
        ["a.ts", { index: 0, startedAt: Date.now() }],
      ]),
      elapsed: 0,
    };

    const output = renderTTYProgress(state);
    assert.ok(output.includes("Worker 1: ●"));
  });
});
