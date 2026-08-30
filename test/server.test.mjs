import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
const { getCredentials } = await import("../src/server.mjs");

function jwt(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

test("reads the Codex OAuth profile without exposing its token", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-v2-")), "auth.json");
  fs.writeFileSync(file, JSON.stringify({ profiles: {
    "openai-codex:test@example.com": {
      provider: "openai-codex", type: "oauth", access: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }), refresh: "refresh-test",
    },
  } }));
  const credentials = await getCredentials(file);
  assert.equal(credentials.profileId, "openai-codex:test@example.com");
  assert.equal(credentials.accountId, "account-test");
  assert.ok(credentials.access.length > 10);
});

test("rejects a store without a Codex OAuth profile", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-v2-")), "auth.json");
  fs.writeFileSync(file, JSON.stringify({ profiles: {} }));
  await assert.rejects(() => getCredentials(file), /no openai-codex OAuth credentials found/);
});
