import assert from "node:assert/strict";
import test from "node:test";

import { prepareCodexArgs } from "../src/bridge.mjs";

test("enables computer_use for exec", () => {
  assert.deepEqual(prepareCodexArgs(["exec", "hello"]), [
    "exec",
    "--enable",
    "computer_use",
    "hello",
  ]);
});

test("normalizes the commonly attempted hyphenated feature name", () => {
  assert.deepEqual(
    prepareCodexArgs(["exec", "--enable", "computer-use", "hello"]),
    ["exec", "--enable", "computer_use", "hello"],
  );
});

test("does not add a duplicate feature flag", () => {
  assert.deepEqual(
    prepareCodexArgs(["exec", "--enable", "computer_use", "hello"]),
    ["exec", "--enable", "computer_use", "hello"],
  );
});

test("enables computer_use for non-exec commands", () => {
  assert.deepEqual(prepareCodexArgs(["resume", "--last"]), [
    "--enable",
    "computer_use",
    "resume",
    "--last",
  ]);
});
