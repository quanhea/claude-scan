# claude-scan Implementation Plan

## 1. Foundation & Types
- [x] types.ts — status enum, interfaces (ScanState, FileEntry, ScanConfig, etc.), constants (CODE_EXTENSIONS, DEFAULT_IGNORE_PATTERNS, DEFAULTS)
- [x] prompt.ts — load prompt template from file, replace {{FILE_PATH}} and {{REPORT_PATH}} placeholders
- [x] Test: prompt template loading and substitution

## 2. Preflight Checks
- [x] preflight.ts — checkClaudeInstalled (which claude), checkClaudeAuth (claude auth status), checkTargetDir, lock file create/check/remove
- [x] Test: lock file creation, stale lock detection, target dir validation

## 3. File Discovery
- [x] discovery.ts — isGitRepo, gitFiles (git ls-files), globFiles (recursive walk), extension filter, size filter, binary detection, user include/exclude
- [x] Test: extension filtering, ignore patterns, size filtering, binary detection, matchGlob

## 4. State Management
- [x] state.ts — initState, loadState, saveState (atomic: write tmp → fsync → rename), resetStaleRunning, recomputeStats, version check
- [x] Test: atomic write safety, state round-trip, resume logic (RUNNING → PENDING reset), stats recomputation

## 5. Worker (single Claude process)
- [x] worker.ts — spawnClaude (child_process.spawn with all flags), output streaming to log file, timeout timer, hang detection, exit code handling, report file existence check
- [x] Test: timeout kills process, exit code classification (success/failure/timeout)

## 6. Worker Pool
- [x] worker-pool.ts — EventEmitter, manages queue of pending files, spawns up to N workers, on worker done → dequeue next, adaptive concurrency on rate limit, drain + idle detection
- [x] Test: concurrency limiting, queue drain, worker reuse after completion

## 7. Progress Display
- [x] progress.ts — TTY mode (in-place update: progress bar, per-worker status, findings count, elapsed/ETA) vs non-TTY mode (simple log lines)
- [x] Test: non-TTY log line formatting

## 8. Report Aggregator
- [x] reporter.ts — scan all report files, parse findings count/severity, generate summary.md, sort by severity
- [x] Test: summary generation from fixture report files

## 9. Scanner Orchestrator
- [x] scanner.ts — ties everything together: preflight → discovery → state init/resume → pool start → wait → aggregate → cleanup lock
- [x] Test: dry-run mode returns file list without scanning

## 10. CLI Entry Point
- [x] cli.ts — parse args (target-dir, --parallel, --timeout, --resume, --include, --exclude, --output, --model, --max-turns, --max-file-size, --retries, --dry-run, --prompt, --verbose, --force), call scanner, handle top-level errors, exit codes
- [x] Test: arg parsing, --help output, missing target error

## 11. Signal Handling
- [x] Wire SIGINT/SIGTERM into scanner.ts: 1st Ctrl+C → stop queue, wait for running. 2nd Ctrl+C → kill all, save state, exit(130)
- [ ] Test: verify state is saved on simulated shutdown (covered by pool killAll test)

## 12. Integration & Polish
- [ ] End-to-end test: scan a tiny fixture project with a mock claude script
- [ ] README.md
- [ ] Final commit, verify npm pack produces clean tarball
