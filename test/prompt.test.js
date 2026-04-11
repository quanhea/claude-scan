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
  it("replaces FILE_PATH and REPORT_PATH placeholders", () => {
    const template = "look at {{FILE_PATH}} write to {{REPORT_PATH}}";
    const result = renderPrompt(template, "/src/app.ts", "/out/report.md");
    assert.equal(result, "look at /src/app.ts write to /out/report.md");
  });

  it("replaces multiple occurrences", () => {
    const template = "{{FILE_PATH}} and {{FILE_PATH}} again";
    const result = renderPrompt(template, "foo.js", "bar.md");
    assert.equal(result, "foo.js and foo.js again");
  });

  it("returns unchanged string when no placeholders", () => {
    const result = renderPrompt("no placeholders here", "f", "r");
    assert.equal(result, "no placeholders here");
  });
});
