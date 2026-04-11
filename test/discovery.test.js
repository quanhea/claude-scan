const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { discoverFiles, matchesIgnore, isBinary, matchGlob } = require("../dist/discovery");

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

  it("returns empty for nonexistent directory", () => {
    const files = discoverFiles("/tmp/nonexistent-" + Date.now());
    assert.equal(files.length, 0);
  });
});
