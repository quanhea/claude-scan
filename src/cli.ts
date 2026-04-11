#!/usr/bin/env node
// src/cli.ts — CLI entry point
import * as path from "path";
import { scan } from "./scanner";
import { DEFAULTS } from "./types";

function parseArgs(argv: string[]): {
  targetDir: string;
  options: Record<string, string | boolean>;
} {
  const args = argv.slice(2);
  const options: Record<string, string | boolean> = {};
  let targetDir = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version") {
      options.version = true;
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--retry") {
      options.retry = true;
    } else if (arg === "--include-tests") {
      options.includeTests = true;
    } else if (arg === "--summarize") {
      options.summarize = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (
      (arg === "--parallel" || arg === "-j") &&
      i + 1 < args.length
    ) {
      options.parallel = args[++i];
    } else if (
      (arg === "--timeout" || arg === "-t") &&
      i + 1 < args.length
    ) {
      options.timeout = args[++i];
    } else if (
      (arg === "--output" || arg === "-o") &&
      i + 1 < args.length
    ) {
      options.output = args[++i];
    } else if (arg === "--include" && i + 1 < args.length) {
      const val = args[++i];
      options.include = options.include ? options.include + "\0" + val : val;
    } else if (arg === "--exclude" && i + 1 < args.length) {
      const val = args[++i];
      options.exclude = options.exclude ? options.exclude + "\0" + val : val;
    } else if (arg === "--model" && i + 1 < args.length) {
      options.model = args[++i];
    } else if (arg === "--max-turns" && i + 1 < args.length) {
      options.maxTurns = args[++i];
    } else if (arg === "--max-file-size" && i + 1 < args.length) {
      options.maxFileSize = args[++i];
    } else if (arg === "--retries" && i + 1 < args.length) {
      options.retries = args[++i];
    } else if (arg === "--prompt" && i + 1 < args.length) {
      options.prompt = args[++i];
    } else if (!arg.startsWith("-")) {
      targetDir = arg;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return { targetDir, options };
}

function printHelp(): void {
  console.log(`
claude-scan — parallel vulnerability scanner powered by Claude Code

Usage:
  claude-scan [target-dir] [options]

  When no target-dir is given, scans the current directory.

Options:
  -j, --parallel <n>        Parallel workers           (default: ${DEFAULTS.parallel})
  -t, --timeout <seconds>   Per-file timeout           (default: ${DEFAULTS.timeout})
      --resume               Resume pending files from a previous scan
      --retry                Retry failed/timed-out files (use with --resume)
      --include-tests        Include test files (excluded by default)
      --include <glob>       Only scan matching files
      --exclude <glob>       Skip matching files
  -o, --output <dir>        Output directory            (default: .claude-scan)
      --model <model>        Claude model to use
      --max-turns <n>        Max Claude turns per file   (default: ${DEFAULTS.maxTurns})
      --max-file-size <kb>   Skip files larger than      (default: ${DEFAULTS.maxFileSizeKB})
      --retries <n>          Max retries per file        (default: ${DEFAULTS.maxRetries})
      --summarize            Re-generate AI summary from existing reports
      --dry-run              List files without scanning
      --prompt <file>        Custom prompt template
  -v, --verbose              Verbose output
      --force                Override scan lock
  -h, --help                 Show this help
      --version              Show version

Examples:
  claude-scan ./my-project
  claude-scan ./my-project -j 8 --timeout 600
  claude-scan ./my-project --include "*.py" --exclude "test/*"
  claude-scan ./my-project --resume
  claude-scan ./my-project --dry-run
`);
}

async function main(): Promise<void> {
  const { targetDir, options } = parseArgs(process.argv);

  if (options.version) {
    const pkg = require("../package.json");
    console.log(pkg.version);
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  // Default to current directory when no target specified

  const resolvedTarget = targetDir
    ? path.resolve(targetDir)
    : process.cwd();
  const outputDir =
    typeof options.output === "string"
      ? options.output
      : path.join(resolvedTarget, ".claude-scan");

  const exitCode = await scan({
    targetDir: resolvedTarget,
    outputDir,
    parallel: Number(options.parallel) || DEFAULTS.parallel,
    timeout: Number(options.timeout) || DEFAULTS.timeout,
    maxRetries: Number(options.retries) || DEFAULTS.maxRetries,
    maxTurns: Number(options.maxTurns) || DEFAULTS.maxTurns,
    maxFileSizeKB: Number(options.maxFileSize) || DEFAULTS.maxFileSizeKB,
    model: (options.model as string) ?? null,
    promptFile: (options.prompt as string) ?? null,
    include: options.include ? (options.include as string).split("\0") : null,
    exclude: options.exclude ? (options.exclude as string).split("\0") : null,
    includeTests: !!options.includeTests,
    summarize: !!options.summarize,
    resume: !!options.resume,
    retry: !!options.retry,
    dryRun: !!options.dryRun,
    force: !!options.force,
    verbose: !!options.verbose,
  });

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
