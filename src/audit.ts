import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_FILE, defaultConfig } from "./scaffold/config.js";

export interface AuditCheck {
  id: string;
  label: string;
  passed: boolean;
  hint?: string;
}

export interface AuditReport {
  root: string;
  checks: AuditCheck[];
  score: number;
  total: number;
  grade: string;
  passed: boolean;
}

const TEST_SCRIPT_KEYS = ["test", "vitest", "jest"];

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function gradeFor(score: number, total: number): string {
  const pct = total === 0 ? 0 : (score / total) * 100;
  if (pct >= 90) return "A";
  if (pct >= 75) return "B";
  if (pct >= 60) return "C";
  if (pct >= 40) return "D";
  return "F";
}

/**
 * Score how ready a repository is for autonomous coding agents. The checks are
 * intentionally file-based so the audit works on any language or stack.
 */
export async function audit(root: string, _pkgRoot: string): Promise<AuditReport> {
  const pkg = readJson(join(root, "package.json"));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;

  const hasAgentsMd =
    existsSync(join(root, "AGENTS.md")) || existsSync(join(root, "CLAUDE.md"));
  const hasReadme = existsSync(join(root, "README.md"));
  const hasTests =
    existsSync(join(root, "test")) ||
    existsSync(join(root, "tests")) ||
    existsSync(join(root, "__tests__")) ||
    TEST_SCRIPT_KEYS.some((k) => typeof scripts[k] === "string");
  const hasCi =
    existsSync(join(root, ".github", "workflows")) ||
    existsSync(join(root, ".gitlab-ci.yml")) ||
    existsSync(join(root, ".circleci"));
  const hasLint = ["lint", "eslint", "biome"].some((k) => typeof scripts[k] === "string");
  const hasLockfile = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "uv.lock",
    "poetry.lock",
    "Cargo.lock",
    "go.sum",
  ].some((f) => existsSync(join(root, f)));
  const hasEnvExample =
    existsSync(join(root, ".env.example")) || existsSync(join(root, ".env.sample"));
  const hasSkill = existsSync(join(root, ".agents", "skills"));

  const config = readJson(join(root, CONFIG_FILE));

  const checks: AuditCheck[] = [
    {
      id: "agents-md",
      label: "AGENTS.md present (agent memory)",
      passed: hasAgentsMd,
      hint: "Run 'agentmaxxing init' to create AGENTS.md",
    },
    {
      id: "readme",
      label: "README.md present",
      passed: hasReadme,
      hint: "Add a README so agents understand the project",
    },
    {
      id: "tests",
      label: "Test suite or test script present",
      passed: hasTests,
      hint: "Add tests; agents verify their own changes with them",
    },
    {
      id: "ci",
      label: "CI configuration present",
      passed: hasCi,
      hint: "Add a CI workflow so agent changes are checked automatically",
    },
    {
      id: "lint",
      label: "Lint script present",
      passed: hasLint,
      hint: "Add a lint script to catch agent style drift",
    },
    {
      id: "lockfile",
      label: "Dependency lockfile present",
      passed: hasLockfile,
      hint: "Commit a lockfile for reproducible agent installs",
    },
    {
      id: "env-example",
      label: "Example env file present (.env.example)",
      passed: hasEnvExample,
      hint: "Document required env vars without committing secrets",
    },
    {
      id: "skill",
      label: "Reusable agent skill installed (.agents/skills)",
      passed: hasSkill,
      hint: "Run 'agentmaxxing skills add <name>'",
    },
    {
      id: "config",
      label: "agentmaxxing.config.json present",
      passed: config !== undefined,
      hint: "Run 'agentmaxxing init' to add the config",
    },
  ];

  const score = checks.filter((c) => c.passed).length;
  const total = checks.length;
  const failBelow = 60;

  return {
    root,
    checks,
    score,
    total,
    grade: gradeFor(score, total),
    passed: (score / total) * 100 >= failBelow,
  };
}
