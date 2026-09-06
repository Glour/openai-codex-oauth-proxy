import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
const { buildClientResponse, buildUpstreamBody, getCredentials, parseSse } = await import("../src/server.mjs");

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

test("reads a standalone Codex CLI auth.json", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-v2-")), "auth.json");
  fs.writeFileSync(file, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-standalone" } }),
      refresh_token: "refresh-standalone",
      account_id: "account-standalone",
    },
  }));
  const credentials = await getCredentials(file);
  assert.equal(credentials.profileId, "codex-cli");
  assert.equal(credentials.accountId, "account-standalone");
});

test("rejects a store without a Codex OAuth profile", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-v2-")), "auth.json");
  fs.writeFileSync(file, JSON.stringify({ profiles: {} }));
  await assert.rejects(() => getCredentials(file), /no openai-codex OAuth credentials found/);
});

test("preserves Hermes Responses tool calls in the upstream request", () => {
  const tools = [{ type: "function", name: "lookup_payment", parameters: { type: "object" } }];
  const upstream = buildUpstreamBody({
    model: "gpt-5.6-terra",
    instructions: "Use the available tool when needed.",
    input: [{ role: "user", content: "Check payment 42" }],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    context_management: { mode: "compact" },
    reasoning: { effort: "medium" },
    prompt_cache_key: "hh-agent",
  });

  assert.equal(upstream.stream, true);
  assert.equal(upstream.model, "gpt-5.6-terra");
  assert.deepEqual(upstream.tools, tools);
  assert.equal(upstream.tool_choice, "auto");
  assert.equal(upstream.parallel_tool_calls, true);
  assert.deepEqual(upstream.context_management, { mode: "compact" });
  assert.deepEqual(upstream.reasoning, { effort: "medium" });
  assert.ok(upstream.include.includes("reasoning.encrypted_content"));
});

test("keeps a completed function-call response without requiring output text", async () => {
  const response = new Response(
    'data: {"type":"response.completed","response":{"id":"resp_tool","output":[{"type":"function_call","name":"lookup_payment","arguments":"{}"}]}}\n\n',
  );
  const parsed = await parseSse(response);
  assert.equal(parsed.text, "");
  assert.equal(parsed.response.output[0].type, "function_call");
});

test("materializes delta-only text as a standard Responses message", () => {
  const response = buildClientResponse({
    id: "resp_test",
    object: "response",
    status: "completed",
    model: "gpt-5.6-luna",
    output: [],
  }, "Готовый текст", { model: "gpt-5.6-luna", input: "Тест" });

  assert.equal(response.output_text, "Готовый текст");
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[0].role, "assistant");
  assert.deepEqual(response.output[0].content, [{
    type: "output_text",
    text: "Готовый текст",
    annotations: [],
    logprobs: [],
  }]);
});

test("preserves tool calls while adding visible delta text", () => {
  const toolCall = { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" };
  const response = buildClientResponse({ output: [toolCall] }, "Проверяю", {
    model: "gpt-5.6-terra",
    input: "Тест",
  });

  assert.deepEqual(response.output[0], toolCall);
  assert.equal(response.output[1].content[0].text, "Проверяю");
});
