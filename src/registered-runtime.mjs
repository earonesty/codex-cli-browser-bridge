import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { discoverHostContext, HOST_KEYS } from "./host-context.mjs";
import { readPolicy, validatePinnedExecutable, registerSession, removeRegistration } from "./registration.mjs";
import { prepareCodexArgs } from "./bridge.mjs";

export class RegistrationTracker {
  constructor(register) { this.register = register; this.pending = new Map(); this.roots = new Map(); }
  outgoing(message) {
    if (["thread/start", "thread/resume", "thread/fork"].includes(message.method) && message.id !== undefined) this.pending.set(JSON.stringify(message.id), message.method);
  }
  async incoming(message) {
    let thread;
    if (message.method === "thread/started") thread = message.params?.thread;
    else if (message.id !== undefined && this.pending.delete(JSON.stringify(message.id))) thread = message.result?.thread;
    if (!thread || typeof thread.id !== "string") return;
    const root = thread.sessionId ?? thread.id;
    this.roots.set(thread.id, root);
    if (root === thread.id) await this.register(root);
  }
}

async function write(stream, line) {
  if (!stream.write(`${line}\n`)) await once(stream, "drain");
}

export function unregisteredEnvironment(env) {
  const result = { ...env };
  for (const key of HOST_KEYS) delete result[key];
  return result;
}

/** An alternate CODEX_HOME without its own opt-in keeps a plain backend.
 * Sharing an approved executable does not share its account or browser context.
 */
export async function runUnregisteredBackend(args) {
  let executable = process.env.CODEX_BIN || "codex";
  if (!process.env.CODEX_BIN) {
    try {
      const policy = await readPolicy(path.join(os.homedir(), ".codex"));
      executable = await validatePinnedExecutable(policy.executables[0]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const child = spawn(executable, args, { env: unregisteredEnvironment(process.env), stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = signals.map((signal) => { const handler = () => child.kill(signal); process.on(signal, handler); return [signal, handler]; });
  try {
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
    process.exitCode = result.code ?? (result.signal ? 128 : 1);
  } finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
}

export async function runRegisteredCodex(args) {
  const policy = await readPolicy();
  const context = await discoverHostContext();
  if (!context) throw new Error("No live desktop browser context found; start the patched desktop app first");
  const executable = await validatePinnedExecutable(policy.executables[0]);
  const env = { ...process.env, ...context.env };
  const serverMode = args[0] === "app-server";
  const resumeIndex = args.indexOf("resume");
  const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
  if (!serverMode && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId ?? "")) {
    throw new Error("Use codex-browser resume <session UUID>, exec resume <session UUID> <prompt>, or app-server; new sessions must be created through the app-server registration proxy");
  }
  const childArgs = prepareCodexArgs(args);
  if (!serverMode && !childArgs.includes("--no-daemon")) childArgs.unshift("--no-daemon");
  const child = spawn(executable, childArgs, { env, stdio: serverMode ? ["pipe", "pipe", "inherit"] : "inherit" });
  const leases = new Map();
  const register = async (id) => {
    const current = leases.get(id);
    if (current && current.expiresAt > Date.now() + 60 * 60 * 1000) return;
    leases.set(id, await registerSession(id, child.pid, context));
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = (signal) => child.kill(signal);
  const handlers = signals.map((signal) => { const handler = () => forward(signal); process.on(signal, handler); return [signal, handler]; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  let input, output;
  try {
    await once(child, "spawn");
    if (serverMode) {
      const tracker = new RegistrationTracker(register);
      input = createInterface({ input: process.stdin });
      output = createInterface({ input: child.stdout });
      const upstream = (async () => {
        for await (const line of input) {
          const message = JSON.parse(line); tracker.outgoing(message);
          if (message.method === "turn/start" && typeof message.params?.threadId === "string") {
            const root = tracker.roots.get(message.params.threadId);
            if (root) await register(root);
          }
          await write(child.stdin, line);
        }
        child.stdin.end();
      })();
      const downstream = (async () => {
        for await (const line of output) { await tracker.incoming(JSON.parse(line)); await write(process.stdout, line); }
      })();
      await Promise.race([Promise.all([upstream, downstream]), exited]);
    } else {
      await register(sessionId);
      process.stderr.write("codex-browser: session registered; desktop browser policy remains enforced\n");
    }
    const result = await exited;
    process.exitCode = result.code ?? (result.signal ? 128 : 1);
  } catch (error) {
    child.kill("SIGTERM"); throw error;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    input?.close(); output?.close();
    await Promise.all([...leases.values()].map((lease) => removeRegistration(lease).catch(() => {})));
  }
}
