import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { HOST_KEYS } from "./host-context.mjs";
import { codexHome, registerSession, readPolicy, resolveRegisteredExecutable, validatePinnedExecutable } from "./registration.mjs";
import { findGeneratedMcpConfig } from "./bridge.mjs";

export function withBrowserHostContext(config, env) {
  const result = structuredClone(config), server = result.mcpServers?.cua_repl;
  if (!server || typeof server.command !== "string" || !HOST_KEYS.every((key) => server.env_vars?.includes(key) && typeof env[key] === "string" && env[key])) {
    throw new Error("Generated CUA server does not support this browser-host context");
  }
  server.env = { ...server.env };
  for (const key of HOST_KEYS) server.env[key] = env[key];
  return result;
}

export async function sharedDaemonPid(home = codexHome()) {
  const metadata = JSON.parse(await fs.readFile(path.join(home, "app-server-daemon", "daemon.pid"), "utf8"));
  if (!Number.isSafeInteger(metadata.pid) || metadata.pid <= 0) throw new Error("Invalid shared daemon PID");
  const stat = await fs.readFile(`/proc/${metadata.pid}/stat`, "utf8");
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  if (ticks !== String(metadata.processIdentity?.startTicks)) throw new Error("Shared daemon identity changed; retry attachment");
  return metadata.pid;
}

export async function ensureSharedDaemonPin(actual, home = codexHome()) {
  const policy = await readPolicy(home);
  const pin = policy.executables.find(entry => entry.path === actual);
  if (pin) return validatePinnedExecutable(pin);
  // PATH-following consent also covers the CLI's managed update installation.
  // Only accept its native binary in this home's release tree; fixed pins stay fixed.
  const releases = path.join(home, "packages", "app-server-daemon", "releases");
  const relative = path.relative(releases, actual).split(path.sep);
  if (!policy.followPath || relative.length !== 3 || relative[0] === ".."
      || relative[1] !== "bin" || relative[2] !== "codex") {
    throw new Error("Shared daemon executable is not in the browser policy");
  }
  const realReleases = await fs.realpath(releases);
  if (await fs.realpath(actual) !== actual || !actual.startsWith(`${realReleases}${path.sep}`)) {
    throw new Error("Shared daemon executable is outside the managed release tree");
  }
  return resolveRegisteredExecutable({ home, env: { ...process.env, PATH: path.dirname(actual) } });
}

export async function reloadSharedMcp(_executable, env = process.env) {
  const home = env.CODEX_HOME || codexHome();
  const socketPath = await fs.realpath(path.join(home, "app-server-control", "app-server-control.sock"));
  const info = await fs.lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("Shared daemon socket must be private and owned by this user");
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 10000 });
  const pending = new Map(); let next = 1;
  const fail = (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Shared daemon connection closed before the response")));
  socket.on("message", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error("Invalid shared daemon response")); return; }
    if (message.method && message.id !== undefined) {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "Interactive requests are not approved by the configuration reload client" } }));
      return;
    }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Shared daemon ${method} timed out`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
  });
  try {
    await once(socket, "open");
    await request("initialize", { clientInfo: { name: "codex_browser_attach", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
    // The plugin cache keys installation paths, not edits to generated .mcp.json.
    // The public force-reload operation clears that parsed plugin cache first.
    await request("skills/list", { cwds: [], forceReload: true });
    await request("config/mcpServer/reload");
  } finally {
    socket.close(); fail(new Error("Reload client closed"));
  }
}

export async function attachSharedBrowser(sessionId, context, executable, { home = codexHome() } = {}) {
  const pid = await sharedDaemonPid(home);
  // Check the daemon binary against the approved policy before changing config.
  const actual = await fs.realpath(`/proc/${pid}/exe`);
  await ensureSharedDaemonPin(actual, home);
  const lease = await registerSession(sessionId, pid, context, { home });
  const filename = await findGeneratedMcpConfig();
  if (!filename) throw new Error("No generated CUA server config found");
  const config = JSON.parse(await fs.readFile(filename, "utf8"));
  const next = withBrowserHostContext(config, context.env);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  await reloadSharedMcp(executable, { ...process.env, CODEX_HOME: home });
  return lease;
}
