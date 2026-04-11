// src/reporter.ts — aggregate per-file reports into summary.md
import * as fs from "fs";
import * as path from "path";
import { ScanState, STATUS } from "./types";

export interface Finding {
  file: string;
  severity: string;
  content: string;
}

export function parseReportFindings(reportPath: string, file: string): Finding[] {
  if (!fs.existsSync(reportPath)) return [];

  const content = fs.readFileSync(reportPath, "utf-8").trim();
  if (!content || content === "No vulnerabilities found.") return [];

  // Detect severity from report content
  const severity = detectSeverity(content);

  return [{ file, severity, content }];
}

function detectSeverity(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes("critical")) return "Critical";
  if (lower.includes("high")) return "High";
  if (lower.includes("medium")) return "Medium";
  if (lower.includes("low")) return "Low";
  return "Unknown";
}

export function countFindings(outputDir: string, state: ScanState): number {
  const reportsDir = path.join(outputDir, "reports");
  if (!fs.existsSync(reportsDir)) return 0;

  let count = 0;
  for (const [file, entry] of Object.entries(state.files)) {
    if (entry.status !== STATUS.COMPLETED) continue;
    if (!entry.reportPath) continue;
    if (!fs.existsSync(entry.reportPath)) continue;

    const content = fs.readFileSync(entry.reportPath, "utf-8").trim();
    if (content && content !== "No vulnerabilities found.") {
      count++;
    }
  }
  return count;
}

export function generateSummary(outputDir: string, state: ScanState): string {
  const reportsDir = path.join(outputDir, "reports");
  const lines: string[] = [];

  lines.push("# claude-scan Summary Report");
  lines.push("");
  lines.push(`**Target:** ${state.targetDir}`);
  lines.push(`**Scan ID:** ${state.scanId}`);
  lines.push(`**Started:** ${state.startedAt}`);
  lines.push(`**Completed:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Stats");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total files | ${state.stats.totalFiles} |`);
  lines.push(`| Completed | ${state.stats.completed} |`);
  lines.push(`| Failed | ${state.stats.failed} |`);
  lines.push(`| Timeout | ${state.stats.timeout} |`);
  lines.push(`| Skipped | ${state.stats.skipped} |`);
  lines.push("");

  // Collect all findings
  const allFindings: Finding[] = [];
  if (fs.existsSync(reportsDir)) {
    for (const [file, entry] of Object.entries(state.files)) {
      if (entry.status !== STATUS.COMPLETED || !entry.reportPath) continue;
      const findings = parseReportFindings(entry.reportPath, file);
      allFindings.push(...findings);
    }
  }

  const severityOrder = ["Critical", "High", "Medium", "Low", "Unknown"];

  lines.push("## Findings");
  lines.push("");

  if (allFindings.length === 0) {
    lines.push("No vulnerabilities found.");
  } else {
    lines.push(`**${allFindings.length} files with findings**`);
    lines.push("");

    // Group by severity
    for (const severity of severityOrder) {
      const group = allFindings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;

      lines.push(`### ${severity} (${group.length})`);
      lines.push("");
      for (const finding of group) {
        lines.push(`- **${finding.file}** — see \`reports/${finding.file.replace(/\//g, "__")}.md\``);
      }
      lines.push("");
    }
  }

  // Failed files section
  const failedFiles = Object.entries(state.files)
    .filter(([, e]) => e.status === STATUS.FAILED || e.status === STATUS.TIMEOUT)
    .map(([f, e]) => ({ file: f, status: e.status, error: e.lastError }));

  if (failedFiles.length > 0) {
    lines.push("## Failed / Timed Out Files");
    lines.push("");
    for (const { file, status, error } of failedFiles) {
      lines.push(`- **${file}** — ${status}${error ? ` (${error})` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function writeSummary(outputDir: string, state: ScanState): string {
  const summaryPath = path.join(outputDir, "summary.md");
  const content = generateSummary(outputDir, state);
  fs.writeFileSync(summaryPath, content);
  return summaryPath;
}
