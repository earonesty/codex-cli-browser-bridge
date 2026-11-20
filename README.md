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

## Explicit CLI session registration patch

Desktop `26.1103.32239` requires browser authorization tied to a session that the
desktop knows. A terminal/Slack-owned session cannot be resumed in the desktop at
the same time, and copying its socket environment alone receives a signed denial.

This branch adds an **opt-in desktop patch** and a registration wrapper. The patch
resolves only explicitly registered CLI sessions to the desktop's authenticated
account, then runs the original account and Work browser-policy checks. It leaves
website approvals, authorization signatures, and conversation writer locks intact.

Registration requires a private policy file under
`~/.codex/browser/cli-registration/`, an exact account match, an approved executable
path and SHA-256, and a session lease bound to a live same-user PID/start time and
the current desktop instance. Leases last at most six hours. In fixed-pin mode, changing the binary invalidates the corresponding registration.
PATH mode refreshes the pin before launch. Changing the account or desktop instance
invalidates the corresponding registration in either mode. Disabling
the policy revokes registrations on the next authorization check.

The patcher refuses builds whose authorization handler differs from its supported
anchor. It prepares a separate ASAR with updated member integrity metadata; it
does not modify the installed archive. Keep the original archive and manifest for
rollback. A desktop update requires reviewing/preparing the patch again. Linux is
the only supported platform; no signature enforcement or Electron fuse is disabled.

```bash
node bin/codex-browser-patch.mjs prepare
# Quit the desktop app first. The installer verifies hashes, keeps a backup,
# replaces the archive atomically, and refuses a different installed build.
sudo node bin/codex-browser-patch.mjs install \
  "$HOME/.local/state/codex-cli-browser-bridge/patch-manifest.json"
# Reopen the desktop app.
node bin/codex-browser-patch.mjs enable --path
codex-browser resume SESSION_UUID
codex-browser doctor SESSION_UUID
```

For an already-running terminal session, repair browser attachment in place:

```bash
codex-browser attach SESSION_UUID
```

This registers the actual shared daemon, updates only the generated CUA browser
connection environment, clears parsed plugin metadata with `skills/list`'s public
force-reload option, and invokes `config/mcpServer/reload` over the daemon's private
WebSocket-over-Unix socket. It never resumes, unloads, or takes over a conversation.
`resume` uses this attachment before joining the existing daemon; it does not add
`--no-daemon`. Interactive attachment requires a running local shared daemon.

With `enable --path`, each launch uses the first `codex` executable on the launcher's
`PATH`, including the native binary behind the official npm shim. Updates and version
switches refresh the private policy with that binary's exact path and SHA-256 before
starting a session. The binary must be owned by you and not world-writable; npm's
group-write bit is removed automatically to satisfy desktop validation. Valid older
pins remain available to existing sessions. Missing or unsupported PATH launchers
produce an error instead of silently selecting another installation.

For a fixed version, use `enable /absolute/path/to/native/codex` instead. That mode
continues to reject changed binaries. The desktop still checks exact hashes, live
process identities, and account/Work policy in both modes. `enable` reads only
account identifiers from the CLI login; the
desktop independently checks those identifiers against its own login. It never
copies access tokens, refresh tokens, or private signing keys into registrations.

For `codex-slack`, configure the Codex agent command to the absolute path of
`bin/codex-browser.mjs`. Its `app-server` mode proxies ordinary JSON-RPC and writes
the lease before delivering each successful root thread start/resume response.
Lease files are removed on process exit. The native backend remains the sole
conversation writer. New interactive sessions currently need to be created through
the app-server flow first; interactive `resume` accepts an explicit session UUID.
An alternate `CODEX_HOME` without its own registration policy runs a plain
app-server with its original environment and browser delegation removed. This
keeps isolated agents, such as GitHub triage, separate from the primary account.

```bash
node bin/codex-browser-patch.mjs disable
# To remove the desktop patch, quit the desktop app and run:
sudo node bin/codex-browser-patch.mjs restore \
  "$HOME/.local/state/codex-cli-browser-bridge/patch-manifest.json"
```

`doctor SESSION_UUID` now verifies a real signed authorization response. A socket
and generated config alone are no longer reported as ready. This diagnostic is an
authorization preflight; a successful browser inventory is the final runtime test.

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
