# claude-scan Implementation Plan

## 1. Foundation & Types
- [x] types.ts — status enum, interfaces (ScanState, FileEntry, ScanConfig, etc.), constants (CODE_EXTENSIONS, DEFAULT_IGNORE_PATTERNS, DEFAULTS)
- [ ] prompt.ts — load prompt template from file, replace {{FILE_PATH}} and {{REPORT_PATH}} placeholders
- [ ] Test: prompt template loading and substitution

## 2. Preflight Checks
- [ ] preflight.ts — checkClaudeInstalled (which claude), checkClaudeAuth (claude auth status), checkTargetDir, lock file create/check/remove
- [ ] Test: lock file creation, stale lock detection, target dir validation

## 3. File Discovery
- [ ] discovery.ts — isGitRepo, gitFiles (git ls-files), globFiles (recursive walk), extension filter, size filter, binary detection, user include/exclude
- [ ] Test: extension filtering, ignore patterns, size filtering, binary detection, matchGlob

## 4. State Management
- [ ] state.ts — initState, loadState, saveState (atomic: write tmp → fsync → rename), resetStaleRunning, recomputeStats, version check
- [ ] Test: atomic write safety, state round-trip, resume logic (RUNNING → PENDING reset), stats recomputation

## 5. Worker (single Claude process)
- [ ] worker.ts — spawnClaude (child_process.spawn with all flags), output streaming to log file, timeout timer, hang detection, exit code handling, report file existence check
- [ ] Test: timeout kills process, exit code classification (success/failure/timeout)

## 6. Worker Pool
- [ ] worker-pool.ts — EventEmitter, manages queue of pending files, spawns up to N workers, on worker done → dequeue next, adaptive concurrency on rate limit, drain + idle detection
- [ ] Test: concurrency limiting, queue drain, worker reuse after completion

## 7. Progress Display
- [ ] progress.ts — TTY mode (in-place update: progress bar, per-worker status, findings count, elapsed/ETA) vs non-TTY mode (simple log lines)
- [ ] Test: non-TTY log line formatting

## 8. Report Aggregator
- [ ] reporter.ts — scan all report files, parse findings count/severity, generate summary.md, sort by severity
- [ ] Test: summary generation from fixture report files

## 9. Scanner Orchestrator
- [ ] scanner.ts — ties everything together: preflight → discovery → state init/resume → pool start → wait → aggregate → cleanup lock
- [ ] Test: dry-run mode returns file list without scanning

## 10. CLI Entry Point
- [ ] cli.ts — parse args (target-dir, --parallel, --timeout, --resume, --include, --exclude, --output, --model, --max-turns, --max-file-size, --retries, --dry-run, --prompt, --verbose, --force), call scanner, handle top-level errors, exit codes
- [ ] Test: arg parsing, --help output, missing target error

## 11. Signal Handling
- [ ] Wire SIGINT/SIGTERM into scanner.ts: 1st Ctrl+C → stop queue, wait for running. 2nd Ctrl+C → kill all, save state, exit(130)
- [ ] Test: verify state is saved on simulated shutdown

## 12. Integration & Polish
- [ ] End-to-end test: scan a tiny fixture project with a mock claude script
- [ ] README.md
- [ ] Final commit, verify npm pack produces clean tarball
