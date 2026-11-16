import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readPrincipal, enableRegistration, readPolicy, disableRegistration, validatePinnedExecutable, registerSession, removeRegistration, registrationRoot } from "../src/registration.mjs";
import { resolveRegisteredCliExecutor } from "../src/registration-policy.mjs";

function token(claims) { return `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claims })).toString("base64url")}.fixture`; }
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cli-browser-settings-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ tokens: {
    access_token: token({ chatgpt_account_id: "account", user_id: "desktop-user", chatgpt_user_id: "other-id" }),
    id_token: token({ chatgpt_account_id: "stale-account", chatgpt_user_id: "stale-user" }),
  } }), { mode: 0o600 });
  const executable = path.join(home, "codex");
  await fs.writeFile(executable, "fixture", { mode: 0o755 });
  return { home, executable };
}

test("uses the same access-token principal fields as the desktop", async (t) => {
  const { home } = await fixture(t);
  assert.deepEqual(await readPrincipal(home), { accountId: "account", userId: "desktop-user" });
});

test("creates a private explicit policy and supports immediate revocation", async (t) => {
  const { home, executable } = await fixture(t);
  await enableRegistration([executable], { home });
  const policy = await readPolicy(home);
  assert.equal(policy.enabled, true);
  assert.equal(policy.executables[0].path, executable);
  assert.equal(await validatePinnedExecutable(policy.executables[0]), executable);
  assert.equal((await fs.stat(registrationRoot(home))).mode & 0o777, 0o700);
  const text = await fs.readFile(path.join(registrationRoot(home), "policy.json"), "utf8");
  assert.equal(text.includes("access_token"), false);
  assert.equal(text.includes("id_token"), false);
  await disableRegistration(home);
  await assert.rejects(readPolicy(home), /not enabled/);
});

test("rejects writable executables and never deletes a newer process lease", async (t) => {
  const { home, executable } = await fixture(t);
  await fs.chmod(executable, 0o775);
  await assert.rejects(enableRegistration([executable], { home }), /non-group\/world-writable/);
  await fs.chmod(executable, 0o755);
  await enableRegistration([executable], { home });
  const policy = await readPolicy(home);
  await fs.appendFile(executable, "changed");
  await assert.rejects(validatePinnedExecutable(policy.executables[0]), /refusing to launch/);
  const filename = path.join(registrationRoot(home), "session.json");
  await fs.writeFile(filename, JSON.stringify({ leaseId: "new-lease" }), { mode: 0o600 });
  await removeRegistration({ sessionId: "session", leaseId: "old-lease" }, home);
  assert.ok(await fs.stat(filename));
});

test("registers a real child process and revokes it without taking a thread writer", async (t) => {
  const { home, executable } = await fixture(t);
  await fs.copyFile(process.execPath, executable); await fs.chmod(executable, 0o755);
  const principal = await readPrincipal(home);
  await enableRegistration([executable], { home });
  const child = spawn(executable, ["-e", "process.stdin.resume()"], { stdio: "pipe" });
  const exited = once(child, "exit");
  try {
    await once(child, "spawn");
    const sessionId = "01a1e61e-5da8-7713-be71-f25f091213cd";
    const context = { env: { BROWSER_USE_ACCESS_EXECUTOR_ID: '["fixture-instance","native-browser-plugin"]' } };
    const lease = await registerSession(sessionId, child.pid, context, { home });
    const request = { sessionId, executorId: context.env.BROWSER_USE_ACCESS_EXECUTOR_ID };
    const options = { root: registrationRoot(home), instanceId: "fixture-instance", principal };
    assert.ok(resolveRegisteredCliExecutor(request, options));
    await disableRegistration(home);
    assert.equal(resolveRegisteredCliExecutor(request, options), undefined);
    await removeRegistration(lease, home);
    await assert.rejects(fs.stat(path.join(registrationRoot(home), `${sessionId}.json`)), { code: "ENOENT" });
  } finally { child.kill(); await exited; }
});
