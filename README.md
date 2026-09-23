# codex-cli-browser-bridge

An unsupported, experimental Linux launcher that makes the browser bridge from
an installed ChatGPT desktop app available to Codex CLI.

It does **not** copy, bundle, patch, or reverse-engineer credentials from the
ChatGPT app. It waits for the app to generate and start its own authenticated
`cua_repl` MCP bridge, enables Codex's `computer_use` feature, and launches the
normal `codex` executable.

## Status

Proof of concept. Tested locally with:

- ChatGPT desktop `26.915.31945` for Linux
- Codex CLI `0.156.1`
- the ChatGPT Chrome extension already installed and connected

This relies on undocumented implementation details and can break with any app
update. It is not affiliated with or supported by OpenAI.

## Requirements

- Linux
- Node.js 20 or newer
- ChatGPT desktop installed and signed in
- Codex CLI installed and signed in
- the ChatGPT Chrome extension installed and connected

The default app path is `/usr/lib/chatgpt/ChatGPT`. Override it with
`CHATGPT_BIN` if needed.

## Try it locally

```bash
npm test
npm link
codex-browser doctor
codex-browser exec "List my open browser tabs without changing anything"
```

For the original use case:

```bash
codex-browser exec "Open LinkedIn in a new tab, then click Notifications"
```

The wrapper starts ChatGPT desktop when its bridge is not ready. It then runs
the equivalent of:

```bash
codex exec --enable computer_use "..."
```

Notice the underscore in `computer_use`. The wrapper also accepts the commonly
attempted `computer-use` spelling and normalizes it.

## Diagnostics

```bash
codex-browser doctor
```

All checks must report ready. If the MCP config is missing, open ChatGPT
desktop once and verify that its browser/computer-use plugin is installed. If
the browser socket is missing, verify that the ChatGPT Chrome extension is
installed, enabled, and connected.

## Security

This wrapper deliberately does not fake the signed-in user identity, extract
tokens, connect to raw browser sockets itself, or expose arbitrary JavaScript
execution. Browser actions still flow through the ChatGPT app's own bridge and
the normal Codex approval/tool system.

Treat browser page content as untrusted. Review consequential actions before
allowing them, especially messages, purchases, account changes, and publishing.

## Why this exists

Codex CLI currently exposes the `computer_use` feature flag but does not offer
the ChatGPT desktop browser experience as a documented, first-class CLI
feature. This launcher is a temporary workaround while that gap exists.

Related upstream request:
[openai/codex#20851](https://github.com/openai/codex/issues/20851).

## License

MIT. This license covers only the wrapper code in this repository, not the
ChatGPT desktop app or its bundled components.
