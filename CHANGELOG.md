# Changelog

## 1.1.0

- Added `--retry` flag: re-runs failed/timed-out files on `--resume`
- Added `--include-tests` flag: scan test files (excluded by default)
- Added `--summarize` flag: re-generate AI summary from existing reports
- Added AI-powered summary: spawns a final Claude process to deduplicate issues across files, ranked by severity
- Added auto-pause on rate limit: parses reset time from Claude's error message, pauses the scan, auto-resumes at the reset time
- Added interactive resume prompt when incomplete scan is detected
- Support multiple `--include` and `--exclude` flags
- Default to current directory when no target given
- Default `--parallel` increased from 4 to 12
- Default `--timeout` increased from 5 min to 30 min
- Exit hints show resume/retry commands when files are incomplete
- Re-run discovery on `--resume` to merge new files and prune excluded ones
- Fixed: `--bare` broke claude.ai authentication (removed)
- Fixed: hang detection false-positive with `--output-format json` (only runs with `--verbose` now)
- Fixed: progress display stacking after terminal resize
- Fixed: JSON `is_error` field now properly detected (was silently exiting 0)
- Fixed: rate limit message format changed — now detects "hit your limit", "usage limit", etc.

## 1.0.0

- Initial release
- Parallel vulnerability scanner powered by Claude Code
- Implements the scanning scaffold from Nicholas Carlini's [un]prompted 2026 talk
- Per-file vulnerability reports, atomic state persistence, crash recovery with `--resume`
- Programmatic file filtering (git ls-files + extension/size/binary detection)
- Terminal progress UI with per-worker status
