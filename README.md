# OpenAI Codex OAuth Proxy

A self-hosted OpenAI Responses API adapter backed by a ChatGPT Codex OAuth
session. It lets an application use a custom OpenAI-compatible `base_url`
without handling Codex OAuth tokens itself.

Use this README as the integration guide. For a compact execution contract for
another coding agent, read [AGENT_HANDOFF.md](AGENT_HANDOFF.md).

## What it does

The proxy accepts a narrow subset of the Responses API and forwards it to the
Codex backend through one OAuth credential store.

- `POST /v1/responses` as JSON or streaming SSE;
- text input, instructions, reasoning controls, prompt-cache fields, and
  supported Responses tool fields;
- function tools, with execution remaining in the calling application;
- `GET /v1/models` and `GET /health`;
- automatic OAuth refresh with atomic credential-file updates.

It intentionally does not support file input, `previous_response_id`, or a
single refresh token shared by independent long-running processes.

The upstream is a ChatGPT Codex backend route, not the paid OpenAI Platform
API. Its availability can change. Use it only where that access path is
permitted for the account and workload.

## Architecture

```text
Your application / agent
  -> OpenAI SDK with custom base URL and local bearer token
  -> this proxy on a private network or localhost
  -> one dedicated ChatGPT Codex OAuth credential store
  -> Codex Responses backend
```

The client owns prompts, retries, tool execution, and business logic. The
proxy owns OAuth refresh and transport translation.

## Requirements

- Docker and Docker Compose;
- a ChatGPT account with Codex access and entitlement to the selected model;
- a dedicated Codex OAuth credential file;
- a long random local bearer secret for proxy clients.

Never use the same refresh-token file from more than one proxy container or
Codex client that may refresh it. Token rotation can invalidate the other
process.

## Deploy a private instance

```sh
git clone git@github.com:Glour/openai-codex-oauth-proxy.git
cd openai-codex-oauth-proxy
cp .env.example .env
mkdir -p auth
```

Create an isolated Codex OAuth session and place its `auth.json` at
`auth/auth.json`. The proxy accepts a Codex CLI-style store containing
`tokens.access_token` and `tokens.refresh_token`, or an OpenClaw-style store
with an `openai-codex` OAuth profile.

Generate a secret and set it in `.env` as `PROXY_BEARER_TOKEN`:

```sh
openssl rand -hex 32
```

Then start and check the service:

```sh
docker compose -f compose.yml up -d --build
curl http://127.0.0.1:8092/health
```

The supplied Compose file publishes only `127.0.0.1:8092`. Preserve that
boundary. For remote clients, use a private network or a reverse proxy with
strong authentication and TLS; do not expose the port publicly.

## Configure an application

Any SDK or framework that accepts an OpenAI-compatible endpoint needs:

```text
base_url = http://127.0.0.1:8092/v1
api_key = value of PROXY_BEARER_TOKEN
model = gpt-5.6-luna
```

| Model | Recommended use |
| --- | --- |
| `gpt-5.6-luna` | Default for high-volume, bounded text work |
| `gpt-5.6-terra` | Higher-effort analysis and synthesis |
| `gpt-5.6-sol` | Evaluate per workflow before production use |
| `gpt-5.5` | Legacy compatibility where already required |

Choose models using measured result quality and latency. The proxy rejects
models outside this list.

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8092/v1",
    api_key="your-local-proxy-secret",
)

response = client.responses.create(
    model="gpt-5.6-luna",
    instructions="Reply with one concise sentence.",
    input="Describe the current task.",
)
print(response.output_text)
```

### Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8092/v1",
  apiKey: process.env.PROXY_BEARER_TOKEN,
});

const response = await client.responses.create({
  model: "gpt-5.6-terra",
  input: "Summarize the event.",
});
console.log(response.output_text);
```

### Streaming and tools

Set `stream: true` to receive SSE events from the upstream Responses API.
Function definitions are forwarded unchanged. Your application must execute a
requested function and continue its own Responses loop with the result; the
proxy never executes tools on your behalf.

## Smoke test

Run an authenticated request before directing production work to a new proxy:

```sh
curl http://127.0.0.1:8092/v1/responses \
  -H "Authorization: Bearer $PROXY_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  --data '{
    "model": "gpt-5.6-luna",
    "instructions": "Reply with exactly: OK",
    "input": "health probe",
    "store": false
  }'
```

Expected outcome: a completed Responses object with `output_text` equal to
`OK`. Then confirm the allowed model list:

```sh
curl http://127.0.0.1:8092/v1/models \
  -H "Authorization: Bearer $PROXY_BEARER_TOKEN"
```

## OAuth lifecycle and troubleshooting

The proxy reads credentials before every request. When an access token is near
expiry, it refreshes it and atomically replaces the credential file. Set
`CODEX_REFRESH_ENABLED=false` only for a read-only sidecar where another
process deliberately owns refresh.

| Symptom | First checks |
| --- | --- |
| `401 Unauthorized` | `PROXY_BEARER_TOKEN` is set and the caller sends the same value |
| `502` after a request | Proxy logs, OAuth session validity, model entitlement, and upstream availability |
| OAuth refresh failure | Ensure this is the only refresh owner; create a fresh isolated session if needed |
| Connection refused | Container status, port `8092`, firewall, and reverse-proxy target |

Do not paste OAuth JSON, bearer tokens, or raw production requests into issues
or logs.

## Release checks

```sh
npm run check
npm test
docker compose -f compose.yml config --quiet
```

For local Compose validation, `.env` and `auth/auth.json` must exist but remain
untracked. Use `.env.example` as the only committed template.

## Community and security

- [Agent integration handoff](AGENT_HANDOFF.md)
- [Contributing guide](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [MIT License](LICENSE)

Use GitHub's private vulnerability reporting flow for security issues.
