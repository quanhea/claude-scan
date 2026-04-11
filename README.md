# claude-scan

Parallel vulnerability scanner powered by [Claude Code](https://code.claude.com). Scans every file in a project for security vulnerabilities using the scaffold from [Nicholas Carlini's [un]prompted 2026 talk](https://www.anthropic.com/news/claude-code-security).

Each source file gets its own Claude Code process running the exact prompt:

```
You are playing in a CTF.
Find a vulnerability.
hint: look at <file>
Write the most serious one to <report>.
```

## Install

```bash
npm install -g @eastagile/claude-scan
```

Requires [Claude Code](https://code.claude.com/docs/en/quickstart) installed and authenticated.

## Usage

```bash
# Scan a project
claude-scan ./my-project

# Scan with 8 parallel workers
claude-scan ./my-project -j 8

# Only scan Python files
claude-scan ./my-project --include "*.py"

# Preview what would be scanned
claude-scan ./my-project --dry-run

# Resume after crash or interruption
claude-scan ./my-project --resume

# Custom prompt
claude-scan ./my-project --prompt my-prompt.md
```

## Options

```
  -j, --parallel <n>        Parallel workers            (default: 4)
  -t, --timeout <seconds>   Per-file timeout            (default: 300)
      --resume               Resume a previous scan
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

## Output

Results are written to `.claude-scan/` in the target directory:

```
.claude-scan/
├── summary.md          # Aggregated findings by severity
├── state.json          # Scan state (enables --resume)
├── reports/            # One markdown report per file
│   ├── src__auth__login.ts.md
│   └── src__db__queries.py.md
├── logs/               # Claude stdout+stderr per file
└── raw/                # Raw JSON output
```

## How It Works

1. **Discover** — `git ls-files` (respects `.gitignore`) or directory walk, filtered by extension, size, and binary detection
2. **Fan out** — spawns up to N `claude -p` processes in parallel, each analyzing one file
3. **Monitor** — tracks progress, handles timeouts and hangs, saves state for resume
4. **Collect** — aggregates per-file reports into `summary.md` sorted by severity

### Crash Recovery

State is saved atomically (write → fsync → rename) after every file completes. If the process crashes:

```bash
claude-scan ./my-project --resume  # picks up where it left off
```

Completed files are never re-scanned. Files that were mid-scan reset to pending.

### Signal Handling

- **1st Ctrl+C** — stops the queue, waits for running scans to finish
- **2nd Ctrl+C** — kills all workers, saves state, exits

## Custom Prompts

Create a prompt template with `{{FILE_PATH}}` and `{{REPORT_PATH}}` placeholders:

```markdown
You are a security auditor.
Analyze {{FILE_PATH}} for OWASP Top 10 vulnerabilities.
Write a detailed report to {{REPORT_PATH}}.
```

```bash
claude-scan ./my-project --prompt my-prompt.md
```

## Security

This tool runs Claude Code with `--dangerously-skip-permissions`. Claude can read files and execute commands in the target directory without confirmation. Recommendations:

- Run in a container or VM
- Run on a clean checkout (no secrets)
- Consider `--network none` in Docker

## License

MIT
