/**
 * Render a starter AGENTS.md. Coding agents (OpenHands, Claude Code, Codex,
 * Cursor, Copilot, ...) read this file as durable repository memory, so the
 * template focuses on the facts an agent cannot infer from the code itself.
 */
export function renderAgentsMd(): string {
  return `# AGENTS.md

This file is the persistent memory for AI coding agents working in this
repository. Keep it short, factual and up to date.

## Project overview

- What this project is: <one or two sentences>
- Primary language / runtime: <e.g. TypeScript on Node.js 20>
- Package manager: <npm | pnpm | yarn | bun>

## Setup

\`\`\`bash
# install dependencies
npm install

# run the app / build
npm run build

# run tests
npm test
\`\`\`

## Repository layout

- \`src/\` - application source
- \`test/\` - automated tests
- \`docs/\` - design notes and runbooks

## Conventions

- Match the surrounding code style; do not reformat unrelated files.
- Prefer small, focused changes with tests for new behaviour.
- Never commit secrets, credentials or generated build output.

## Do not touch

- <files or directories agents should leave alone>

## How to verify a change

1. \`npm test\` passes.
2. \`npm run build\` succeeds.
3. New behaviour is covered by a test.
`;
}
