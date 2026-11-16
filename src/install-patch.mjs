import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileSha256 } from "./asar-patch.mjs";

async function desktopIsRunning() {
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { if (await fs.readlink(`/proc/${name}/exe`) === "/usr/lib/chatgpt/ChatGPT") return true; }
    catch { /* A process can exit during inspection. */ }
  }
  return false;
}

export async function installDesktopPatch(manifestPath, { restore = false } = {}) {
  if (process.getuid() !== 0) throw new Error("Installing the system desktop archive requires sudo; never send a password in chat");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const target = "/usr/lib/chatgpt/resources/app.asar";
  if (manifest.version !== 1 || manifest.input !== target
    || manifest.marker !== "/* codex-cli-browser-registration:v1 */"
    || !/^[0-9a-f]{64}$/.test(manifest.sourceSha256) || !/^[0-9a-f]{64}$/.test(manifest.patchedSha256)) throw new Error("Invalid desktop patch manifest");
  if (await desktopIsRunning()) throw new Error("Quit the ChatGPT desktop app before installing or restoring its archive; terminal Codex sessions can remain open");
  const backup = path.join(path.dirname(manifestPath), "app.original.asar");
  const expected = restore ? manifest.patchedSha256 : manifest.sourceSha256;
  const replacementHash = restore ? manifest.sourceSha256 : manifest.patchedSha256;
  if (await fileSha256(target) !== expected) throw new Error("Installed desktop archive changed; refusing to overwrite a different build");
  const replacement = restore ? backup : manifest.output;
  if (await fileSha256(replacement) !== replacementHash) throw new Error("Replacement archive does not match the reviewed manifest");
  const original = await fs.stat(target);
  if (!restore) {
    try {
      await fs.copyFile(target, backup, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      await fs.chmod(backup, 0o600);
      const uid = Number(process.env.SUDO_UID), gid = Number(process.env.SUDO_GID);
      if (Number.isSafeInteger(uid) && Number.isSafeInteger(gid)) await fs.chown(backup, uid, gid);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await fileSha256(backup) !== manifest.sourceSha256) throw new Error("An existing backup belongs to a different desktop build");
    }
  }
  const temporary = `${target}.cli-registration-${randomUUID()}`;
  try {
    await fs.copyFile(replacement, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    if (await fileSha256(temporary) !== replacementHash) throw new Error("Copied archive failed integrity verification");
    await fs.chmod(temporary, original.mode & 0o777);
    await fs.chown(temporary, original.uid, original.gid);
    const file = await fs.open(temporary, "r"); try { await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary, target);
    const directory = await fs.open(path.dirname(target), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return { target, backup, sha256: replacementHash, restored: restore };
}
