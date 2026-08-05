# @NekoSekaiMoe/pi-init

An explicit `/init` command for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It starts an agent turn that inspects the current repository and creates a concise, repository-specific `AGENTS.md` contributor guide.

## Why

An initialization skill only runs when the model notices and chooses to invoke it. This extension turns the workflow into a visible command: `/init` injects the complete generation request as a user message, which immediately starts an agent turn and makes the instructions visible in the transcript.

## Installation

```bash
pi install npm:@NekoSekaiMoe/pi-init
```

For local development from this package directory:

```bash
pi -e ./src/index.ts
```

## Usage

```text
/init
/init also document the CI and release process
```

Everything after `/init` is appended to the prompt under an `Additional instructions` heading. Use this to request project-specific sections, emphasis, or constraints.

## Generated guide

The built-in prompt asks the agent to:

1. Check for `AGENTS.md` in the current working directory and stop without modifying it if it already exists.
2. Inspect the repository rather than guessing: package manifests, source layout, configuration, CI, existing documentation, and Git history are all potential evidence.
3. Create `AGENTS.md` with the title **Repository Guidelines**.
4. Document the project structure, development commands, coding conventions, testing practices, and commit/PR expectations when applicable.
5. Add or omit sections according to the actual repository.
6. Keep the result direct and actionable, with roughly 200–400 words as the default target.

The prompt may also include architecture, security, configuration, or agent-specific guidance when those topics are relevant.

## How it works

The extension registers `/init` with `pi.registerCommand()`. The handler trims the command arguments, appends any extra instructions to a constant prompt, and calls:

```ts
pi.sendUserMessage(prompt);
```

`sendUserMessage()` triggers the agent turn. The extension itself does not scan the repository or write `AGENTS.md`; the active model performs that work using the tools available in the current Pi session.

## Important boundary

The “do not overwrite an existing `AGENTS.md`” rule is a prompt-level safeguard, not a filesystem guard implemented by this extension. The active agent is responsible for checking the file and following the instruction. Review model actions when working in repositories where overwrites would be costly.

Likewise, additional text after `/init` is inserted verbatim into the generation request. Treat it as instructions to the active agent, not as configuration parsed or validated by the extension.

## Source

```text
src/index.ts   command registration and AGENTS.md generation prompt
package.json   Pi extension entry point and npm metadata
```

Pi loads the TypeScript source directly; there is no build step.

## License

BSD-2-Clause.
