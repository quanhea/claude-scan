const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { discoverFiles, matchesIgnore, matchesTestPattern, isBinary, matchGlob } = require("../dist/discovery");

const FIXTURES = path.join(__dirname, "fixtures", "sample-project");

describe("matchesIgnore", () => {
  it("matches node_modules directory", () => {
    assert.ok(matchesIgnore("node_modules/foo/index.js"));
  });

  it("matches __pycache__ directory", () => {
    assert.ok(matchesIgnore("src/__pycache__/mod.pyc"));
  });

  it("matches .min.js extension", () => {
    assert.ok(matchesIgnore("vendor/lib.min.js"));
  });

  it("matches package-lock.json exactly", () => {
    assert.ok(matchesIgnore("package-lock.json"));
  });

  it("matches nested lock files", () => {
    assert.ok(matchesIgnore("subdir/yarn.lock"));
  });

  it("does not match normal source files", () => {
    assert.ok(!matchesIgnore("src/app.ts"));
    assert.ok(!matchesIgnore("lib/utils.py"));
  });
});

describe("isBinary", () => {
  it("detects binary files (null bytes)", () => {
    const binFile = path.join(FIXTURES, "src", "image.png");
    assert.ok(isBinary(binFile));
  });

  it("detects text files as non-binary", () => {
    const textFile = path.join(FIXTURES, "src", "app.js");
    assert.ok(!isBinary(textFile));
  });

  it("returns true for non-existent files", () => {
    assert.ok(isBinary("/tmp/does-not-exist-" + Date.now()));
  });
});

describe("matchesTestPattern", () => {
  it("matches test directories", () => {
    assert.ok(matchesTestPattern("tests/test_auth.py"));
    assert.ok(matchesTestPattern("__tests__/app.test.js"));
    assert.ok(matchesTestPattern("spec/models/user_spec.rb"));
    assert.ok(matchesTestPattern("e2e/login.test.ts"));
    assert.ok(matchesTestPattern("cypress/integration/login.js"));
  });

  it("matches JS/TS test file patterns", () => {
    assert.ok(matchesTestPattern("src/app.test.ts"));
    assert.ok(matchesTestPattern("src/app.spec.js"));
    assert.ok(matchesTestPattern("src/app.test.tsx"));
    assert.ok(matchesTestPattern("src/app.spec.jsx"));
  });

  it("matches Go test files", () => {
    assert.ok(matchesTestPattern("src/handler_test.go"));
  });

  it("matches Python test files", () => {
    assert.ok(matchesTestPattern("test_auth.py"));
    assert.ok(matchesTestPattern("src/test_utils.py"));
    assert.ok(matchesTestPattern("src/auth_test.py"));
    assert.ok(matchesTestPattern("conftest.py"));
  });

  it("matches JVM test files", () => {
    assert.ok(matchesTestPattern("src/FooTest.java"));
    assert.ok(matchesTestPattern("src/FooTests.java"));
    assert.ok(matchesTestPattern("src/BarTest.kt"));
    assert.ok(matchesTestPattern("TestFoo.java"));
  });

  it("matches Ruby spec files", () => {
    assert.ok(matchesTestPattern("spec/models/user_spec.rb"));
    assert.ok(matchesTestPattern("src/user_spec.rb"));
  });

  it("matches Rust/C/Elixir test files", () => {
    assert.ok(matchesTestPattern("src/parser_test.rs"));
    assert.ok(matchesTestPattern("src/utils_test.c"));
    assert.ok(matchesTestPattern("src/auth_test.exs"));
  });

  it("does NOT match normal files with 'test' in name", () => {
    assert.ok(!matchesTestPattern("src/testutils.py"));
    assert.ok(!matchesTestPattern("src/testing_utils.ts"));
    assert.ok(!matchesTestPattern("src/attestation.go"));
    assert.ok(!matchesTestPattern("src/contest.java"));
  });
});

describe("matchGlob", () => {
  it("matches *.ext patterns", () => {
    assert.ok(matchGlob("src/app.ts", "*.ts"));
    assert.ok(!matchGlob("src/app.ts", "*.js"));
  });

  it("matches dir/* patterns", () => {
    assert.ok(matchGlob("src/app.ts", "src/*"));
    assert.ok(!matchGlob("lib/app.ts", "src/*"));
  });

  it("matches dir/** patterns", () => {
    assert.ok(matchGlob("src/deep/nested/file.ts", "src/**"));
    assert.ok(!matchGlob("lib/file.ts", "src/**"));
  });

  it("matches substring patterns", () => {
    assert.ok(matchGlob("src/test_helper.ts", "test"));
    assert.ok(!matchGlob("src/app.ts", "test"));
  });
});

describe("discoverFiles", () => {
  it("finds code files and excludes non-code", () => {
    const files = discoverFiles(FIXTURES);
    assert.ok(files.includes("src/app.js"));
    assert.ok(files.includes("src/main.py"));
    assert.ok(files.includes("src/query.sql"));
    assert.ok(files.includes("src/index.html"));
  });

  it("excludes node_modules", () => {
    const files = discoverFiles(FIXTURES);
    const nodeModFiles = files.filter((f) => f.includes("node_modules"));
    assert.equal(nodeModFiles.length, 0);
  });

  it("excludes binary files", () => {
    const files = discoverFiles(FIXTURES);
    assert.ok(!files.includes("src/image.png"));
  });

  it("excludes lock files", () => {
    const files = discoverFiles(FIXTURES);
    assert.ok(!files.includes("package-lock.json"));
  });

  it("excludes files over maxFileSizeKB", () => {
    const files = discoverFiles(FIXTURES, { maxFileSizeKB: 100 });
    assert.ok(!files.includes("src/huge.js"));
  });

  it("includes large files when maxFileSizeKB is raised", () => {
    const files = discoverFiles(FIXTURES, { maxFileSizeKB: 500 });
    assert.ok(files.includes("src/huge.js"));
  });

  it("filters with --include", () => {
    const files = discoverFiles(FIXTURES, { include: "*.py" });
    assert.ok(files.includes("src/main.py"));
    assert.ok(!files.includes("src/app.js"));
  });

  it("filters with --exclude", () => {
    const files = discoverFiles(FIXTURES, { exclude: "*.sql" });
    assert.ok(!files.includes("src/query.sql"));
    assert.ok(files.includes("src/app.js"));
  });

  it("returns sorted results", () => {
    const files = discoverFiles(FIXTURES);
    const sorted = [...files].sort();
    assert.deepEqual(files, sorted);
  });

  it("excludes test files by default", () => {
    const files = discoverFiles(FIXTURES);
    // Test directories
    assert.ok(!files.some((f) => f.startsWith("tests/")));
    assert.ok(!files.some((f) => f.startsWith("__tests__/")));
    // Test file patterns
    assert.ok(!files.includes("src/handler_test.go"));
    assert.ok(!files.includes("src/app.spec.ts"));
    assert.ok(!files.includes("src/FooTest.java"));
    assert.ok(!files.includes("conftest.py"));
    // Non-test files with "test" in name should still be included
    assert.ok(files.includes("src/testutils.py"));
  });

  it("includes test files with includeTests: true", () => {
    const files = discoverFiles(FIXTURES, { includeTests: true });
    assert.ok(files.some((f) => f.startsWith("tests/")));
    assert.ok(files.some((f) => f.startsWith("__tests__/")));
    assert.ok(files.includes("src/handler_test.go"));
    assert.ok(files.includes("src/app.spec.ts"));
    assert.ok(files.includes("src/FooTest.java"));
    assert.ok(files.includes("conftest.py"));
  });

  it("returns empty for nonexistent directory", () => {
    const files = discoverFiles("/tmp/nonexistent-" + Date.now());
    assert.equal(files.length, 0);
  });
});
