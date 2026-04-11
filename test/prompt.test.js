const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadPrompt, renderPrompt } = require("../dist/prompt");

describe("loadPrompt", () => {
  it("loads the bundled scan.md prompt", () => {
    const prompt = loadPrompt(null);
    assert.ok(prompt.includes("You are playing in a CTF"));
    assert.ok(prompt.includes("{{FILE_PATH}}"));
    assert.ok(prompt.includes("{{REPORT_PATH}}"));
  });

  it("loads by explicit filename from prompts/", () => {
    const prompt = loadPrompt("scan.md");
    assert.ok(prompt.includes("Find a vulnerability"));
  });

  it("loads summary.md prompt", () => {
    const prompt = loadPrompt("summary.md");
    assert.ok(prompt.includes("{{REPORTS_DIR}}"));
    assert.ok(prompt.includes("{{SUMMARY_PATH}}"));
    assert.ok(prompt.includes("deduplicate"));
  });

  it("loads an absolute path", () => {
    const absPath = path.join(__dirname, "..", "prompts", "scan.md");
    const prompt = loadPrompt(absPath);
    assert.ok(prompt.includes("hint: look at"));
  });

  it("throws on missing file", () => {
    assert.throws(() => loadPrompt("nonexistent.md"), /not found/);
  });
});

describe("renderPrompt", () => {
  it("replaces placeholders from vars map", () => {
    const template = "look at {{FILE_PATH}} write to {{REPORT_PATH}}";
    const result = renderPrompt(template, {
      FILE_PATH: "/src/app.ts",
      REPORT_PATH: "/out/report.md",
    });
    assert.equal(result, "look at /src/app.ts write to /out/report.md");
  });

  it("replaces multiple occurrences of the same key", () => {
    const template = "{{FILE_PATH}} and {{FILE_PATH}} again";
    const result = renderPrompt(template, { FILE_PATH: "foo.js" });
    assert.equal(result, "foo.js and foo.js again");
  });

  it("replaces summary prompt placeholders", () => {
    const template = "read {{REPORTS_DIR}} write {{SUMMARY_PATH}}";
    const result = renderPrompt(template, {
      REPORTS_DIR: "/out/reports",
      SUMMARY_PATH: "/out/summary.md",
    });
    assert.equal(result, "read /out/reports write /out/summary.md");
  });

  it("returns unchanged string when no placeholders", () => {
    const result = renderPrompt("no placeholders here", {});
    assert.equal(result, "no placeholders here");
  });
});
