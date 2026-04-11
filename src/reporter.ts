// src/reporter.ts — aggregate per-file reports into summary.md
import * as fs from "fs";
import * as path from "path";
import { ScanState, ScanConfig, STATUS } from "./types";
import { loadPrompt, renderPrompt } from "./prompt";
import { spawnClaude } from "./worker";

export interface Finding {
  file: string;
  severity: string;
  content: string;
}

export function parseReportFindings(reportPath: string, file: string): Finding[] {
  if (!fs.existsSync(reportPath)) return [];

  const content = fs.readFileSync(reportPath, "utf-8").trim();
  if (!content || content === "No vulnerabilities found.") return [];

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

export interface SummarizeResult {
  success: boolean;
  summaryPath: string;
  durationMs: number;
  exitCode: number | null;
  error?: string;
  cost?: number;
}

export async function summarizeWithClaude(options: {
  outputDir: string;
  state: ScanState;
  config: ScanConfig;
}): Promise<SummarizeResult> {
  const { outputDir, state, config } = options;
  const reportsDir = path.join(outputDir, "reports");
  const summaryPath = path.join(outputDir, "summary.md");
  const logPath = path.join(outputDir, "logs", "summary.log");
  const rawPath = path.join(outputDir, "raw", "summary.json");

  // Render the summary prompt — same pattern as per-file scan
  const template = loadPrompt("summary.md");
  const prompt = renderPrompt(template, {
    REPORTS_DIR: reportsDir,
    SUMMARY_PATH: summaryPath,
  });

  // Summary reads many files — use 30 min timeout instead of per-file timeout
  const summaryConfig = { ...config, timeout: 1800 };
  const { promise } = spawnClaude({ prompt, cwd: outputDir, logPath, rawPath, config: summaryConfig });
  const r = await promise;

  // Map result
  if (r.killed || r.exitCode !== 0 || r.isError) {
    writeSummary(outputDir, state);
    return {
      success: false, summaryPath, durationMs: r.durationMs,
      exitCode: r.exitCode, error: r.error, cost: r.cost,
    };
  }

  // Check if Claude wrote the summary file
  if (fs.existsSync(summaryPath)) {
    const content = fs.readFileSync(summaryPath, "utf-8").trim();
    if (content.length > 50) {
      return { success: true, summaryPath, durationMs: r.durationMs, exitCode: r.exitCode, cost: r.cost };
    }
  }

  // Fallback
  writeSummary(outputDir, state);
  return {
    success: false, summaryPath, durationMs: r.durationMs,
    exitCode: r.exitCode, error: "no_output", cost: r.cost,
  };
}
