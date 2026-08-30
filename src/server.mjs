import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";

const PORT = Number.parseInt(process.env.PORT || "8788", 10);
const HOST = process.env.HOST || "0.0.0.0";
const AUTH_FILE = process.env.CODEX_AUTH_FILE || "/auth-store/auth-profiles.json";
const PROXY_TOKEN = process.env.PROXY_BEARER_TOKEN?.trim() || "";
const DEFAULT_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5.5";
const TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || "120000", 10);
const MAX_BODY_BYTES = 1024 * 1024;
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_SKEW_MS = 60_000;
const REFRESH_ENABLED = process.env.CODEX_REFRESH_ENABLED !== "false";
const MODEL_CANDIDATES = ["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"];

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

function requireAuth(req) {
  return !PROXY_TOKEN || req.headers.authorization === `Bearer ${PROXY_TOKEN}`;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function decodeJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("invalid OAuth access token");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function loadAuthRecord(authFile) {
  const store = JSON.parse(fs.readFileSync(authFile, "utf8"));
  if (store?.tokens?.access_token && store?.tokens?.refresh_token) {
    return {
      access: store.tokens.access_token,
      refresh: store.tokens.refresh_token,
      expires: 0,
      accountId: store.tokens.account_id || "",
      persist: (fresh, accountId) => ({
        ...store,
        tokens: { ...store.tokens, access_token: fresh.access_token, refresh_token: fresh.refresh_token, ...(accountId ? { account_id: accountId } : {}) },
        last_refresh: Date.now(),
      }),
    };
  }
  const found = Object.entries(store?.profiles || {}).find(([, p]) => p?.provider === "openai-codex" && p?.type === "oauth");
  if (!found) throw new Error("no openai-codex OAuth credentials found");
  const [profileId, profile] = found;
  if (!profile.access || !profile.refresh) throw new Error("OAuth profile is missing access or refresh token");
  return {
    profileId,
    access: profile.access,
    refresh: profile.refresh,
    expires: Number(profile.expires || 0),
    accountId: profile.accountId || "",
    persist: (fresh, accountId) => ({
      ...store,
      profiles: { ...store.profiles, [profileId]: { ...profile, access: fresh.access_token, refresh: fresh.refresh_token, expires: Date.now() + fresh.expires_in * 1000, ...(accountId ? { accountId } : {}) } },
    }),
  };
}

function writeAuthRecord(authFile, value) {
  const temp = `${authFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, authFile);
}

async function refreshCredentials(record, authFile) {
  if (!REFRESH_ENABLED) throw new Error("OAuth access token expired and refresh is disabled");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: record.refresh, client_id: OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`OAuth token refresh failed with HTTP ${response.status}`);
  const fresh = await response.json();
  if (!fresh.access_token || !fresh.refresh_token || typeof fresh.expires_in !== "number") throw new Error("OAuth token refresh response is incomplete");
  const accountId = decodeJwt(fresh.access_token)["https://api.openai.com/auth"]?.chatgpt_account_id || record.accountId;
  writeAuthRecord(authFile, record.persist(fresh, accountId));
  return { access: fresh.access_token, accountId, profileId: record.profileId || "codex-cli" };
}

export async function getCredentials(authFile = AUTH_FILE) {
  const record = loadAuthRecord(authFile);
  const jwt = decodeJwt(record.access);
  const accountId = jwt["https://api.openai.com/auth"]?.chatgpt_account_id || record.accountId;
  const expiresAt = record.expires || Number(jwt.exp || 0) * 1000;
  if (!accountId) throw new Error("OAuth token has no ChatGPT account id");
  if (expiresAt && expiresAt <= Date.now() + REFRESH_SKEW_MS) return refreshCredentials(record, authFile);
  return { profileId: record.profileId || "codex-cli", access: record.access, accountId };
}

function normalizeInput(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) return input;
  throw new Error("input must be a non-empty string or array");
}

function outputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text" || item?.type === "text")
    .map((item) => item.text || "")
    .join("");
}

async function parseSse(response) {
  if (!response.body) throw new Error("Codex returned no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed;
  let deltaText = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const packet = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = packet.split("\n").filter((x) => x.startsWith("data:")).map((x) => x.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        if (event.type === "error") throw new Error(event.message || "Codex request failed");
        if (event.type === "response.failed") throw new Error(event.response?.error?.message || "Codex request failed");
        if (event.type === "response.output_text.delta") deltaText += event.delta || "";
        if (["response.completed", "response.done", "response.incomplete"].includes(event.type)) completed = event.response;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!completed) throw new Error("Codex stream ended without a completed response");
  const text = outputText(completed) || deltaText;
  if (!text) throw new Error("Codex returned empty output");
  return { response: completed, text };
}

export async function codexResponse(body, credentials) {
  const activeCredentials = credentials || await getCredentials();
  const model = String(body.model || DEFAULT_MODEL).replace(/^openai-codex\//, "");
  if (!MODEL_CANDIDATES.includes(model)) throw new Error(`model is not enabled in this proxy: ${model}`);
  const input = normalizeInput(body.input);
  if (!input.length) throw new Error("input is required");
  const upstreamBody = {
    model,
    store: false,
    stream: true,
    instructions: String(body.instructions || "You are a concise text-processing service."),
    input,
    text: body.text || { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: body.prompt_cache_key,
  };
  if (body.reasoning) upstreamBody.reasoning = body.reasoning;
  const result = await fetch(CODEX_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${activeCredentials.access}`,
      "chatgpt-account-id": activeCredentials.accountId,
      originator: "openai-codex-oauth-proxy",
      "user-agent": "openai-codex-oauth-proxy/0.2",
      "openai-beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!result.ok) {
    const message = (await result.text()).slice(0, 500);
    throw new Error(`Codex upstream HTTP ${result.status}: ${message || result.statusText}`);
  }
  const { response, text } = await parseSse(result);
  return {
    id: response.id || `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: response.status || "completed",
    model,
    output_text: text,
    output: [{
      id: response.id ? `${response.id}_message` : `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: response.usage || {},
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "openai-codex-oauth-proxy", defaultModel: DEFAULT_MODEL });
    }
    if (!requireAuth(req)) return send(res, 401, { error: { message: "Unauthorized", type: "authentication_error" } });
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(res, 200, { object: "list", data: MODEL_CANDIDATES.map((id) => ({ id, object: "model", owned_by: "openai-codex-oauth" })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      const body = await readJson(req);
      if (body.stream === true) {
        return send(res, 400, { error: { message: "stream=true is not supported by this text-only proxy", type: "invalid_request_error" } });
      }
      return send(res, 200, await codexResponse(body));
    }
    return send(res, 404, { error: { message: "Route not found" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return send(res, 502, { error: { message, type: "upstream_error" } });
  }
});

if (process.env.NODE_ENV !== "test") server.listen(PORT, HOST, () => console.log(`OpenAI Codex OAuth proxy listening on ${HOST}:${PORT}`));
