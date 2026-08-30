# OpenAI Codex OAuth Proxy

Small text-only adapter that exposes a subset of the OpenAI Responses API on a local HTTP port and sends requests through a ChatGPT Codex OAuth session.

It is intended for internal services that support a custom OpenAI-compatible base URL, for example a Telegram bot or a background text-processing worker.

## What it supports

- `POST /v1/responses`, non-streaming text requests
- `GET /health`
- `GET /v1/models`, protected by bearer token
- Models verified with the current Codex OAuth account:
  - `gpt-5.5`
  - `gpt-5.6-terra`
  - `gpt-5.6-luna`
  - `gpt-5.6-sol`
- OAuth access-token refresh and atomic credential-file replacement
- Codex CLI `auth.json` and OpenClaw-style `auth-profiles.json` credential stores

This is deliberately not a general gateway. It does not support streaming, tools, file input, previous-response chaining, or multiple OAuth refresh owners for one credential file.

## Requirements

- Docker and Docker Compose
- A ChatGPT account with Codex access and the required model entitlement
- A dedicated OAuth credential file. Do not use one refresh-token file from multiple proxy containers or Codex clients at the same time.

The upstream is a ChatGPT Codex backend route, not the paid OpenAI Platform API. Availability and behavior can change at the upstream side. Use it only where that access path is permitted for your account and workload.

## Quick start

```bash
git clone git@github.com:Glour/openai-codex-oauth-proxy.git
cd openai-codex-oauth-proxy
cp .env.example .env
mkdir -p auth
```

Create an isolated Codex OAuth session, then place its resulting `auth.json` into `auth/auth.json`. The proxy needs both `access_token` and `refresh_token` in that file.

Generate a local bearer secret and put it into `.env` as `PROXY_BEARER_TOKEN`.

```bash
docker compose -f compose.yml up -d --build
curl http://127.0.0.1:8092/health
```

The example publishes only `127.0.0.1:8092`. Keep it local and put a trusted private network or reverse proxy with authentication in front of it if another host must access it.

## Client configuration

```text
base_url = http://127.0.0.1:8092/v1
api_key = value of PROXY_BEARER_TOKEN
model = gpt-5.6-terra
```

Example request:

```bash
curl http://127.0.0.1:8092/v1/responses \
  -H "Authorization: Bearer $PROXY_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  --data '{
    "model": "gpt-5.6-terra",
    "instructions": "Reply with exactly: OK",
    "input": "health probe",
    "store": false
  }'
```

## OAuth lifecycle

The proxy reads credentials before each request. If the access token is close to expiry, it exchanges the refresh token and replaces the credential file atomically.

Use a separate credential file per long-running refresh owner. Sharing a refresh token between independent processes can invalidate a token rotation and cause authentication failures.

Set `CODEX_REFRESH_ENABLED=false` only for a read-only smoke-test sidecar that relies on another service to refresh the same store. It is not suitable for a standalone production deployment.

## Development

```bash
npm run check
npm test
docker compose -f compose.yml config --quiet
```

## Security notes

- Never commit `.env`, `auth/`, access tokens, refresh tokens, or request logs with secrets.
- Keep the service bound to localhost by default.
- Treat the local bearer token as a password.
- Rotate the bearer token and create a new OAuth session if either leaks.
