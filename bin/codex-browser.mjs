#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";
import {
  bridgeStatus,
  formatDoctor,
  prepareCodexArgs,
  startChatGptAndWait,
} from "../src/bridge.mjs";

const args = process.argv.slice(2);

if (args[0] === "doctor") {
  const status = await bridgeStatus();
  process.stdout.write(`${formatDoctor(status)}\n`);
  process.exitCode = status.ready ? 0 : 1;
} else if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  process.stdout.write(`Usage:
  codex-browser doctor
  codex-browser exec [CODEX OPTIONS] [PROMPT]
  codex-browser [CODEX COMMAND AND OPTIONS]

This unsupported Linux wrapper starts the installed ChatGPT desktop app when
needed, waits for its browser MCP bridge, enables Codex's computer_use feature,
and then runs Codex CLI. It does not bundle or copy ChatGPT proprietary code.
`);
} else {
  process.stderr.write("codex-browser: experimental, unsupported bridge\n");

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
