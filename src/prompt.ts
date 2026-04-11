// src/prompt.ts — load and template the scan prompt
import * as fs from "fs";
import * as path from "path";

const PROMPTS_DIR = path.join(__dirname, "..", "prompts");

export function loadPrompt(promptFile: string | null): string {
  const file = promptFile ?? "scan.md";
  // If absolute or relative path exists, use it directly
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, "utf-8").trim();
  }
  // Otherwise look in the bundled prompts/ directory
  const bundled = path.join(PROMPTS_DIR, file);
  if (fs.existsSync(bundled)) {
    return fs.readFileSync(bundled, "utf-8").trim();
  }
  throw new Error(`Prompt file not found: ${file}`);
}

export function renderPrompt(
  template: string,
  filePath: string,
  reportPath: string,
): string {
  return template
    .replace(/\{\{FILE_PATH\}\}/g, filePath)
    .replace(/\{\{REPORT_PATH\}\}/g, reportPath);
}
