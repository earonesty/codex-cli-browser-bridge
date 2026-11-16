#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { registrationRoot } from "../src/registration.mjs";
import { runRegisteredCodex } from "../src/registered-runtime.mjs";
import { discoverHostContext } from "../src/host-context.mjs";
import { checkHostAuthorization } from "../src/host-authorization.mjs";
import {
  bridgeStatus,
  formatDoctor,
  prepareCodexArgs,
  startChatGptAndWait,
} from "../src/bridge.mjs";

const args = process.argv.slice(2);

if (args[0] === "doctor") {
  const status = await bridgeStatus();
  const sessionId = args[1] || process.env.CODEX_THREAD_ID;
  try {
    const context = await discoverHostContext();
    status.hostContextAvailable = Boolean(context);
    if (context && sessionId) status.hostAuthorized = await checkHostAuthorization(context.env, { sessionId, turnId: "cli-registration-diagnostic" });
    status.ready = status.platform === "linux" && status.chatGptInstalled && status.browserSocket && status.mcpEnabled && status.mcpValid && status.hostAuthorized === true;
  } catch (error) { status.ready = false; status.authorizationError = error.message; }
  process.stdout.write(`${formatDoctor(status)}\n`);
  process.exitCode = status.ready ? 0 : 1;
} else if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  process.stdout.write(`Usage:
  codex-browser doctor
  codex-browser doctor [SESSION UUID]
  codex-browser resume SESSION_UUID
  codex-browser app-server
  codex-browser exec [CODEX OPTIONS] [PROMPT]
  codex-browser [CODEX COMMAND AND OPTIONS]

This unsupported Linux wrapper starts the installed ChatGPT desktop app when
needed, waits for its browser MCP bridge, enables Codex's computer_use feature,
and then runs Codex CLI. It does not bundle or copy ChatGPT proprietary code.
`);
} else {
  process.stderr.write("codex-browser: experimental, unsupported bridge\n");

  const configured = await fs.access(path.join(registrationRoot(), "policy.json")).then(() => true, () => false);
  if (configured) {
    try { await runRegisteredCodex(args); }
    catch (error) { console.error(`codex-browser: ${error.message}`); process.exitCode = 1; }
  } else {

  try {
    await startChatGptAndWait();
  } catch (error) {
    process.stderr.write(`codex-browser: ${error.message}\n`);
    process.exit(1);
  }

  const child = spawn(process.env.CODEX_BIN || "codex", prepareCodexArgs(args), {
    env: process.env,
    stdio: "inherit",
  });

  child.once("error", (error) => {
    process.stderr.write(`codex-browser: could not start Codex CLI: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
  }
}
