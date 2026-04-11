// src/reporter.ts — aggregate per-file reports into summary.md
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ScanState, ScanConfig, STATUS } from "./types";
import { loadPrompt, renderPrompt } from "./prompt";

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
  claudeResult?: string;
  cost?: number;
}

export async function summarizeWithClaude(options: {
  outputDir: string;
  state: ScanState;
  config: ScanConfig;
  onLog?: (msg: string) => void;
}): Promise<SummarizeResult> {
  const { outputDir, state, config, onLog } = options;
  const reportsDir = path.join(outputDir, "reports");
  const summaryPath = path.join(outputDir, "summary.md");
  const logPath = path.join(outputDir, "logs", "summary.log");
  const rawPath = path.join(outputDir, "raw", "summary.json");
  const startTime = Date.now();

  const log = (msg: string) => { if (onLog) onLog(msg); };

  // Check for completed reports
  const reportFiles = Object.values(state.files)
    .filter((e) => e.status === STATUS.COMPLETED && e.reportPath && fs.existsSync(e.reportPath));

  if (reportFiles.length === 0) {
    log("No completed reports to summarize.");
    writeSummary(outputDir, state);
    return { success: false, summaryPath, durationMs: 0, exitCode: null, error: "no_reports" };
  }

  log(`Reading ${reportFiles.length} report files...`);

  // Load and render the summary prompt
  const template = loadPrompt("summary.md");
  const prompt = renderPrompt(template, {
    REPORTS_DIR: reportsDir,
    SUMMARY_PATH: summaryPath,
  });

  const args: string[] = [
    "--dangerously-skip-permissions",
    "-p",
    prompt,
    "--max-turns",
    String(config.maxTurns),
    "--output-format",
    "json",
    "--no-session-persistence",
  ];

  if (config.model) {
    args.push("--model", config.model);
    log(`Using model: ${config.model}`);
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: "w" });

  return new Promise<SummarizeResult>((resolve) => {
    log("Spawning Claude for summary generation...");

    const child = spawn("claude", args, {
      cwd: outputDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let lastStdoutChunk = "";

    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        lastStdoutChunk = data.toString();
      });
      child.stdout.pipe(logStream);
    }
    if (child.stderr) {
      child.stderr.pipe(logStream);
    }

    const timeoutTimer = setTimeout(() => {
      log(`Timeout after ${config.timeout}s — killing summary process.`);
      try { child.kill("SIGTERM"); } catch {}
    }, config.timeout * 1000);

    child.on("exit", (code) => {
      clearTimeout(timeoutTimer);
      logStream.end();

      const durationMs = Date.now() - startTime;

      // Parse JSON response for details
      let claudeResult: string | undefined;
      let cost: number | undefined;
      let isError = false;

      try {
        const raw = lastStdoutChunk.trim() || fs.readFileSync(logPath, "utf-8").trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          fs.writeFileSync(rawPath, JSON.stringify(parsed, null, 2));
          claudeResult = parsed.result;
          cost = parsed.total_cost_usd;
          isError = parsed.is_error === true;

          if (isError) {
            log(`Claude error: ${parsed.result}`);
          } else if (cost !== undefined) {
            log(`Cost: $${cost.toFixed(4)}`);
          }
        }
      } catch {
        // Not JSON
      }

      if (isError || code !== 0) {
        const errMsg = claudeResult || `exit_code_${code}`;
        log(`Summary generation failed: ${errMsg}`);
        writeSummary(outputDir, state);
        resolve({ success: false, summaryPath, durationMs, exitCode: code, error: errMsg, claudeResult, cost });
        return;
      }

      // Verify Claude wrote something meaningful
      if (fs.existsSync(summaryPath)) {
        const content = fs.readFileSync(summaryPath, "utf-8").trim();
        if (content.length > 50) {
          log("AI summary written successfully.");
          resolve({ success: true, summaryPath, durationMs, exitCode: code, claudeResult, cost });
          return;
        }
      }

      // Claude succeeded but didn't write the file — check if result contains the summary
      if (claudeResult && claudeResult.length > 100) {
        log("Claude returned summary in response (didn't write file). Writing it.");
        fs.writeFileSync(summaryPath, claudeResult);
        resolve({ success: true, summaryPath, durationMs, exitCode: code, claudeResult, cost });
        return;
      }

      log("Claude completed but no summary was produced. Using basic fallback.");
      writeSummary(outputDir, state);
      resolve({ success: false, summaryPath, durationMs, exitCode: code, error: "no_output", claudeResult, cost });
    });

    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      logStream.end();
      const durationMs = Date.now() - startTime;
      const errMsg = err.message.includes("ENOENT") ? "claude not found" : err.message;
      log(`Spawn error: ${errMsg}`);
      writeSummary(outputDir, state);
      resolve({ success: false, summaryPath, durationMs, exitCode: null, error: errMsg });
    });
  });
}
