// src/discovery.ts — find files to scan (programmatic, no LLM)
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { CODE_EXTENSIONS, DEFAULT_IGNORE_PATTERNS, DEFAULT_TEST_PATTERNS, JVM_TEST_PATTERNS } from "./types";

export function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function gitFiles(dir: string): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: dir, stdio: "pipe" });
  return out
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
}

function walkDir(dir: string, base: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      if (matchesIgnore(rel + "/")) continue;
      results.push(...walkDir(full, base));
    } else if (entry.isFile()) {
      if (!matchesIgnore(rel)) results.push(rel);
    }
  }
  return results;
}

export function matchesIgnore(relPath: string): boolean {
  for (const pattern of DEFAULT_IGNORE_PATTERNS) {
    if (pattern.endsWith("/")) {
      // Directory pattern — matches if any segment matches
      const dir = pattern.slice(0, -1);
      const segments = relPath.split(path.sep);
      if (segments.some((s) => s === dir)) return true;
    } else if (pattern.startsWith("*.")) {
      // Extension glob
      if (relPath.endsWith(pattern.slice(1))) return true;
    } else if (pattern.startsWith("*") && pattern.endsWith("*")) {
      // Contains pattern
      const inner = pattern.slice(1, -1);
      if (relPath.includes(inner)) return true;
    } else {
      // Exact filename match
      if (path.basename(relPath) === pattern) return true;
    }
  }
  return false;
}

export function isBinary(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function matchesTestPattern(relPath: string): boolean {
  const basename = path.basename(relPath);
  const segments = relPath.split(path.sep);

  for (const pattern of DEFAULT_TEST_PATTERNS) {
    if (pattern.endsWith("/")) {
      // Directory pattern
      const dir = pattern.slice(0, -1);
      if (segments.some((s) => s === dir)) return true;
    } else if (pattern.startsWith("*.") && pattern.indexOf(".", 2) !== -1) {
      // Multi-extension suffix: *.test.ts, *.spec.js
      const suffix = pattern.slice(1); // .test.ts
      if (basename.endsWith(suffix)) return true;
    } else if (pattern.startsWith("*") && !pattern.startsWith("*.")) {
      // Suffix on basename: *_test.go, *_spec.rb
      const suffix = pattern.slice(1);
      if (basename.endsWith(suffix)) return true;
    } else if (pattern.includes("*")) {
      // Prefix pattern: test_*.py
      const [prefix, ext] = pattern.split("*");
      if (basename.startsWith(prefix) && basename.endsWith(ext)) return true;
    } else {
      // Exact filename
      if (basename === pattern) return true;
    }
  }

  // JVM patterns: FooTest.java, FooTests.kt, TestFoo.java
  const ext = path.extname(basename);
  if (JVM_TEST_PATTERNS.extensions.includes(ext)) {
    const name = basename.slice(0, -ext.length);
    for (const suffix of JVM_TEST_PATTERNS.suffixes) {
      const suf = suffix.slice(0, -ext.length); // "Test", "Tests"
      if (name.endsWith(suf)) return true;
    }
    for (const prefix of JVM_TEST_PATTERNS.prefixes) {
      if (name.startsWith(prefix) && name[prefix.length]?.match(/[A-Z]/)) return true;
    }
  }

  return false;
}

export function matchGlob(filePath: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    return filePath.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("/*")) {
    return filePath.startsWith(pattern.slice(0, -1));
  }
  if (pattern.endsWith("/**/*") || pattern.endsWith("/**")) {
    const prefix = pattern.replace(/\/\*\*\/?(\*)?$/, "");
    return filePath.startsWith(prefix);
  }
  return filePath.includes(pattern);
}

export interface DiscoveryOptions {
  include?: string | string[] | null;
  exclude?: string | string[] | null;
  maxFileSizeKB?: number;
  includeTests?: boolean;
}

export function discoverFiles(
  targetDir: string,
  options: DiscoveryOptions = {},
): string[] {
  const { include = null, exclude = null, maxFileSizeKB = 100, includeTests = false } = options;
  const absDir = path.resolve(targetDir);
  const useGit = isGitRepo(absDir);
  let files = useGit ? gitFiles(absDir) : [];
  // git ls-files returns empty for untracked dirs inside a repo — fall back
  if (files.length === 0) {
    files = walkDir(absDir, absDir);
  }

  // Filter out default ignore patterns (git ls-files respects .gitignore but
  // we have extra patterns like *.min.js, lock files, etc.)
  if (useGit) {
    files = files.filter((f) => !matchesIgnore(f));
  }

  // Extension filter
  files = files.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    if (path.basename(f).toLowerCase() === "dockerfile") return true;
    return CODE_EXTENSIONS.has(ext);
  });

  // Test file filter (default: exclude tests)
  if (!includeTests) {
    files = files.filter((f) => !matchesTestPattern(f));
  }

  // User --include
  if (include) {
    const patterns = Array.isArray(include) ? include : [include];
    files = files.filter((f) => patterns.some((p) => matchGlob(f, p)));
  }

  // User --exclude
  if (exclude) {
    const patterns = Array.isArray(exclude) ? exclude : [exclude];
    files = files.filter((f) => !patterns.some((p) => matchGlob(f, p)));
  }

  // Size filter
  files = files.filter((f) => {
    const full = path.join(absDir, f);
    try {
      const stat = fs.statSync(full);
      return stat.size <= maxFileSizeKB * 1024;
    } catch {
      return false;
    }
  });

  // Binary filter
  files = files.filter((f) => !isBinary(path.join(absDir, f)));

  files.sort();
  return files;
}
