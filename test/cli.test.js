const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const path = require("path");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const FIXTURES = path.join(__dirname, "fixtures", "sample-project");

describe("CLI", () => {
  it("--help shows usage", () => {
    const out = execFileSync("node", [CLI, "--help"], { encoding: "utf-8" });
    assert.ok(out.includes("claude-scan"));
    assert.ok(out.includes("--parallel"));
    assert.ok(out.includes("--timeout"));
    assert.ok(out.includes("--resume"));
    assert.ok(out.includes("--dry-run"));
  });

  it("--version shows version number", () => {
    const out = execFileSync("node", [CLI, "--version"], {
      encoding: "utf-8",
    });
    assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
  });

  it("defaults to current directory with --dry-run", () => {
    const out = execFileSync("node", [CLI, "--dry-run"], {
      encoding: "utf-8",
      cwd: FIXTURES,
    });
    assert.ok(out.includes("Would scan") || out.includes("No files"));
  });

  it("--help shows --retry and --include-tests flags", () => {
    const out = execFileSync("node", [CLI, "--help"], { encoding: "utf-8" });
    assert.ok(out.includes("--retry"));
    assert.ok(out.includes("--include-tests"));
  });

  it("--dry-run --include-tests includes test files", () => {
    const without = execFileSync(
      "node",
      [CLI, FIXTURES, "--dry-run"],
      { encoding: "utf-8" },
    );
    const withTests = execFileSync(
      "node",
      [CLI, FIXTURES, "--dry-run", "--include-tests"],
      { encoding: "utf-8" },
    );
    // --include-tests should show more files
    const countWithout = (without.match(/\n/g) || []).length;
    const countWith = (withTests.match(/\n/g) || []).length;
    assert.ok(countWith > countWithout, "Expected more files with --include-tests");
  });

  it("--dry-run lists files without scanning", () => {
    const out = execFileSync(
      "node",
      [CLI, FIXTURES, "--dry-run"],
      { encoding: "utf-8" },
    );
    assert.ok(out.includes("Would scan"));
    assert.ok(out.includes("src/app.js"));
    assert.ok(out.includes("src/main.py"));
  });

  it("--dry-run with --include filters files", () => {
    const out = execFileSync(
      "node",
      [CLI, FIXTURES, "--dry-run", "--include", "*.py"],
      { encoding: "utf-8" },
    );
    assert.ok(out.includes("src/main.py"));
    assert.ok(!out.includes("src/app.js"));
  });

  it("--dry-run with --exclude filters files", () => {
    const out = execFileSync(
      "node",
      [CLI, FIXTURES, "--dry-run", "--exclude", "*.sql"],
      { encoding: "utf-8" },
    );
    assert.ok(!out.includes("src/query.sql"));
    assert.ok(out.includes("src/app.js"));
  });

  it("exits with error for nonexistent target", () => {
    try {
      execFileSync("node", [CLI, "/tmp/nonexistent-" + Date.now(), "--dry-run"], {
        encoding: "utf-8",
        stdio: "pipe",
      });
      assert.fail("Should have exited with error");
    } catch (err) {
      assert.ok(err.status !== 0);
    }
  });
});
