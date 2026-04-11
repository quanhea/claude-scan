# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

claude-scan is an open-source CLI that implements the vulnerability scanning scaffold from Nicholas Carlini's [un]prompted 2026 talk. It spawns parallel Claude Code processes — one per source file — to produce independent vulnerability reports across an entire codebase. The prompt used is the exact Carlini scaffold from `prompts/scan.md`.

## Build & Test

```bash
npm install          # install deps (typescript, @types/node)
npm run build        # tsc → compiles src/*.ts to dist/
npm test             # node --test test/*.test.js
```

Single test: `node --test test/discovery.test.js`

The CLI entry point is `dist/cli.ts` → compiled to `dist/cli.js`. Run locally: `node dist/cli.js <target-dir>`.

## Architecture

Defined in detail in `docs/architecture/`. Follow these docs — they are the source of truth for all design decisions.

- **SYSTEM-OVERVIEW.md** — components, data flow, file discovery, Claude Code invocation flags, output structure
- **EXECUTION-ENGINE.md** — worker pool, process lifecycle, parallelism, signals, memory, progress display
- **RESILIENCE-AND-RECOVERY.md** — state machine, atomic writes, crash recovery, resume, lock files, error classification

### Component Map (src/)

```
cli.ts           → arg parsing, orchestrates the scan pipeline
preflight.ts     → validates: claude installed? authenticated? target exists? lock file?
discovery.ts     → finds files to scan (git ls-files or glob, filters by extension/size/binary)
state.ts         → state persistence (state.json), atomic writes, resume logic
worker-pool.ts   → manages N concurrent claude child processes
worker.ts        → spawns a single claude -p process, handles timeout/hang/exit
reporter.ts      → basic summary fallback + AI-powered summary via prompts/summary.md
progress.ts      → terminal progress display (TTY vs piped)
types.ts         → shared types, constants, status enum, defaults
prompt.ts        → loads prompt templates, replaces {{PLACEHOLDER}} vars from a map
scanner.ts       → top-level orchestrator tying everything together
```

### Key Design Decisions

- **TypeScript compiled to JS** — no runtime TS dependency, distributed as compiled JS via npm
- **Plain `child_process.spawn`** — no tmux, no external process manager. Claude runs in non-interactive `-p` mode
- **Programmatic file filtering** — `git ls-files` + extension/size/binary/test-pattern checks. No LLM pre-filter call
- **Test files excluded by default** — comprehensive patterns for all languages (`DEFAULT_TEST_PATTERNS` + JVM-specific). Opt in with `--include-tests`
- **Atomic state writes** — write to `.tmp`, fsync, rename. Never corrupt state.json
- **No file-level locks** — single-threaded orchestrator + unique output paths per file = safe
- **`--no-session-persistence`** — don't save session files for each of potentially thousands of scans
- **Two-phase summary** — basic string-matched fallback first, then AI-powered deduplication/ranking via `prompts/summary.md`
- **Interactive resume prompt** — if `.claude-scan/state.json` exists with incomplete files and user didn't pass `--resume`, prompts "Resume? [y/N]" (TTY only, skipped in CI/piped)

### State Machine (per file)

`PENDING → RUNNING → COMPLETED | FAILED | TIMEOUT | INTERRUPTED`

On resume: RUNNING/INTERRUPTED reset to PENDING. FAILED retries up to maxRetries then becomes SKIPPED.

### Output Structure

```
.claude-scan/
├── state.json       # scan state for resume
├── scan.lock        # prevents concurrent scans
├── summary.md       # aggregated findings
├── reports/         # one .md per scanned file
├── logs/            # stdout+stderr per file
└── raw/             # raw JSON from claude
```

## Testing Approach

Tests use Node.js built-in `node:test` and `node:assert`. No mocking frameworks — let real code run against real filesystem fixtures. Tests compile with `tsc` then run from `test/`.

## Prompt Template

The prompt in `prompts/scan.md` is the exact Carlini scaffold. The `{{FILE_PATH}}` and `{{REPORT_PATH}}` placeholders are replaced per-file at runtime. Users can supply a custom prompt via `--prompt <file>`.
