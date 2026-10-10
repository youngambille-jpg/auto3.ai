import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSkillFrontmatter,
  renderAgentsMd,
  renderConfig,
  defaultConfig,
  listSkills,
  installSkill,
  audit,
} from "../dist/index.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "agentmaxxing-"));
}

test("parseSkillFrontmatter reads name and description", () => {
  const source = `---\nname: demo\ndescription: Does a thing.\n---\n\n# Demo\n`;
  const info = parseSkillFrontmatter(source);
  assert.equal(info.name, "demo");
  assert.equal(info.description, "Does a thing.");
});

test("parseSkillFrontmatter tolerates missing frontmatter", () => {
  const info = parseSkillFrontmatter("# No frontmatter here\n");
  assert.equal(info.name, "unknown");
  assert.equal(info.description, "");
});

test("renderAgentsMd produces a usable template", () => {
  const md = renderAgentsMd();
  assert.match(md, /# AGENTS\.md/);
  assert.match(md, /## Setup/);
  assert.match(md, /## Conventions/);
});

test("renderConfig is valid JSON with the documented shape", () => {
  const parsed = JSON.parse(renderConfig());
  assert.deepEqual(parsed, defaultConfig());
  assert.equal(parsed.skills.dir, ".agents/skills");
});

test("listSkills finds the bundled skills", async () => {
  const skills = await listSkills();
  const names = skills.map((s) => s.name);
  assert.ok(names.includes("commit-conventions"), `got ${names.join(", ")}`);
  assert.ok(names.includes("agent-readiness"), `got ${names.join(", ")}`);
  assert.ok(skills.every((s) => s.description.length > 0));
});

test("installSkill copies a bundled skill into the repo", async () => {
  const root = await tempDir();
  const result = await installSkill(root, "commit-conventions");
  assert.equal(result.created, true);
  assert.ok(existsSync(join(root, ".agents", "skills", "commit-conventions", "SKILL.md")));

  // Second install is a no-op without --force.
  const again = await installSkill(root, "commit-conventions");
  assert.equal(again.created, false);
});

test("installSkill rejects unknown skills", async () => {
  const root = await tempDir();
  await assert.rejects(() => installSkill(root, "does-not-exist"), /Unknown skill/);
});

test("audit scores an empty repository as not ready", async () => {
  const root = await tempDir();
  const report = await audit(root, root);
  assert.equal(report.score, 0);
  assert.equal(report.passed, false);
  assert.equal(report.grade, "F");
});

test("audit scores a maxxed repository higher", async () => {
  const root = await tempDir();
  await writeFile(join(root, "AGENTS.md"), renderAgentsMd());
  await writeFile(join(root, "README.md"), "# demo\n");
  await writeFile(join(root, "agentmaxxing.config.json"), renderConfig());
  await writeFile(join(root, "package-lock.json"), "{}");
  await writeFile(join(root, ".env.example"), "TOKEN=\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
  );
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await installSkill(root, "commit-conventions");

  const report = await audit(root, root);
  assert.equal(report.score, report.total);
  assert.equal(report.grade, "A");
  assert.equal(report.passed, true);
});
