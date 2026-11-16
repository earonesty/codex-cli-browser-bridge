import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { patchDesktopSource, desktopPatchMarker } from "./desktop-patch.mjs";

function entries(node, prefix = "") {
  return Object.entries(node.files ?? {}).flatMap(([name, value]) => value.files
    ? entries(value, `${prefix}/${name}`) : [{ name: `${prefix}/${name}`, meta: value }]);
}

export async function readArchiveHeader(filename) {
  const file = await fs.open(filename, "r");
  try {
    const prefix = Buffer.alloc(16); await file.read(prefix, 0, 16, 0);
    const pickleSize = prefix.readUInt32LE(4), length = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || pickleSize > 16 * 1024 * 1024 || length + 8 > pickleSize) throw new Error("Unsupported ASAR header");
    const json = Buffer.alloc(length); await file.read(json, 0, length, 16);
    return { header: JSON.parse(json), dataStart: 8 + pickleSize };
  } finally { await file.close(); }
}

function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = (json.length + 4 + 3) & ~3;
  const buffer = Buffer.alloc(12 + payloadSize);
  buffer.writeUInt32LE(4, 0); buffer.writeUInt32LE(payloadSize + 4, 4);
  buffer.writeUInt32LE(payloadSize, 8); buffer.writeUInt32LE(json.length, 12);
  json.copy(buffer, 16);
  return buffer;
}

export async function fileSha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function prepareDesktopPatch(input, output) {
  const { header, dataStart } = await readArchiveHeader(input);
  const sourceFile = await fs.open(input, "r");
  let target, source;
  try {
    for (const entry of entries(header)) {
      if (!entry.name.startsWith("/.vite/build/") || !entry.name.endsWith(".js") || entry.meta.offset === undefined) continue;
      const buffer = Buffer.alloc(entry.meta.size);
      await sourceFile.read(buffer, 0, buffer.length, dataStart + Number(entry.meta.offset));
      if (!buffer.includes("async readLocalWorkBrowserAccess(e){")) continue;
      if (target) throw new Error("Multiple desktop authorization handlers found");
      target = entry; source = buffer.toString();
    }
  } finally { await sourceFile.close(); }
  if (!target) throw new Error("Desktop authorization handler was not found");
  const replacement = Buffer.from(patchDesktopSource(source));
  const offset = Number(target.meta.offset), originalSize = target.meta.size;
  const delta = replacement.length - originalSize;
  for (const { meta } of entries(header)) {
    if (meta.offset !== undefined && Number(meta.offset) > offset) meta.offset = String(Number(meta.offset) + delta);
  }
  target.meta.size = replacement.length;
  const oldIntegrity = target.meta.integrity;
  if (!oldIntegrity || oldIntegrity.algorithm !== "SHA256" || !Number.isSafeInteger(oldIntegrity.blockSize) || oldIntegrity.blockSize <= 0) throw new Error("Unsupported ASAR file integrity metadata");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const blocks = [];
  for (let i = 0; i < replacement.length; i += oldIntegrity.blockSize) blocks.push(hash(replacement.subarray(i, i + oldIntegrity.blockSize)));
  target.meta.integrity = { algorithm: "SHA256", hash: hash(replacement), blockSize: oldIntegrity.blockSize, blocks };
  const destination = await fs.open(output, "wx", 0o600);
  try {
    await destination.writeFile(encodeHeader(header));
    async function copy(start, end) {
      if (end < start) return;
      for await (const chunk of createReadStream(input, { start, end })) await destination.writeFile(chunk);
    }
    await copy(dataStart, dataStart + offset - 1);
    await destination.writeFile(replacement);
    await copy(dataStart + offset + originalSize, (await fs.stat(input)).size - 1);
    await destination.sync();
  } catch (error) {
    await fs.unlink(output).catch(() => {}); throw error;
  } finally { await destination.close(); }
  return { version: 1, marker: desktopPatchMarker, input, output, member: target.name, sourceSha256: await fileSha256(input), patchedSha256: await fileSha256(output), originalMemberSha256: hash(source), patchedMemberSha256: hash(replacement) };
}
