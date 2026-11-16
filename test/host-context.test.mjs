import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverHostContext, HOST_KEYS, validateHostContext } from "../src/host-context.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-host-test-"));
  const desktopExecutable = path.join(root, "ChatGPT");
  const serverExecutable = path.join(root, "codex");
  const procRoot = path.join(root, "proc");
  await fs.mkdir(procRoot);
  await Promise.all([fs.writeFile(desktopExecutable, "fixture"), fs.writeFile(serverExecutable, "fixture")]);
  const socketPath = path.join(root, "host.sock");
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  t.after(async () => {
    await new Promise((resolve) => socket.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const env = {
    BROWSER_USE_ACCESS_PIPE_PATH: socketPath,
    BROWSER_USE_ACCESS_EXECUTOR_ID: JSON.stringify(["fixture-instance", "fixture-account", "fixture-user"]),
    BROWSER_USE_ACCESS_VERIFYING_IDENTITY: publicKey,
  };
  const uid = process.getuid();
  async function processFixture(pid, parent, executable, environment = {}, owner = uid) {
    const dir = path.join(procRoot, String(pid));
    await fs.mkdir(dir);
    await fs.symlink(executable, path.join(dir, "exe"));
    await fs.writeFile(path.join(dir, "status"), `PPid:\t${parent}\nUid:\t${owner}\t${owner}\t${owner}\t${owner}\n`);
    await fs.writeFile(path.join(dir, "environ"), Object.entries(environment).map(([key, value]) => `${key}=${value}\0`).join(""));
  }
  await processFixture(100, 1, desktopExecutable);
  await processFixture(101, 100, serverExecutable, { ...env, SECRET_NOT_TO_COPY: "fixture-secret" });
  return { root, env, socketPath, processFixture, options: { procRoot, desktopExecutable, serverExecutable, uid } };
}

test("selects only browser connection metadata from a desktop child", async (t) => {
  const f = await fixture(t);
  const context = await discoverHostContext(f.options);
  assert.equal(context.pid, 101);
  assert.deepEqual(context.env, f.env);
  assert.deepEqual(Object.keys(context.env).sort(), [...HOST_KEYS].sort());
});

test("rejects absent or malformed authorization context", async (t) => {
  const { env } = await fixture(t);
  assert.equal(await validateHostContext({ ...env, BROWSER_USE_ACCESS_EXECUTOR_ID: "" }), false);
  assert.equal(await validateHostContext({ ...env, BROWSER_USE_ACCESS_EXECUTOR_ID: "[]" }), false);
  assert.equal(await validateHostContext({ ...env, BROWSER_USE_ACCESS_VERIFYING_IDENTITY: "invalid" }), false);
});

test("rejects sockets accessible to other users and regular files", async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.socketPath, 0o666);
  assert.equal(await validateHostContext(f.env), false);
  const file = path.join(f.root, "not-a-socket");
  await fs.writeFile(file, "fixture", { mode: 0o600 });
  assert.equal(await validateHostContext({ ...f.env, BROWSER_USE_ACCESS_PIPE_PATH: file }), false);
  assert.equal(await validateHostContext(f.env, { uid: process.getuid() + 1 }), false);
});

test("does not attach terminal-launched or other-user Codex processes", async (t) => {
  const f = await fixture(t);
  await fs.rm(path.join(f.options.procRoot, "101"), { recursive: true });
  await f.processFixture(102, 1, f.options.serverExecutable, f.env);
  await f.processFixture(103, 100, f.options.serverExecutable, f.env, process.getuid() + 1);
  assert.equal(await discoverHostContext(f.options), null);
});

test("fails closed on multiple desktop identities instead of choosing one", async (t) => {
  const f = await fixture(t);
  await f.processFixture(102, 100, f.options.serverExecutable, {
    ...f.env, BROWSER_USE_ACCESS_EXECUTOR_ID: JSON.stringify(["fixture-instance", "other-account", "other-user"]),
  });
  await assert.rejects(discoverHostContext(f.options), /Multiple desktop browser identities/);
});
