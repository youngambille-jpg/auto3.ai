import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root, used to locate the bundled `skills/` directory. */
export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BUNDLED_DIR = join(PKG_ROOT, "skills");

export interface SkillInfo {
  name: string;
  description: string;
}

export interface InstallResult {
  name: string;
  /** Absolute path of the installed SKILL.md. */
  path: string;
  /** Path relative to the target repo root. */
  relative: string;
  created: boolean;
}

/** Parse the YAML-ish frontmatter that Agent Skills files start with. */
export function parseSkillFrontmatter(source: string): SkillInfo {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  const fields: Record<string, string> = {};
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const sep = line.indexOf(":");
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim();
      const value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, "");
      fields[key] = value;
    }
  }
  return {
    name: fields.name ?? "unknown",
    description: fields.description ?? "",
  };
}

/** List the skills bundled with this package. */
export async function listSkills(): Promise<SkillInfo[]> {
  if (!existsSync(BUNDLED_DIR)) return [];
  const entries = await readdir(BUNDLED_DIR, { withFileTypes: true });
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(BUNDLED_DIR, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const info = parseSkillFrontmatter(await readFile(skillFile, "utf8"));
    skills.push({ name: info.name || entry.name, description: info.description });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Install a bundled skill into `<root>/.agents/skills/<name>`. */
export async function installSkill(
  root: string,
  name: string,
  force = false,
): Promise<InstallResult> {
  const source = join(BUNDLED_DIR, name);
  if (!existsSync(join(source, "SKILL.md"))) {
    const available = (await listSkills()).map((s) => s.name).join(", ") || "none";
    throw new Error(`Unknown skill '${name}'. Available skills: ${available}`);
  }

  const destDir = join(root, ".agents", "skills", name);
  const destFile = join(destDir, "SKILL.md");
  const created = force || !existsSync(destFile);

  if (created) {
    await mkdir(destDir, { recursive: true });
    await cp(source, destDir, { recursive: true, force: true });
  }

  return {
    name,
    path: destFile,
    relative: relative(root, destFile),
    created,
  };
}
