import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { validateHostContext } from "./host-context.mjs";

const DEFAULT_CHATGPT_BIN = "/usr/lib/chatgpt/ChatGPT";
const DEFAULT_TIMEOUT_MS = 30_000;

export function prepareCodexArgs(inputArgs) {
  const args = [...inputArgs];

  for (let index = 0; index < args.length - 1; index += 1) {
    if ((args[index] === "--enable" || args[index] === "--disable") && args[index + 1] === "computer-use") {
      args[index + 1] = "computer_use";
    }
  }

  const alreadyEnabled = args.some(
    (arg, index) => arg === "--enable" && args[index + 1] === "computer_use",
  );
  if (alreadyEnabled) return args;

  if (args[0] === "exec") {
    return ["exec", "--enable", "computer_use", ...args.slice(1)];
  }
  return ["--enable", "computer_use", ...args];
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function socketDirectory() {
  return path.join(os.tmpdir(), "codex-browser-use");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasBrowserSocket() {
  try {
    const entries = await fs.readdir(socketDirectory(), { withFileTypes: true });
    return entries.some((entry) => entry.isSocket() || entry.name.endsWith(".sock"));
  } catch {
    return false;
  }
}

async function findGeneratedMcpConfig() {
  const root = path.join(
    codexHome(),
    "plugins",
    "cache",
    "openai-bundled",
    "unified-computer-use",
  );
  let versions;
  try {
    versions = await fs.readdir(root);
  } catch {
    return null;
  }

  versions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(root, version, ".mcp.json");
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function inspectMcpConfig(configPath) {
  if (!configPath) return { enabled: false, valid: false, hostAuthorizationRequired: false };
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    const server = parsed?.mcpServers?.cua_repl;
    return {
      enabled: server?.enabled === true,
      valid: typeof server?.command === "string" && Array.isArray(server?.args),
      hostAuthorizationRequired: JSON.stringify(server?.args ?? []).includes("BROWSER_USE_ACCESS_EXECUTOR_ID")
        || JSON.stringify(server?.env ?? {}).includes("require-browser-access.mjs"),
    };
  } catch {
    return { enabled: false, valid: false, hostAuthorizationRequired: false };
  }
}

export async function bridgeStatus() {
  const chatGptBin = process.env.CHATGPT_BIN || DEFAULT_CHATGPT_BIN;
  const mcpConfig = await findGeneratedMcpConfig();
  const mcp = await inspectMcpConfig(mcpConfig);
  const hostContextAvailable = await validateHostContext(process.env);
  return {
    platform: process.platform,
    chatGptBin,
    chatGptInstalled: await exists(chatGptBin),
    browserSocket: await hasBrowserSocket(),
    mcpConfig,
    mcpEnabled: mcp.enabled,
    mcpValid: mcp.valid,
    hostAuthorizationRequired: mcp.hostAuthorizationRequired,
    hostContextAvailable,
    ready:
      process.platform === "linux" &&
      (await exists(chatGptBin)) &&
      (await hasBrowserSocket()) &&
      mcp.enabled &&
      mcp.valid &&
      (!mcp.hostAuthorizationRequired || hostContextAvailable),
  };
}

export function formatDoctor(status) {
  const mark = (value) => (value ? "ok" : "missing");
  return [
    `platform: ${status.platform}`,
    `ChatGPT: ${mark(status.chatGptInstalled)} (${status.chatGptBin})`,
    `browser socket: ${mark(status.browserSocket)}`,
    `generated MCP config: ${mark(status.mcpValid)}${status.mcpConfig ? ` (${status.mcpConfig})` : ""}`,
    `cua_repl enabled: ${status.mcpEnabled ? "yes" : "no"}`,
    `desktop authorization context: ${status.hostAuthorizationRequired ? (status.hostContextAvailable ? "available" : "missing") : "not required by generated launcher"}`,
    `signed desktop authorization: ${status.authorizationError || (status.hostAuthorized === true ? "allowed" : status.hostAuthorized === false ? "denied" : "not checked; supply a session UUID")}`,
    `ready: ${status.ready ? "yes" : "no"}`,
  ].join("\n");
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function startChatGptAndWait(options = {}) {
  if (process.platform !== "linux") {
    throw new Error("this prototype currently supports Linux only");
  }

  const initial = await bridgeStatus();
  if (initial.ready) return initial;
  if (!initial.chatGptInstalled) {
    throw new Error(`ChatGPT desktop was not found at ${initial.chatGptBin}; set CHATGPT_BIN to override`);
  }

  const child = spawn(initial.chatGptBin, [], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();

  const configuredTimeout = Number(process.env.BROWSER_BRIDGE_TIMEOUT_MS);
  const timeoutMs = options.timeoutMs ?? (configuredTimeout || DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(250);
    const status = await bridgeStatus();
    if (status.ready) return status;
  }

  const status = await bridgeStatus();
  throw new Error(`browser bridge did not become ready within ${timeoutMs}ms\n${formatDoctor(status)}`);
}
