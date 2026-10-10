---
name: commit-conventions
description: Write clear, conventional commit messages and keep commits atomic. Use when committing changes, splitting work into commits, or writing commit messages.
---

# Commit conventions

Follow these rules when creating commits in this repository.

## Format

Use the Conventional Commits format:

```
<type>(<scope>): <short summary>

<body>

<footer>
```

- `type` is one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
  `test`, `build`, `ci`, `chore`.
- `scope` is optional and names the area touched (for example `cli`, `api`).
- `summary` is imperative, lower case, no trailing period, at most 72 chars.

## Atomic commits

- One logical change per commit. If a change touches unrelated areas, split it.
- Never mix formatting-only changes with behaviour changes.
- Each commit should leave the tree in a working state (tests pass).

## Body and footer

- Explain *why*, not *what* (the diff shows the what).
- Reference issues in the footer, for example `Refs: #123`.

## Checklist before committing

1. `git status` shows only the files you intend to commit.
2. No secrets, credentials or build output are staged.
3. Tests and lint pass.
