import assert from "node:assert/strict";
import test from "node:test";
import { RegistrationTracker, unregisteredEnvironment, runRegisteredCodex } from "../src/registered-runtime.mjs";

test("desktop outage keeps app-server available without browser delegation", async () => {
  const calls = [];
  await runRegisteredCodex(["app-server"], { discover: async () => null, plainBackend: async args => calls.push(args) });
  assert.deepEqual(calls, [["app-server"]]);
  await assert.rejects(runRegisteredCodex(["resume", "session"], {
    discover: async () => null, plainBackend: async () => assert.fail("interactive launch must require desktop"),
  }), /No live desktop/);
});

test("registers a root before exposing a successful start/resume response", async () => {
  const registrations = [];
  const tracker = new RegistrationTracker(async (id) => { await Promise.resolve(); registrations.push(id); });
  tracker.outgoing({ id: 3, method: "thread/start", params: {} });
  await tracker.incoming({ id: 3, result: { thread: { id: "root" } } });
  assert.deepEqual(registrations, ["root"]);
  assert.equal(tracker.roots.get("root"), "root");
  tracker.outgoing({ id: 4, method: "thread/resume", params: { threadId: "root" } });
  await tracker.incoming({ id: 4, result: { thread: { id: "child", sessionId: "root" } } });
  assert.deepEqual(registrations, ["root"]);
  assert.equal(tracker.roots.get("child"), "root");
});

test("does not register failed requests or unrelated replies", async () => {
  const tracker = new RegistrationTracker(async () => { throw new Error("Unexpected registration"); });
  tracker.outgoing({ id: 1, method: "thread/resume" });
  await tracker.incoming({ id: 1, error: { message: "already has an active writer" } });
  await tracker.incoming({ id: 2, result: { thread: { id: "unrelated" } } });
});

test("propagates registration failure instead of exposing an unregistered thread", async () => {
  const tracker = new RegistrationTracker(async () => { throw new Error("Policy disabled"); });
  await assert.rejects(tracker.incoming({ method: "thread/started", params: { thread: { id: "root" } } }), /Policy disabled/);
});

test("an isolated backend retains its home and credentials without inheriting browser delegation", () => {
  const result = unregisteredEnvironment({ CODEX_HOME: "/fixture/isolated", PATH: "/fixture/bin", PRIVATE_FIXTURE: "unchanged",
    BROWSER_USE_ACCESS_PIPE_PATH: "/fixture/socket", BROWSER_USE_ACCESS_EXECUTOR_ID: "fixture-executor", BROWSER_USE_ACCESS_VERIFYING_IDENTITY: "fixture-key" });
  assert.deepEqual(result, { CODEX_HOME: "/fixture/isolated", PATH: "/fixture/bin", PRIVATE_FIXTURE: "unchanged" });
});
