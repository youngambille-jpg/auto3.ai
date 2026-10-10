/**
 * Minimal .env loader (no dependency). Imported first so configuration read at
 * module load sees the values. Existing process.env entries win.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const root = resolve(process.cwd());
loadFile(resolve(root, ".env"));
loadFile(resolve(root, ".env.local"));
