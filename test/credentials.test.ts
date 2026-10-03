import assert from "node:assert/strict";
import test from "node:test";
import { generateProcessTokens } from "../src/processCredentials";
test("process credentials are distinct and rotate", () => {
  const first = generateProcessTokens(), second = generateProcessTokens();
  assert.notEqual(first.masterToken, first.clientToken);
  assert.notEqual(first.masterToken, second.masterToken);
  assert.notEqual(first.clientToken, second.clientToken);
  assert.ok(first.masterToken.length >= 43);
  assert.ok(first.clientToken.length >= 43);
});
