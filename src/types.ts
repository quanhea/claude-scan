// src/types.ts — shared constants, enums, and type definitions

export const STATUS = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  TIMEOUT: "TIMEOUT",
  INTERRUPTED: "INTERRUPTED",
  SKIPPED: "SKIPPED",
} as const;

export type FileStatus = (typeof STATUS)[keyof typeof STATUS];

export const STATE_VERSION = 1;

export interface FileEntry {
  status: FileStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  reportPath?: string | null;
  findings?: number;
  exitCode?: number | null;
  lastError?: string;
}

export interface ScanStats {
  totalFiles: number;
  completed: number;
  failed: number;
  timeout: number;
  skipped: number;
  pending: number;
  running: number;
}

export interface ScanConfig {
  parallel: number;
  timeout: number;
  maxRetries: number;
  maxTurns: number;
  maxFileSizeKB: number;
  model: string | null;
  prompt: string;
  verbose: boolean;
}

export interface ScanState {
  version: number;
  scanId: string;
  targetDir: string;
  startedAt: string;
  config: ScanConfig;
  stats: ScanStats;
  files: Record<string, FileEntry>;
}

export interface WorkerResult {
  file: string;
  status: FileStatus;
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

export interface ScanOptions {
  targetDir: string;
  outputDir: string;
  parallel: number;
  timeout: number;
  maxRetries: number;
  maxTurns: number;
  maxFileSizeKB: number;
  model: string | null;
  promptFile: string | null;
  include: string | null;
  exclude: string | null;
  includeTests: boolean;
  summarize: boolean;
  resume: boolean;
  retry: boolean;
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
}

// Extensions considered source code
export const CODE_EXTENSIONS = new Set([
  // Systems
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".c++", ".h++",
  // Web / Scripting
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".php", ".html", ".htm", ".css", ".scss", ".sql", ".graphql",
  ".erb", ".ejs", ".hbs", ".twig",
  // JVM / Managed
  ".java", ".kt", ".kts", ".scala", ".groovy", ".cs", ".clj", ".cljs",
  // Other
  ".go", ".rs", ".swift", ".rb", ".py", ".pl", ".pm", ".lua",
  ".zig", ".nim", ".ex", ".exs", ".sol", ".r",
  ".sh", ".bash", ".zsh", ".fish",
  ".yaml", ".yml", ".toml", ".xml", ".conf", ".cfg", ".ini",
  ".tf", ".hcl",
]);

// Paths always excluded (on top of .gitignore)
export const DEFAULT_IGNORE_PATTERNS = [
  "node_modules/", "__pycache__/", ".venv/", "vendor/",
  "dist/", "build/", "target/", "out/",
  ".next/", ".nuxt/", "coverage/", ".git/",
  ".claude-scan/",
  "*.min.js", "*.bundle.js", "*.map",
  "*.generated.*", "*.pb.go", "*_generated.*",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "go.sum", "Cargo.lock", "Gemfile.lock",
  "poetry.lock", "composer.lock", "Pipfile.lock",
];

// Test file patterns — excluded by default, opt in with --include-tests
export const DEFAULT_TEST_PATTERNS = [
  // Directories
  "test/", "tests/", "__tests__/", "__test__/",
  "spec/", "specs/", "_tests/", "_test/",
  "testing/", "e2e/", "cypress/", "playwright/",
  "fixtures/", "__fixtures__/", "__mocks__/",
  "testdata/", "test-data/", "test_data/",
  // JS/TS suffixes
  "*.test.ts", "*.test.js", "*.test.tsx", "*.test.jsx", "*.test.mjs", "*.test.cjs",
  "*.spec.ts", "*.spec.js", "*.spec.tsx", "*.spec.jsx", "*.spec.mjs", "*.spec.cjs",
  // Other language suffixes
  "*_test.go", "*_test.py", "*_test.rb", "*_test.rs",
  "*_test.c", "*_test.cpp", "*_test.exs",
  "*_spec.rb", "*.spec.lua",
  // Python prefix
  "test_*.py",
  // Exact filenames
  "conftest.py",
];

// JVM test patterns need basename matching (not extension-based)
export const JVM_TEST_PATTERNS = {
  suffixes: ["Test.java", "Tests.java", "Test.kt", "Tests.kt", "Test.scala"],
  prefixes: ["Test"],
  extensions: [".java", ".kt", ".scala"],
};

export const DEFAULTS: ScanConfig & { maxFileSizeKB: number } = {
  parallel: 4,
  timeout: 300,
  maxRetries: 2,
  maxTurns: 30,
  maxFileSizeKB: 100,
  model: null,
  prompt: "scan.md",
  verbose: false,
};
