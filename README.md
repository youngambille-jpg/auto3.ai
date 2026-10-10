# agentmaxxing

Maxx your AI coding agents.

`agentmaxxing` is a zero-dependency CLI that gets any repository ready for
autonomous coding agents. It scaffolds the durable memory agents read
(`AGENTS.md`), installs reusable agent skills, and audits how agent-ready a repo
is.

Works with any stack and any agent that reads `AGENTS.md` and skills
(OpenHands, Claude Code, Codex, Cursor, Copilot, and others).

## Install

```bash
# run without installing
npx agentmaxxing init

# or install globally
npm install -g agentmaxxing
```

Requires Node.js 18 or newer.

## Commands

### `agentmaxxing init`

Scaffolds the basics in the current directory:

- `AGENTS.md` - persistent memory for coding agents (setup, layout, conventions)
- `agentmaxxing.config.json` - configuration
- `.agents/skills/commit-conventions/SKILL.md` - a starter skill

Existing files are kept unless you pass `--force`.

### `agentmaxxing skills`

```bash
agentmaxxing skills              # list bundled skills
agentmaxxing skills add <name>   # install a skill into .agents/skills/<name>
```

Bundled skills:

| Skill | Purpose |
| :--- | :--- |
| `commit-conventions` | Conventional Commits and atomic commits |
| `agent-readiness` | Keep a repo easy for agents to work in |

### `agentmaxxing audit`

Scores how agent-ready the repository is, from `F` to `A`:

```text
$ agentmaxxing audit

agentmaxxing audit: /path/to/repo

  [x] AGENTS.md present (agent memory)
  [x] README.md present
  [x] Test suite or test script present
  [ ] CI configuration present
      hint: Add a CI workflow so agent changes are checked automatically
  ...

Score: 7/9 (B)
```

The audit exits non-zero below the configured `audit.failBelow` percentage, so
you can run it in CI.

## Options

| Flag | Description |
| :--- | :--- |
| `-d, --dir <path>` | Target directory (default: current working directory) |
| `-f, --force` | Overwrite existing files |
| `-q, --quiet` | Suppress non-essential output |
| `-v, --version` | Print the version |
| `-h, --help` | Print help |

## Programmatic use

```ts
import { audit, installSkill, renderAgentsMd } from "agentmaxxing";

await installSkill(process.cwd(), "commit-conventions");
const report = await audit(process.cwd(), process.cwd());
console.log(report.grade);
```

## What "agent-ready" means

Agents succeed when they can understand a repo without guessing and verify their
own work. `agentmaxxing` checks the concrete facts that make that possible:

- durable memory (`AGENTS.md`)
- a README
- a test suite or test script
- CI
- a lint script
- a committed lockfile
- a documented `.env.example`
- an installed reusable skill
- the `agentmaxxing` config

## Development

```bash
npm install
npm test        # builds, then runs the test suite
npm run build   # compile TypeScript to dist/
```

## License

MIT
