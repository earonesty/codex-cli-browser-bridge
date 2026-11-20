import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

/** Resolve the first executable on PATH, including the official npm CLI shim. */
export async function resolvePathCodex(env = process.env) {
  let entry;
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    const candidate = path.resolve(directory || ".", "codex");
    try {
      await fs.access(candidate, fs.constants.X_OK);
      if (!(await fs.stat(candidate)).isFile()) continue;
      entry = await fs.realpath(candidate);
      break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
  if (!entry) throw new Error("No codex executable found on PATH");
  if (await isNative(entry)) return entry;

  // Mirror the official @openai/codex entrypoint's optional-package/vendor lookup.
  // Never skip the selected PATH entry and silently launch some other installation.
  const root = path.dirname(path.dirname(entry));
  let metadata;
  try { metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")); } catch {}
  if (metadata?.name !== "@openai/codex" || path.basename(entry) !== "codex.js") {
    throw new Error(`Unsupported codex launcher on PATH: ${entry}; use a native binary or the official npm CLI`);
  }
  const target = { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" }[process.arch];
  if (process.platform !== "linux" || !target) throw new Error("CLI browser registration requires a supported Linux Codex binary");
  let vendor = path.join(root, "vendor");
  try {
    const manifest = createRequire(entry).resolve(`@openai/codex-linux-${process.arch}/package.json`);
    vendor = path.join(path.dirname(manifest), "vendor");
  } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  const native = await fs.realpath(path.join(vendor, target, "bin", "codex"));
  await fs.access(native, fs.constants.X_OK);
  if (!await isNative(native)) throw new Error("The selected Codex package does not contain a native Linux executable");
  return native;
}

async function isNative(filename) {
  const handle = await fs.open(filename, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    return magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally { await handle.close(); }
}
