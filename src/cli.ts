#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderAgentsMd } from "./scaffold/agentsmd.js";
import { renderConfig, CONFIG_FILE } from "./scaffold/config.js";
import { listSkills, installSkill } from "./skills.js";
import { audit } from "./audit.js";

const VERSION = "0.1.0";
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `agentmaxxing v${VERSION} - maxx your AI coding agents

Usage:
  agentmaxxing <command> [options]

Commands:
  init                 Scaffold AGENTS.md, agentmaxxing.config.json and a starter skill
  skills [list]        List bundled skills, or 'skills add <name>' to install one
  audit                Check how agent-ready the current repository is
  help                 Show this help

Options:
  -d, --dir <path>     Target directory (default: current working directory)
  -f, --force          Overwrite files that already exist
  -q, --quiet          Suppress non-essential output
  -v, --version        Print version
  -h, --help           Print help

Examples:
  npx agentmaxxing init
  npx agentmaxxing skills add commit-conventions
  npx agentmaxxing audit --dir ./my-repo
`;

interface Options {
  dir: string;
  force: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): { command: string; rest: string[]; options: Options } {
  const options: Options = { dir: process.cwd(), force: false, quiet: false };
  const rest: string[] = [];
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-d":
      case "--dir":
        options.dir = resolve(argv[++i] ?? process.cwd());
        break;
      case "-f":
      case "--force":
        options.force = true;
        break;
      case "-q":
      case "--quiet":
        options.quiet = true;
        break;
      case "-h":
      case "--help":
        rest.push("help");
        break;
      case "-v":
      case "--version":
        rest.push("version");
        break;
      default:
        if (!command) command = arg;
        else rest.push(arg);
    }
  }
  return { command: command || rest.shift() || "help", rest, options };
}

async function writeFileSafe(path: string, contents: string, force: boolean): Promise<boolean> {
  if (existsSync(path) && !force) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  return true;
}

async function commandInit(options: Options): Promise<number> {
  const log = (msg: string) => !options.quiet && console.log(msg);
  const root = options.dir;

  log(`agentmaxxing: maxxing agents in ${root}`);

  const agentsMd = join(root, "AGENTS.md");
  if (await writeFileSafe(agentsMd, renderAgentsMd(), options.force)) log("  + AGENTS.md");
  else log("  = AGENTS.md (kept)");

  const config = join(root, CONFIG_FILE);
  if (await writeFileSafe(config, renderConfig(), options.force)) log(`  + ${CONFIG_FILE}`);
  else log(`  = ${CONFIG_FILE} (kept)`);

  const skill = await installSkill(root, "commit-conventions", options.force);
  log(`  ${skill.created ? "+" : "="} ${skill.relative}${skill.created ? "" : " (kept)"}`);

  log("Done. Run 'agentmaxxing audit' to score the repo.");
  return 0;
}

async function commandSkills(rest: string[], options: Options): Promise<number> {
  const [sub, name] = rest;
  if (sub === "add") {
    if (!name) {
      console.error("Usage: agentmaxxing skills add <name>");
      return 1;
    }
    const result = await installSkill(options.dir, name, options.force);
    console.log(`Installed skill '${name}' -> ${result.relative}`);
    return 0;
  }

  const skills = await listSkills();
  if (skills.length === 0) {
    console.log("No bundled skills found.");
    return 0;
  }
  console.log("Bundled skills:");
  for (const skill of skills) {
    console.log(`  ${skill.name.padEnd(22)} ${skill.description}`);
  }
  console.log("\nInstall one with: agentmaxxing skills add <name>");
  return 0;
}

async function commandAudit(options: Options): Promise<number> {
  const report = await audit(options.dir, PKG_ROOT);
  console.log(`agentmaxxing audit: ${options.dir}\n`);
  for (const check of report.checks) {
    console.log(`  [${check.passed ? "x" : " "}] ${check.label}`);
    if (!check.passed && check.hint) console.log(`      hint: ${check.hint}`);
  }
  console.log(`\nScore: ${report.score}/${report.total} (${report.grade})`);
  return report.passed ? 0 : 1;
}

async function main(): Promise<number> {
  const { command, rest, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "init":
      return commandInit(options);
    case "skills":
      return commandSkills(rest, options);
    case "audit":
      return commandAudit(options);
    case "version":
      console.log(VERSION);
      return 0;
    case "help":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
