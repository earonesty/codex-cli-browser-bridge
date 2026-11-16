import fs from "node:fs/promises";
import path from "node:path";
import { createPublicKey } from "node:crypto";

export const HOST_KEYS = [
  "BROWSER_USE_ACCESS_PIPE_PATH",
  "BROWSER_USE_ACCESS_EXECUTOR_ID",
  "BROWSER_USE_ACCESS_VERIFYING_IDENTITY",
];

function parseEnvironment(buffer) {
  const env = {};
  for (const entry of buffer.toString().split("\0")) {
    const index = entry.indexOf("=");
    if (index !== -1 && HOST_KEYS.includes(entry.slice(0, index))) {
      env[entry.slice(0, index)] = entry.slice(index + 1);
    }
  }
  return env;
}

function processIdentity(status) {
  const uid = /^Uid:\s+(\d+)/m.exec(status);
  const parent = /^PPid:\s+(\d+)/m.exec(status);
  return { uid: uid ? Number(uid[1]) : null, parent: parent?.[1] };
}

export async function validateHostContext(env, { uid = process.getuid() } = {}) {
  if (!HOST_KEYS.every((key) => typeof env[key] === "string" && env[key].length > 0)) return false;
  try {
    const identity = JSON.parse(env.BROWSER_USE_ACCESS_EXECUTOR_ID);
    if (!Array.isArray(identity) || !identity.every((part) => typeof part === "string" && part.length > 0)) return false;
    if (identity.length !== 3 && !(identity.length === 2 && ["native-browser-plugin", "api-key"].includes(identity[1]))) return false;
    const key = createPublicKey({ key: Buffer.from(env.BROWSER_USE_ACCESS_VERIFYING_IDENTITY, "base64"), type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    const socket = await fs.lstat(env.BROWSER_USE_ACCESS_PIPE_PATH);
    return socket.isSocket() && socket.uid === uid && (socket.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Discover connection metadata, never access/refresh tokens or signing keys.
 * Only accept a same-user app-server directly launched by the configured desktop
 * executable. The desktop remains responsible for authorizing every turn.
 */
export async function discoverHostContext({
  procRoot = "/proc",
  desktopExecutable = "/usr/lib/chatgpt/ChatGPT",
  serverExecutable = "/usr/lib/chatgpt/resources/codex",
  uid = process.getuid(),
} = {}) {
  const [desktop, server] = await Promise.all([
    fs.realpath(desktopExecutable), fs.realpath(serverExecutable),
  ]);
  const candidates = [];
  for (const entry of await fs.readdir(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const root = path.join(procRoot, entry);
      if (await fs.realpath(path.join(root, "exe")) !== server) continue;
      const identity = processIdentity(await fs.readFile(path.join(root, "status"), "utf8"));
      if (identity.uid !== uid || !identity.parent) continue;
      const parentRoot = path.join(procRoot, identity.parent);
      if (await fs.realpath(path.join(parentRoot, "exe")) !== desktop) continue;
      if (processIdentity(await fs.readFile(path.join(parentRoot, "status"), "utf8")).uid !== uid) continue;
      const env = parseEnvironment(await fs.readFile(path.join(root, "environ")));
      if (await validateHostContext(env, { uid })) candidates.push({ pid: Number(entry), env });
    } catch {
      // Processes can exit, or deny inspection, while discovery is in progress.
    }
  }
  if (candidates.length === 0) return null;
  const contexts = new Set(candidates.map(({ env }) => JSON.stringify(HOST_KEYS.map((key) => env[key]))));
  if (contexts.size !== 1) throw new Error("Multiple desktop browser identities found; close duplicate desktop instances before retrying");
  return candidates.sort((a, b) => b.pid - a.pid)[0];
}
