import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRegisteredCliExecutor } from "../src/registration-policy.mjs";
import { patchDesktopSource } from "../src/desktop-patch.mjs";

const sessionId = "01a1e61e-5da8-7713-be71-f25f091213cd";
const principal = { accountId: "fixture-account", userId: "fixture-user" };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-browser-registration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const procRoot = path.join(root, "proc");
  const proc = path.join(procRoot, "123");
  await fs.mkdir(proc, { recursive: true });
  const executable = path.join(root, "codex");
  await fs.writeFile(executable, "fixture-executable", { mode: 0o700 });
  await fs.symlink(executable, path.join(proc, "exe"));
  await fs.writeFile(path.join(proc, "status"), `Uid:\t${Array(4).fill(process.getuid()).join("\t")}\n`);
  const fields = Array(25).fill("0"); fields[0] = "S"; fields[19] = "12345";
  await fs.writeFile(path.join(proc, "stat"), `123 (codex) ${fields.join(" ")}\n`);
  const policy = { version: 1, enabled: true, ...principal, executables: [{ path: executable, sha256: createHash("sha256").update("fixture-executable").digest("hex") }] };
  const lease = { version: 1, sessionId, desktopInstanceId: "fixture-instance", ...principal, pid: 123, startTicks: "12345", expiresAt: Date.now() + 60000 };
  const write = async (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
  await write("policy.json", policy); await write(`${sessionId}.json`, lease);
  const request = { sessionId, executorId: JSON.stringify(["fixture-instance", "native-browser-plugin"]) };
  const options = { root, procRoot, principal, instanceId: "fixture-instance" };
  return { root, proc, executable, policy, lease, request, options, write };
}

test("explicit account-bound registration resolves a live pinned CLI process", async (t) => {
  const f = await fixture(t);
  assert.equal(resolveRegisteredCliExecutor(f.request, f.options), JSON.stringify(["fixture-instance", principal.accountId, principal.userId]));
});

test("rejects disabled policy, different accounts, expiry, instance mismatch and PID reuse", async (t) => {
  const f = await fixture(t);
  for (const change of [{ enabled: false }, { accountId: "other-account" }, { userId: "other-user" }]) {
    await f.write("policy.json", { ...f.policy, ...change });
    assert.equal(resolveRegisteredCliExecutor(f.request, f.options), undefined);
  }
  await f.write("policy.json", f.policy);
  for (const change of [
    { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 7 * 60 * 60 * 1000 },
    { desktopInstanceId: "other-instance" }, { accountId: "other-account" },
    { sessionId: "01a1e61e-5da8-7713-be71-f25f091213ce" }, { startTicks: "reused-pid" }, { pid: 999 },
  ]) {
    await f.write(`${sessionId}.json`, { ...f.lease, ...change });
    assert.equal(resolveRegisteredCliExecutor(f.request, f.options), undefined);
  }
});

test("rejects changed binaries, permissions, symlinks, and missing consent", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.executable, "changed");
  assert.equal(resolveRegisteredCliExecutor(f.request, f.options), undefined);
  await fs.writeFile(f.executable, "fixture-executable");
  await fs.chmod(path.join(f.root, "policy.json"), 0o644);
  assert.equal(resolveRegisteredCliExecutor(f.request, f.options), undefined);
  await fs.chmod(path.join(f.root, "policy.json"), 0o600);
  await fs.rename(path.join(f.root, "policy.json"), path.join(f.root, "other.json"));
  await fs.symlink(path.join(f.root, "other.json"), path.join(f.root, "policy.json"));
  assert.equal(resolveRegisteredCliExecutor(f.request, f.options), undefined);
  await fs.unlink(path.join(f.root, "policy.json"));
  assert.equal(resolveRegisteredCliExecutor(f.request, f.options), undefined);
});

test("patch fails closed on unsupported builds and repeated application", () => {
  assert.throws(() => patchDesktopSource("unrelated-source"), /Unsupported desktop build/);
  assert.throws(() => patchDesktopSource("/* codex-cli-browser-registration:v1 */"), /already present/);
});

test("patched installed handler keeps account and Work browser policy checks", async (t) => {
  const f = await fixture(t);
  const archive = await fs.readFile("/usr/lib/chatgpt/resources/app.asar");
  const start = archive.indexOf("async readLocalWorkBrowserAccess(e){");
  const end = archive.indexOf("sendAmbientSuggestionGenerationEvent", start);
  assert.ok(start > 0 && end > start, "installed handler must be found");
  const installed = archive.subarray(start, end).toString();
  let source = installed.includes("/* codex-cli-browser-registration:v1 */") ? installed : patchDesktopSource(installed);
  // Only the fixture's registration directory differs from the installed patch.
  source = source.replace(/root:process\.getBuiltinModule\("node:path"\)\.join\(process\.env\.CODEX_HOME\|\|process\.getBuiltinModule\("node:path"\)\.join\(process\.getBuiltinModule\("node:os"\)\.homedir\(\),"\.codex"\),"browser","cli-registration"\)/, `root:${JSON.stringify(f.root)},procRoot:${JSON.stringify(f.options.procRoot)}`);
  const native = f.request.executorId;
  let workEnabled = true, localBrowserAllowed = true, cachedPrincipal = principal;
  const Handler = new Function("i4", "i8", "i9", "i6", "i7", "sp", "ei", `return class { ${source} }`)(
    native, '["fixture-instance","api-key"]', { P: "fixture-instance" },
    (p) => p ? JSON.stringify(["fixture-instance", p.accountId, p.userId]) : null,
    async () => localBrowserAllowed, { n: "local" }, { ubS: { conversationDetailMode: { key: "mode" } } },
  );
  const h = new Handler();
  h.nativeBrowserThreadAccess = { getExecutorId: async () => undefined };
  h.appServerConnectionRegistry = { getConnection: () => ({ getCachedAuthenticatedPrincipal: () => cachedPrincipal }) };
  h.settings = { getEffective: async () => workEnabled ? "STEPS_PROSE" : "CODEX" };
  h.options = { applicationNetwork: { fetch() {} } };
  h.conversationExecutor = { readBrowserAccess() { throw new Error("Unexpected fallback to a different executor"); } };
  assert.equal(await h.readLocalWorkBrowserAccess(f.request), true);
  localBrowserAllowed = false;
  assert.equal(await h.readLocalWorkBrowserAccess(f.request), false);
  workEnabled = false;
  assert.equal(await h.readLocalWorkBrowserAccess(f.request), true);
  cachedPrincipal = { ...principal, accountId: "different-account" };
  assert.equal(await h.readLocalWorkBrowserAccess(f.request), false);
});
