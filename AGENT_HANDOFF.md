# Agent Integration Handoff

This is the implementation contract for an engineer or coding agent that
needs to add the proxy to another project.

## Goal

Route an OpenAI Responses-compatible client through a locally hosted service
that uses one isolated ChatGPT Codex OAuth credential store. The application
continues to call `POST /v1/responses`; it does not handle OAuth tokens.

## Integration checklist

1. Run one proxy instance on the same private network as the client.
2. Create a unique long random `PROXY_BEARER_TOKEN` for that instance.
3. Create a dedicated Codex OAuth credential file. Do not share its refresh
   token with another long-running process.
4. Configure the client with `base_url=http://PROXY_HOST:PORT/v1`, the bearer
   token as its API key, and an enabled model.
5. Call `/health`, then make one authenticated text request before switching
   production traffic.
6. Keep the proxy on a private network or localhost. Do not expose it directly
   to the public internet.

## Supported contract

| Capability | Behavior |
| --- | --- |
| `POST /v1/responses` | JSON response by default; SSE passthrough when `stream: true` |
| `GET /v1/models` | Authenticated list of enabled models |
| `GET /health` | Unauthenticated local liveness response only |
| Text input | A string or a Responses input array |
| Tools | `tools`, `tool_choice`, and tool-call output are forwarded; the client executes tools and continues its own loop |
| Models | `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`; legacy `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol` |

The proxy does not support file input, `previous_response_id`, or concurrent
refresh owners for one credential file.

## Model selection

- `gpt-6-luna`: high-volume, bounded text operations.
- `gpt-6-sol`: QA analysis and synthesis.
- `gpt-6-astra`: complex cases after workflow-specific evaluation.

Choose models per workflow and measure actual result quality and latency.

## Client examples

Python:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8092/v1",
    api_key="the-value-of-PROXY_BEARER_TOKEN",
)

response = client.responses.create(
    model="gpt-6-luna",
    instructions="Return concise JSON only.",
    input="Summarize this event.",
)
print(response.output_text)
```

Node.js:

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8092/v1",
  apiKey: process.env.PROXY_BEARER_TOKEN,
});

const response = await client.responses.create({
  model: "gpt-6-sol",
  input: "Review this text.",
});
console.log(response.output_text);
```

For streaming, pass `stream: true` and consume the Responses SSE events from
your SDK. For tools, keep execution in the client and continue the standard
Responses loop with the function output.

## Verification and operations

```sh
curl http://127.0.0.1:8092/health

curl http://127.0.0.1:8092/v1/models \
  -H "Authorization: Bearer $PROXY_BEARER_TOKEN"
```

For a full smoke request, use the example in [README.md](README.md#smoke-test).
If requests fail with `401`, check the local bearer token. If they fail with
`502`, inspect proxy logs, OAuth validity, model entitlement, and upstream
availability. Do not put credential content in logs or tickets.

## Security boundary

- The OAuth file and proxy bearer token are secrets. Mount or inject them at
  runtime; never commit them.
- Bind the service to `127.0.0.1` by default.
- Rotate the bearer token and use a fresh OAuth session after a leak.
- The upstream is a ChatGPT Codex backend, not the paid OpenAI Platform API.
  Use it only where that access path is permitted for the account and workload.
