const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const MOCK_CLAUDE = path.join(__dirname, "fixtures", "mock-claude");
const FIXTURES = path.join(__dirname, "fixtures", "sample-project");

describe("integration", () => {
  let tmpDir;
  let outputDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-scan-integration-"));
    outputDir = path.join(tmpDir, "scan-output");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scans a project with mock claude and produces reports", () => {
    // Run with mock claude on PATH
    const env = {
      ...process.env,
      PATH: MOCK_CLAUDE + ":" + process.env.PATH,
    };

    const result = execFileSync(
      "node",
      [
        CLI,
        FIXTURES,
        "--output", outputDir,
        "--parallel", "2",
        "--timeout", "10",
        "--max-turns", "5",
      ],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    // Should complete successfully
    assert.ok(result.includes("Done."));
    assert.ok(result.includes("files scanned"));

    // State file should exist
    const statePath = path.join(outputDir, "state.json");
    assert.ok(fs.existsSync(statePath));
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.ok(state.stats.completed > 0);

    // Summary should exist
    const summaryPath = path.join(outputDir, "summary.md");
    assert.ok(fs.existsSync(summaryPath));
    const summary = fs.readFileSync(summaryPath, "utf-8");
    assert.ok(summary.length > 0, "summary.md should have content");

    // Reports dir should have files
    const reportsDir = path.join(outputDir, "reports");
    assert.ok(fs.existsSync(reportsDir));
    const reportFiles = fs.readdirSync(reportsDir);
    assert.ok(reportFiles.length > 0);

    // At least one report should have content
    const hasContent = reportFiles.some((f) => {
      const content = fs.readFileSync(path.join(reportsDir, f), "utf-8");
      return content.includes("Vulnerability Report");
    });
    assert.ok(hasContent, "Expected at least one report with vulnerability findings");

    // Lock file should be cleaned up
    assert.ok(!fs.existsSync(path.join(outputDir, "scan.lock")));
  });

  it("resume works after interrupted scan", () => {
    const env = {
      ...process.env,
      PATH: MOCK_CLAUDE + ":" + process.env.PATH,
    };

    // First run
    execFileSync(
      "node",
      [CLI, FIXTURES, "--output", outputDir, "--parallel", "1", "--timeout", "10", "--max-turns", "5"],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    // Manually corrupt state to simulate interrupted scan
    const statePath = path.join(outputDir, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const files = Object.keys(state.files);
    if (files.length > 1) {
      // Set one file back to RUNNING to simulate crash
      state.files[files[0]].status = "RUNNING";
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }

    // Resume
    const result = execFileSync(
      "node",
      [CLI, FIXTURES, "--output", outputDir, "--resume", "--parallel", "1", "--timeout", "10", "--max-turns", "5"],
      { encoding: "utf-8", env, timeout: 30000 },
    );

    assert.ok(result.includes("reset") || result.includes("Done."));
  });
});
