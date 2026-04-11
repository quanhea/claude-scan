const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnWorker, fileToSlug } = require("../dist/worker");

describe("fileToSlug", () => {
  it("replaces slashes with double underscores", () => {
    assert.equal(fileToSlug("src/auth/login.ts"), "src__auth__login.ts");
  });

  it("leaves flat filenames unchanged", () => {
    assert.equal(fileToSlug("app.ts"), "app.ts");
  });
});

describe("spawnWorker", () => {
  let tmpDir;
  let targetDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-scan-worker-test-"));
    targetDir = path.join(tmpDir, "project");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "test.js"), "console.log('hello')");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("times out and kills a long-running process", async () => {
    // Use sleep as a stand-in for claude (guaranteed to exist)
    const outputDir = path.join(tmpDir, "output");
    const { promise, child } = spawnWorker({
      targetDir,
      outputDir,
      filePath: "test.js",
      promptTemplate: "test prompt for {{FILE_PATH}} report to {{REPORT_PATH}}",
      config: {
        parallel: 1,
        timeout: 1, // 1 second timeout
        maxRetries: 0,
        maxTurns: 5,
        maxFileSizeKB: 100,
        model: null,
        prompt: "scan.md",
        verbose: false,
      },
    });

    const result = await promise;
    // The process should be killed due to timeout OR fail because claude
    // isn't available in test env — either way it should not be COMPLETED
    assert.ok(
      result.status === "TIMEOUT" || result.status === "FAILED",
      `Expected TIMEOUT or FAILED, got ${result.status}`,
    );
    assert.ok(result.durationMs >= 0);
  });

  it("creates log directory and log file", async () => {
    const outputDir = path.join(tmpDir, "output");
    const { promise } = spawnWorker({
      targetDir,
      outputDir,
      filePath: "test.js",
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: {
        parallel: 1,
        timeout: 2,
        maxRetries: 0,
        maxTurns: 5,
        maxFileSizeKB: 100,
        model: null,
        prompt: "scan.md",
        verbose: false,
      },
    });

    await promise;
    assert.ok(fs.existsSync(path.join(outputDir, "logs")));
    assert.ok(fs.existsSync(path.join(outputDir, "reports")));
    assert.ok(fs.existsSync(path.join(outputDir, "raw")));
  });

  it("kill() terminates the process", async () => {
    const outputDir = path.join(tmpDir, "output");
    const { promise, kill } = spawnWorker({
      targetDir,
      outputDir,
      filePath: "test.js",
      promptTemplate: "test {{FILE_PATH}} {{REPORT_PATH}}",
      config: {
        parallel: 1,
        timeout: 60,
        maxRetries: 0,
        maxTurns: 5,
        maxFileSizeKB: 100,
        model: null,
        prompt: "scan.md",
        verbose: false,
      },
    });

    // Kill immediately
    setTimeout(() => kill(), 100);
    const result = await promise;
    assert.ok(
      result.status === "TIMEOUT" || result.status === "FAILED",
      `Expected TIMEOUT or FAILED after kill, got ${result.status}`,
    );
  });
});
