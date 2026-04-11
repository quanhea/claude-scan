const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  parseReportFindings,
  generateSummary,
  writeSummary,
} = require("../dist/reporter");
const { initState } = require("../dist/state");

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

describe("parseReportFindings", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reporter-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty for missing report file", () => {
    const findings = parseReportFindings("/nonexistent.md", "file.ts");
    assert.equal(findings.length, 0);
  });

  it('returns empty for "No vulnerabilities found."', () => {
    const reportPath = path.join(tmpDir, "report.md");
    fs.writeFileSync(reportPath, "No vulnerabilities found.");
    const findings = parseReportFindings(reportPath, "file.ts");
    assert.equal(findings.length, 0);
  });

  it("detects Critical severity", () => {
    const reportPath = path.join(tmpDir, "report.md");
    fs.writeFileSync(reportPath, "## Critical: SQL Injection in login handler");
    const findings = parseReportFindings(reportPath, "auth.ts");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "Critical");
    assert.equal(findings[0].file, "auth.ts");
  });

  it("detects High severity", () => {
    const reportPath = path.join(tmpDir, "report.md");
    fs.writeFileSync(reportPath, "High severity XSS vulnerability");
    const findings = parseReportFindings(reportPath, "page.ts");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "High");
  });

  it("defaults to Unknown severity", () => {
    const reportPath = path.join(tmpDir, "report.md");
    fs.writeFileSync(reportPath, "Some issue found in the code");
    const findings = parseReportFindings(reportPath, "misc.ts");
    assert.equal(findings[0].severity, "Unknown");
  });
});

describe("generateSummary", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-test-"));
    fs.mkdirSync(path.join(tmpDir, "reports"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates summary with stats", () => {
    const state = initState("/tmp/project", ["a.ts", "b.ts"], testConfig);
    state.files["a.ts"].status = "COMPLETED";
    state.files["b.ts"].status = "FAILED";
    state.files["b.ts"].lastError = "rate_limit";
    state.stats = { totalFiles: 2, completed: 1, failed: 1, timeout: 0, skipped: 0, pending: 0, running: 0 };

    const summary = generateSummary(tmpDir, state);
    assert.ok(summary.includes("# claude-scan Summary Report"));
    assert.ok(summary.includes("Total files | 2"));
    assert.ok(summary.includes("Completed | 1"));
    assert.ok(summary.includes("Failed | 1"));
    assert.ok(summary.includes("b.ts"));
    assert.ok(summary.includes("rate_limit"));
  });

  it("includes findings from report files", () => {
    const state = initState("/tmp/project", ["vuln.ts"], testConfig);
    const reportPath = path.join(tmpDir, "reports", "vuln.ts.md");
    fs.writeFileSync(reportPath, "Critical: SQL Injection found");
    state.files["vuln.ts"].status = "COMPLETED";
    state.files["vuln.ts"].reportPath = reportPath;
    state.stats = { totalFiles: 1, completed: 1, failed: 0, timeout: 0, skipped: 0, pending: 0, running: 0 };

    const summary = generateSummary(tmpDir, state);
    assert.ok(summary.includes("Critical (1)"));
    assert.ok(summary.includes("vuln.ts"));
  });

  it("says no vulnerabilities when clean", () => {
    const state = initState("/tmp/project", ["clean.ts"], testConfig);
    const reportPath = path.join(tmpDir, "reports", "clean.ts.md");
    fs.writeFileSync(reportPath, "No vulnerabilities found.");
    state.files["clean.ts"].status = "COMPLETED";
    state.files["clean.ts"].reportPath = reportPath;
    state.stats = { totalFiles: 1, completed: 1, failed: 0, timeout: 0, skipped: 0, pending: 0, running: 0 };

    const summary = generateSummary(tmpDir, state);
    assert.ok(summary.includes("No vulnerabilities found"));
  });
});

describe("writeSummary", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-summary-test-"));
    fs.mkdirSync(path.join(tmpDir, "reports"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes summary.md to output dir", () => {
    const state = initState("/tmp/project", ["a.ts"], testConfig);
    state.files["a.ts"].status = "COMPLETED";
    state.stats = { totalFiles: 1, completed: 1, failed: 0, timeout: 0, skipped: 0, pending: 0, running: 0 };

    const summaryPath = writeSummary(tmpDir, state);
    assert.ok(fs.existsSync(summaryPath));
    const content = fs.readFileSync(summaryPath, "utf-8");
    assert.ok(content.includes("claude-scan Summary Report"));
  });
});
