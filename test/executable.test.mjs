import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePathCodex } from "../src/executable.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "path-codex-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function native(filename) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
}
test("follows PATH ordering and a changed native symlink without using old versions", async t => {
  const root = await fixture(t), bin = path.join(root, "bin"), first = path.join(root, "v1", "codex"), second = path.join(root, "v2", "codex");
  await native(first); await native(second); await fs.mkdir(bin);
  await fs.symlink(first, path.join(bin, "codex"));
  const env = { PATH: `${root}/missing:${bin}:${path.dirname(second)}` };
  assert.equal(await resolvePathCodex(env), first);
  await fs.unlink(path.join(bin, "codex")); await fs.symlink(second, path.join(bin, "codex"));
  assert.equal(await resolvePathCodex(env), second);
  await assert.rejects(resolvePathCodex({ PATH: `${root}/missing` }), /No codex executable/);
});
test("resolves the native binary behind the official npm shim, including legacy vendor layout", async t => {
  const root = await fixture(t), bin = path.join(root, "bin"), pkg = path.join(root, "node_modules", "@openai", "codex");
  await fs.mkdir(path.join(pkg, "bin"), { recursive: true }); await fs.mkdir(bin);
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex" }));
  const shim = path.join(pkg, "bin", "codex.js");
  await fs.writeFile(shim, "#!/usr/bin/env node\n", { mode: 0o755 });
  await fs.symlink(shim, path.join(bin, "codex"));
  const target = process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  const legacy = path.join(pkg, "vendor", target, "bin", "codex"); await native(legacy);
  assert.equal(await resolvePathCodex({ PATH: bin }), legacy);
  const optional = path.join(pkg, "node_modules", "@openai", `codex-linux-${process.arch}`);
  await fs.mkdir(optional, { recursive: true }); await fs.writeFile(path.join(optional, "package.json"), '{}');
  const selected = path.join(optional, "vendor", target, "bin", "codex"); await native(selected);
  assert.equal(await resolvePathCodex({ PATH: bin }), selected);
  await fs.unlink(selected);
  await assert.rejects(resolvePathCodex({ PATH: bin }), { code: "ENOENT" });
});
test("does not skip an unsupported first launcher to use a different installation", async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "first"));
  await fs.writeFile(path.join(root, "first", "codex"), '#!/bin/sh\n', { mode: 0o755 });
  await native(path.join(root, "second", "codex"));
  await assert.rejects(resolvePathCodex({ PATH: `${root}/first:${root}/second` }), /Unsupported codex launcher/);
});
