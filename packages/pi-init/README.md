# @NekoSekaiMoe/pi-init

Adds an `/init` command to the [Pi coding agent](https://github.com/badlogic/pi-mono) that generates a high-quality `AGENTS.md` contributor guide for the current repository. It also exposes `apply_patch` as an exact-replacement editing tool compatible with Pi's built-in `edit`.

## Why

Pi's default `init` behavior is an auto-invoked skill (`~/.pi/agent/skills/init/SKILL.md`) — the model has to notice and choose to run it. This extension turns it into an explicit `/init` command. The generation instructions are injected as a user message (which always triggers a turn), so the agent starts immediately and you see exactly what was asked.

## What it does

Registers an `/init` command that prompts the agent to:

- Analyze the codebase autonomously and generate `AGENTS.md` titled **Repository Guidelines**.
- Skip and report if `AGENTS.md` already exists (never overwrites).
- Cover the standard outline: project structure, build/test commands, coding style, testing guidelines, and commit/PR conventions — verified against actual project files, not invented.
- Keep it concise (200–400 words).

## Install

```bash
# From npm
pi install npm:@NekoSekaiMoe/pi-init

# Local development
pi -e ./src/index.ts
```

## Usage

```
/init                        generate AGENTS.md with the default outline
/init also document the CI   append extra instructions to the prompt
```

Anything after `/init` is appended to the generation prompt as additional instructions.

## `apply_patch` tool

The package registers an LLM-callable `apply_patch` tool with the same parameter
schema, exact-replacement behavior, file mutation queue, and result renderer as
Pi's built-in `edit`. The alias is useful for agents whose editing instructions
expect an `apply_patch`-named tool; it accepts `path` plus one or more
`edits[].oldText` / `edits[].newText` replacements rather than unified diff text.

## License

BSD-2-Clause
