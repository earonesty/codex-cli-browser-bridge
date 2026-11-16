#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareDesktopPatch } from "../src/asar-patch.mjs";
import { enableRegistration, disableRegistration, registerSession } from "../src/registration.mjs";
import { discoverHostContext } from "../src/host-context.mjs";
import { checkHostAuthorization } from "../src/host-authorization.mjs";
import { installDesktopPatch } from "../src/install-patch.mjs";

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "prepare") {
    const root = args[1] || path.join(os.homedir(), ".local/state/codex-cli-browser-bridge");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const result = await prepareDesktopPatch(args[0] || "/usr/lib/chatgpt/resources/app.asar", path.join(root, "app.patched.asar"));
    await fs.writeFile(path.join(root, "patch-manifest.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(`Prepared ${result.output}\nOriginal SHA-256: ${result.sourceSha256}\nPatched SHA-256: ${result.patchedSha256}`);
  } else if (command === "install" || command === "restore") {
    if (!args[0]) throw new Error("Specify the reviewed patch-manifest.json path");
    const result = await installDesktopPatch(path.resolve(args[0]), { restore: command === "restore" });
    console.log(`${result.restored ? "Restored" : "Installed"} ${result.target}\nBackup: ${result.backup}\nSHA-256: ${result.sha256}\nReopen the desktop app before testing.`);
  } else if (command === "enable") {
    const policy = await enableRegistration(args);
    console.log(`Enabled account-bound CLI browser registration for ${policy.executables.length} pinned executable(s).`);
  } else if (command === "disable") {
    await disableRegistration(); console.log("Disabled CLI browser registration.");
  } else if (command === "register" || command === "probe") {
    const sessionId = args[0];
    if (!sessionId) throw new Error("Specify a session UUID");
    const context = await discoverHostContext();
    if (!context) throw new Error("No desktop browser context found");
    if (command === "register") {
      const lease = await registerSession(sessionId, Number(args[1]), context);
      console.log(`Registered session ${sessionId}; expires ${new Date(lease.expiresAt).toISOString()}.`);
    }
    const allowed = await checkHostAuthorization(context.env, { sessionId, turnId: "cli-registration-diagnostic" });
    console.log(`Verified desktop authorization: ${allowed ? "allowed" : "denied"}`);
    if (!allowed) process.exitCode = 1;
  } else {
    console.log("Usage: codex-browser-patch prepare [app.asar] [output-directory]\n       codex-browser-patch install <patch-manifest.json>   (sudo; desktop must be closed)\n       codex-browser-patch restore <patch-manifest.json>   (sudo; desktop must be closed)\n       codex-browser-patch enable <native-codex-executable> [...]\n       codex-browser-patch disable\n       codex-browser-patch register <session-UUID> <owning-codex-PID>\n       codex-browser-patch probe <session-UUID>");
    if (command) process.exitCode = 1;
  }
} catch (error) { console.error(`codex-browser-patch: ${error.message}`); process.exitCode = 1; }
