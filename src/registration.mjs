import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileSha256 } from "./asar-patch.mjs";
import { resolveRegisteredCliExecutor } from "./registration-policy.mjs";

export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const registrationRoot = (home = codexHome()) => path.join(home, "browser", "cli-registration");

async function privateRoot(home) {
  const root = registrationRoot(home);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("CLI registration directory must be private and owned by this user");
  return root;
}

async function writeJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function readPrincipal(home = codexHome()) {
  const auth = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"));
  const payload = (auth.tokens?.access_token || auth.tokens?.id_token)?.split(".")[1];
  if (!payload) throw new Error("CLI browser registration requires a ChatGPT account login");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  const identity = claims["https://api.openai.com/auth"];
  const accountId = identity?.chatgpt_account_id || identity?.account_id;
  const userId = identity?.user_id || identity?.chatgpt_user_id;
  if (typeof accountId !== "string" || !accountId || typeof userId !== "string" || !userId) throw new Error("CLI account identity is missing");
  // These are registration claims, not proof: the desktop independently matches
  // them against its own authenticated account before its policy check runs.
  return { accountId, userId };
}

export async function enableRegistration(executables, { home = codexHome() } = {}) {
  if (!executables.length) throw new Error("Specify at least one native Codex executable to pin");
  const principal = await readPrincipal(home);
  const pins = [];
  for (const filename of executables) {
    const executable = await fs.realpath(filename), info = await fs.stat(executable);
    if (!info.isFile() || (info.mode & 0o022) !== 0 || path.basename(executable) !== "codex") throw new Error("Only a non-group/world-writable native codex executable can be pinned");
    if (!pins.some((pin) => pin.path === executable)) pins.push({ path: executable, sha256: await fileSha256(executable) });
  }
  const policy = { version: 1, enabled: true, ...principal, executables: pins };
  await writeJson(path.join(await privateRoot(home), "policy.json"), policy);
  return policy;
}

export async function readPolicy(home = codexHome()) {
  const filename = path.join(registrationRoot(home), "policy.json"), info = await fs.lstat(filename);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.nlink !== 1) throw new Error("CLI browser policy must be a private regular file");
  const policy = JSON.parse(await fs.readFile(filename, "utf8"));
  if (policy.version !== 1 || !policy.enabled || !policy.executables?.length) throw new Error("CLI browser registration is not enabled");
  return policy;
}

export async function validatePinnedExecutable(pin) {
  const executable = await fs.realpath(pin.path), info = await fs.stat(executable);
  if (executable !== pin.path || !info.isFile() || (info.mode & 0o022) !== 0
    || await fileSha256(executable) !== pin.sha256) throw new Error("Pinned Codex executable changed; refusing to launch it");
  return executable;
}

export async function disableRegistration(home = codexHome()) {
  const policy = await readPolicy(home);
  await writeJson(path.join(registrationRoot(home), "policy.json"), { ...policy, enabled: false });
}

export async function registerSession(sessionId, pid, context, { home = codexHome(), ttlMs = 6 * 60 * 60 * 1000 } = {}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error("A valid session UUID is required");
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 6 * 60 * 60 * 1000) throw new Error("Invalid registration PID or lifetime");
  const policy = await readPolicy(home), principal = await readPrincipal(home);
  if (principal.accountId !== policy.accountId || principal.userId !== policy.userId) throw new Error("CLI account changed; explicitly enable registration for the intended account");
  const executor = JSON.parse(context.env.BROWSER_USE_ACCESS_EXECUTOR_ID);
  if (executor.length !== 2 || executor[1] !== "native-browser-plugin") throw new Error("Desktop host does not expose a native-plugin registration context");
  const processDir = `/proc/${pid}`, executable = await fs.realpath(`${processDir}/exe`);
  const pin = policy.executables.find((entry) => entry.path === executable);
  if (!pin || await fileSha256(executable) !== pin.sha256) throw new Error("Codex executable is not pinned or has changed; review it before enabling registration again");
  const stat = await fs.readFile(`${processDir}/stat`, "utf8");
  const lease = { version: 1, leaseId: randomUUID(), sessionId, desktopInstanceId: executor[0], ...principal, pid,
    startTicks: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19], expiresAt: Date.now() + ttlMs };
  const root = await privateRoot(home), filename = path.join(root, `${sessionId}.json`);
  await writeJson(filename, lease);
  if (!resolveRegisteredCliExecutor({ sessionId, executorId: context.env.BROWSER_USE_ACCESS_EXECUTOR_ID }, { root, instanceId: executor[0], principal })) {
    await fs.unlink(filename).catch(() => {}); throw new Error("CLI browser registration failed local validation");
  }
  return lease;
}

export async function removeRegistration(lease, home = codexHome()) {
  const filename = path.join(registrationRoot(home), `${lease.sessionId}.json`);
  try {
    const current = JSON.parse(await fs.readFile(filename, "utf8"));
    if (current.leaseId === lease.leaseId) await fs.unlink(filename);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
