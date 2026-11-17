import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { withBrowserHostContext, reloadSharedMcp } from "../src/shared-daemon.mjs";
import { HOST_KEYS } from "../src/host-context.mjs";

test("refreshes only the generated browser connection context", () => {
  const original = { mcpServers: { cua_repl: { command: "/fixture/node_repl", args: ["original"], env_vars: HOST_KEYS,
    env: { TRUSTED_FIXTURE: "retained" }, tools: { js: { approval_mode: "ask" } } }, other: { command: "/fixture/other" } } };
  const context = Object.fromEntries(HOST_KEYS.map((key) => [key, "fixture-value"]));
  const next = withBrowserHostContext(original, { ...context, UNRELATED_SECRET: "never-copy" });
  assert.deepEqual(next.mcpServers.cua_repl.env, { TRUSTED_FIXTURE: "retained", ...context });
  assert.deepEqual(next.mcpServers.cua_repl.tools, original.mcpServers.cua_repl.tools);
  assert.deepEqual(next.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(original.mcpServers.cua_repl.env, { TRUSTED_FIXTURE: "retained" });
});

test("refuses unsupported launcher metadata and partial host context", () => {
  assert.throws(() => withBrowserHostContext({}, {}), /does not support/);
  assert.throws(() => withBrowserHostContext({ mcpServers: { cua_repl: { command: "/fixture/node_repl", env_vars: HOST_KEYS } } }, {}), /does not support/);
});

test("uses the existing daemon transport to refresh caches without resuming or unloading a thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "browser-daemon-reload-"));
  const directory = path.join(home, "app-server-control"); await fs.mkdir(directory, { mode: 0o700 });
  const socket = path.join(directory, "app-server-control.sock");
  const server = createServer(), websocket = new WebSocketServer({ server });
  const methods = [];
  websocket.on("connection", (connection) => {
    connection.on("message", (data) => {
      const message = JSON.parse(data); methods.push(message.method);
      if (message.id !== undefined) connection.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  try {
    server.listen(socket); await once(server, "listening"); await fs.chmod(socket, 0o600);
    await reloadSharedMcp("unused-native-path", { CODEX_HOME: home });
    assert.deepEqual(methods, ["initialize", "initialized", "skills/list", "config/mcpServer/reload"]);
  } finally {
    for (const client of websocket.clients) client.terminate();
    await new Promise((resolve) => websocket.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
});
