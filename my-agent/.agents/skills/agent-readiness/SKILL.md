---
name: agent-readiness
description: Keep a repository easy for autonomous coding agents to work in. Use when setting up a new project, improving agent success rate, or reviewing whether a repo is agent-ready.
---

# Agent readiness

Agents succeed or fail based on how much of the repository they can understand
without guessing. Keep these invariants true.

## Durable memory

- Keep `AGENTS.md` current: setup commands, layout, conventions, and what not to
  touch. Update it in the same change that alters those facts.
- Prefer facts an agent cannot infer from the code (why a choice was made).

## Fast, deterministic verification

- Provide one command that runs the full test suite and one that lints.
- Tests must be deterministic and offline; no network or real credentials.
- A failing command should print the exact command to reproduce it.

## Safe defaults

- Document required environment variables in `.env.example`, never real values.
- Keep secrets out of the tree and out of logs.
- Make destructive operations explicit and guarded.

## Small, reviewable changes

- One concern per change; do not reformat unrelated files.
- Leave the tree green: build, tests and lint pass before finishing.

## Audit

Run `agentmaxxing audit` and aim for a score of A. Fix the lowest-scoring checks
first; each check maps to a concrete repository fact.
