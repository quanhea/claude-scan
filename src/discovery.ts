// src/discovery.ts — find files to scan (programmatic, no LLM)
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { CODE_EXTENSIONS, DEFAULT_IGNORE_PATTERNS } from "./types";

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
}

export function discoverFiles(
  targetDir: string,
  options: DiscoveryOptions = {},
): string[] {
  const { include = null, exclude = null, maxFileSizeKB = 100 } = options;
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
