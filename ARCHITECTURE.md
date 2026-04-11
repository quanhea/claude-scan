# Architecture

This document describes the high-level architecture of claude-scan.
If you want to familiarize yourself with the codebase, you are in the right place.

## Bird's Eye View

claude-scan is a CLI that scans a codebase for security vulnerabilities by
fanning out parallel Claude Code processes — one per source file. The tool
itself does no security analysis. All intelligence comes from Claude. Our
job is orchestration: find files, manage processes, handle failures, save
progress.

The core loop is simple:

```
discover files → queue them → spawn N claude processes → collect reports
```

Every file gets its own `claude -p` invocation with the prompt from
`prompts/scan.md`. The prompt is the exact scaffold from Nicholas Carlini's
[un]prompted 2026 talk — we template in the file path and report path, and
that's it.

## Code Map

The entire source lives in `src/`. There are no subdirectories — the project
is small enough that flat is better.

### The Pipeline

These modules execute in sequence. `scanner.ts` calls them in this order:

```
cli.ts → scanner.ts → preflight.ts → discovery.ts → state.ts → worker-pool.ts → reporter.ts
                                                                      ↓
                                                                 worker.ts
```

**`cli.ts`** — Entry point. Parses argv, calls `scan()`, sets exit code. The
only module that calls `process.exit()`.

**`scanner.ts`** — The orchestrator. This is the largest module and the one to
read first after this file. It wires together every other module: runs
preflight checks, discovers files, initializes or resumes state, creates the
worker pool, subscribes to pool events to update state, handles SIGINT/SIGTERM,
and generates the final summary. If an incomplete previous scan exists and the
user didn't pass `--resume`, it prompts interactively (TTY only). The two
signal handlers live here (first Ctrl+C stops the queue; second kills all
workers).

**`preflight.ts`** — Validates that `claude` is installed and authenticated,
the target directory exists, and no other scan is running (via a lock file
in the output directory). Creates the lock file on success, removes it on
scan completion.

**`discovery.ts`** — Finds files to scan. Uses `git ls-files` when inside a
git repo (respects `.gitignore`), falls back to a recursive directory walk.
Filters by file extension, size, binary content, and test file patterns.
Test files (directories like `tests/`, `__tests__/`, `spec/` and file patterns
like `*.test.ts`, `*_test.go`, `*Test.java`) are excluded by default —
`--include-tests` opts in. The filtering is fully programmatic — no LLM
calls are spent here. The canonical lists live in `types.ts`.

**`state.ts`** — Persistence layer. The scan state (which files are pending,
running, completed, failed) is kept in memory as a `ScanState` object and
periodically flushed to `.claude-scan/state.json`. All writes are atomic:
write to a `.tmp` file, fsync, then rename. This guarantees that a crash at
any point leaves either the old or new state on disk, never a partial write.
On `--resume`, stale RUNNING entries are reset to PENDING. On `--resume --retry`,
FAILED/TIMEOUT/SKIPPED entries are also reset (with attempts zeroed) so they
get a fresh run.

### The Execution Engine

**`worker-pool.ts`** — Manages concurrency. Holds a queue of pending file
paths and a map of active `ChildProcess` handles. When a worker finishes, the
pool dequeues the next file and launches a new worker. The pool adapts its
concurrency: on rate-limit errors it reduces parallelism by 1; after 5
consecutive successes it restores it. Emits `start`, `done`, and `drain`
events consumed by `scanner.ts`.

**`worker.ts`** — Contains `spawnClaude()`, the shared core that spawns any
`claude -p` process. Builds CLI args (`--dangerously-skip-permissions`,
`--max-turns`, `--output-format json`, `--no-session-persistence`), pipes
stdout/stderr to a log file, runs a timeout timer, parses the JSON response
for `is_error` and cost, and classifies errors. Both the per-file scan
(`spawnWorker()` thin wrapper) and the AI summary (`reporter.ts`) use it.

### Support Modules

**`prompt.ts`** — Loads a prompt template file and replaces placeholders
(e.g. `{{FILE_PATH}}`, `{{REPORT_PATH}}`, `{{REPORTS_DIR}}`) from a
key-value map. Two bundled templates: `prompts/scan.md` (per-file scan)
and `prompts/summary.md` (AI-powered summary).

**`progress.ts`** — Terminal output. In TTY mode: in-place progress bar with
per-worker status, updated every 500ms. In non-TTY mode (CI, piped): simple
timestamped log lines.

**`reporter.ts`** — Two-phase summary generation. First writes a basic
`summary.md` with simple string-matched severity (free, instant fallback).
Then spawns one final `claude -p` process with `prompts/summary.md` that
reads all report files, deduplicates issues across files, ranks by severity,
and writes a proper summary with links to per-file reports. Falls back to the
basic summary if the AI step fails.

**`types.ts`** — Shared type definitions, the `STATUS` enum, `CODE_EXTENSIONS`
set, `DEFAULT_IGNORE_PATTERNS` list, and `DEFAULTS` config object. This is the
single source of truth for what file extensions are scanned and what paths are
ignored.

## Architectural Invariants

These are the rules that hold across the codebase. If a change violates one of
these, it's a bug.

- **No module except `cli.ts` calls `process.exit()`.** The scanner returns an
  exit code; the CLI is responsible for exiting. Signal handlers in `scanner.ts`
  are the only exception (force-quit on double Ctrl+C).

- **Worker stdout/stderr is never buffered in memory.** It is piped directly
  to a file write stream via `child.stdout.pipe(logStream)`. This is how we
  scan thousands of files without memory growth.

- **State writes are always atomic.** Write to `.tmp`, fsync, rename. No module
  writes to `state.json` directly. All writes go through `saveState()`.

- **Each file maps to exactly one worker at a time.** The pool's queue ensures
  no file is assigned to two workers simultaneously. No file-level locks are
  needed because the orchestrator is single-threaded.

- **Output files use slugs, not nested directories.** `src/auth/login.ts`
  becomes `src__auth__login.ts.md` (slashes replaced with `__`). All reports,
  logs, and raw output are flat within their respective directories.

- **The tool never modifies the target project.** It reads source files and
  nothing else. All output goes to `.claude-scan/` (or the `--output` path).

- **Claude invocations use `--no-session-persistence`.** This prevents Claude
  from saving a session file per invocation — important when launching hundreds
  of processes. (`--bare` was considered but breaks authentication on claude.ai
  accounts.)

## Cross-Cutting Concerns

**Error classification.** When a worker fails, `spawnClaude()` parses the JSON
response for `is_error` and classifies the error type (rate limit, auth,
overloaded, generic). This classification drives retry behavior in `scanner.ts`
and adaptive concurrency in `worker-pool.ts`.

**Graceful shutdown.** Signal handling spans `scanner.ts` (registers handlers,
decides graceful vs. force) and `worker-pool.ts` (implements `stopAcceptingNew`
and `killAll`). The pool doesn't know about signals — it just exposes controls
that the scanner calls.

**State checkpoints.** `scanner.ts` saves state on three triggers: after each
worker completes, every 30 seconds via `setInterval`, and on process exit. The
30-second checkpoint limits progress loss on SIGKILL (untrappable) to at most
30 seconds of completed work.

## Testing

Tests use Node.js built-in `node:test` and `node:assert`. No mocking
frameworks. A mock `claude` script in `test/fixtures/mock-claude/` acts as a
drop-in replacement — it reads the prompt, extracts the report path, and writes
a fake vulnerability report. Integration tests prepend this fixture to `PATH`
so the real `claude` is never called.

## Detailed Architecture Docs

The `docs/architecture/` directory contains detailed design documents with
Mermaid diagrams covering parallelism, process lifecycle, state machines, and
crash recovery scenarios. Those docs are more detailed than this file and were
written as the design spec before implementation.
