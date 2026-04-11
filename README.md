# claude-scan

Parallel vulnerability scanner powered by Claude Code.

Scans every source file in a project for security vulnerabilities — each file gets its own Claude Code process running in parallel. Produces per-file vulnerability reports and an aggregated summary.

## Background

At [un]prompted 2026, Anthropic researcher Nicholas Carlini showed that a surprisingly simple scaffold — `claude -p "You are playing in a CTF. Find a vulnerability. hint: look at <file>"` — can find critical zero-days in production software, including a 23-year-old Linux kernel bug and the first critical CVE in Ghost CMS.

The key to scaling this across a codebase is a one-line addition: `hint: look at <file>`, iterated over every source file in the project. Anthropic described this approach in their [red team blog post](https://www.anthropic.com/news/claude-code-security) but did not publish the tooling.

**claude-scan is the open-source implementation of that scaffold.** It handles the boring parts — file discovery, parallel process management, crash recovery, progress display — so the model can do what it's good at.

## Install

```bash
npm install -g @eastagile/claude-scan
```

Prerequisites:
- Node.js 18+
- [Claude Code](https://code.claude.com/docs/en/quickstart) installed and authenticated (`claude auth login`)

## Quick Start

```bash
# Scan a project
claude-scan ./my-project

# Preview what files would be scanned
claude-scan ./my-project --dry-run

# Scan with 8 parallel workers
claude-scan ./my-project -j 8

# Only scan Python files
claude-scan ./my-project --include "*.py"

# Resume after crash or Ctrl+C
claude-scan ./my-project --resume

# Retry failed/timed-out files
claude-scan --resume --retry

# Re-generate summary from existing reports
claude-scan --summarize
claude-scan --summarize --model claude-sonnet-4-6

# Scan current directory
claude-scan
```

## How It Works

```
discover files → queue them → spawn N claude -p processes → collect reports
```

1. **Discover** — `git ls-files` (respects `.gitignore`) or recursive directory walk, filtered by extension, file size, binary content, and test file patterns. Test files are excluded by default (`--include-tests` to opt in). No LLM calls are spent on filtering.
2. **Fan out** — spawns up to N `claude --dangerously-skip-permissions -p "<prompt>"` processes in parallel, each analyzing one file.
3. **Monitor** — tracks progress, handles timeouts (default 5 min per file), saves state atomically for crash recovery.
4. **Summarize** — spawns one final Claude process that reads all per-file reports, deduplicates issues across files, ranks by severity, and writes `summary.md` with links to each report.

Each Claude invocation uses the exact prompt from Carlini's scaffold:

```
You are playing in a CTF.
Find a vulnerability.
hint: look at <file>
Write the most serious one to <report>.
```

## Output

Results go to `.claude-scan/` in the target directory (or `--output <dir>`):

```
.claude-scan/
├── summary.md          # Findings aggregated by severity
├── state.json          # Scan state (enables --resume)
├── reports/            # One markdown report per scanned file
│   ├── src__auth__login.ts.md
│   └── src__db__queries.py.md
├── logs/               # Claude stdout+stderr per file
└── raw/                # Raw JSON output from Claude
```

## Options

```
  -j, --parallel <n>        Parallel workers            (default: 4)
  -t, --timeout <seconds>   Per-file timeout            (default: 300)
      --resume               Resume pending files from a previous scan
      --retry                Retry failed/timed-out files (use with --resume)
      --include-tests        Include test files (excluded by default)
      --summarize            Re-generate AI summary from existing reports
      --include <glob>       Only scan matching files
      --exclude <glob>       Skip matching files
  -o, --output <dir>        Output directory             (default: .claude-scan)
      --model <model>        Claude model to use
      --max-turns <n>        Max Claude turns per file    (default: 30)
      --max-file-size <kb>   Skip files larger than       (default: 100)
      --retries <n>          Max retries per file         (default: 2)
      --dry-run              List files without scanning
      --prompt <file>        Custom prompt template
  -v, --verbose              Verbose output
      --force                Override scan lock
```

## Crash Recovery

State is saved atomically (write temp file → fsync → rename) after every file completes and every 30 seconds. If the process crashes, is killed, or you hit Ctrl+C:

```bash
claude-scan ./my-project --resume
```

Completed files are never re-scanned. Files that were mid-scan reset to pending.

If you run `claude-scan` on a repo with an incomplete previous scan, it will prompt:

```
Previous scan found: 42/66 completed. Resume previous scan? [y/N]
```

To also retry files that failed or timed out:

```bash
claude-scan --resume --retry
```

**Signal handling:**
- 1st Ctrl+C — stops the queue, waits for running scans to finish
- 2nd Ctrl+C — kills all workers immediately, saves state, exits

The tool prints actionable hints at exit when files are pending or failed.

## Custom Prompts

Create a template with `{{FILE_PATH}}` and `{{REPORT_PATH}}` placeholders:

```markdown
You are a security auditor.
Analyze {{FILE_PATH}} for OWASP Top 10 vulnerabilities.
Write a detailed report to {{REPORT_PATH}}.
```

```bash
claude-scan ./my-project --prompt my-prompt.md
```

## Security Warning

This tool runs Claude Code with `--dangerously-skip-permissions`. Claude can execute arbitrary commands in the target directory without confirmation.

- **Run in a container or VM.** Docker with `--network none` is ideal.
- **Run on a clean checkout.** Don't scan repos with secrets, credentials, or `.env` files.
- **The default prompt finds and reports vulnerabilities.** It does not attempt exploitation, but Claude has full tool access.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for a guide to the codebase. Detailed design docs with Mermaid diagrams are in `docs/architecture/`.

## License

MIT — see [LICENSE](LICENSE).
