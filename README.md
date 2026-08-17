# dust-exporter

An **OpenAI- and Anthropic-compatible HTTP proxy in front of Dust agents.**

Point any OpenAI or Anthropic SDK at this proxy and talk to your Dust agents as
if they were `gpt-*` / `claude-*` models. The proxy reconciles the **stateless**
chat-completions model (the client resends the whole history every call) with
Dust's **stateful** conversation model (server keeps history; you send only the
new message), and reuses the **OAuth session of the official `dust-cli`** so you
don't have to log in twice.

```
  OpenAI / Anthropic SDK
          | HTTP (/v1/chat/completions, /v1/messages)
          v
   +-------------------+      reconcile state (fingerprint -> conversationId)
   |   dust-exporter   |----> Dust API  (create / postUserMessage /
   |  (this package)   |       streamAgentAnswerEvents)
   +-------------------+
          ^ shared dust-cli OAuth session (keychain or ~/.dust-cli/credentials.json)
```

## Why

- Dust has no OpenAI/Anthropic-compatible API. Tools like the OpenAI SDK, the
  Anthropic SDK, LiteLLM, etc. cannot talk to it directly.
- Dust manages conversation context server-side; OpenAI/Anthropic clients are
  stateless. This proxy bridges the two models transparently.

## Install

```bash
cd Dust-Exporter
npm install
```

Requires Node >= 20. Native dependency `keytar` is used to share the system
keychain with `dust-cli` (a plain-file fallback exists, see below).

> **Prerequisite — the Dust SDK.** This project depends on `@dust-tt/client` via
> a local path (`file:../dust-cli-perso/sdks/js`), i.e. the SDK built inside the
> sibling [`dust-cli-perso`](https://github.com/N0NameN0) fork. Clone that repo
> next to this one (so the relative path resolves) before `npm install`. If you
> use the published `@dust-tt/client` instead, change that line in
> `package.json` accordingly.

## Authenticate

The proxy shares credentials with the official `dust-cli`. If you are already
logged in there, **nothing to do**. Otherwise:

```bash
npm run login          # WorkOS device flow, stores tokens in the shared store
npm run status         # show auth status / backend / workspace / region
```

Credential store selection (`DUST_CREDENTIAL_STORE`):
- `auto` (default): system keychain via keytar, falls back to a JSON file.
- `keychain`: force the OS keychain (service `dust-cli`).
- `file`: force `~/.dust-cli/credentials.json` (chmod 600). Override the path
  with `DUST_CREDENTIAL_FILE`.

## Run

```bash
npm run serve                 # http://127.0.0.1:8787
# or with options:
npx tsx src/index.ts serve --port 8787 --agent claude-4.5-sonnet --api-key sk-local-xyz
```

Endpoints:
- `POST /v1/chat/completions` - OpenAI Chat Completions (stream + non-stream)
- `POST /v1/messages` - Anthropic Messages (stream + non-stream)
- `GET  /v1/models` - lists your Dust agents as models. Each entry's `id` is the
  agent display name with spaces underscored (`Claude Sonnet 5` ->
  `Claude_Sonnet_5`) and `display_name` is the name as-is; agents with no name
  or a duplicate name are listed under their `sId` instead. Ids that Claude
  Code's model picker would filter out get an `anthropic/` prefix (see below).
  Any of these ids can be sent back as `model`.
- `GET  /health`

### `model` -> agent mapping

The request `model` is resolved to a Dust agent by: exact `sId`, then
case-insensitive `sId`/name, then provider-prefix-stripped (`dust/gpt-5` ->
`gpt-5`), then the configured `--agent` default. `GET /v1/models` lists what is
available (the `id` is the agent `sId`).

## Use it

OpenAI Python SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
r = client.chat.completions.create(
    model="claude-4.5-sonnet",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(r.choices[0].message.content)
```

curl (Anthropic):

```bash
curl http://127.0.0.1:8787/v1/messages -H 'content-type: application/json' -d '{
  "model": "gpt-5", "max_tokens": 256,
  "messages": [{"role": "user", "content": "Hi"}]
}'
```

If you start with `--api-key <k>` (or `DUST_PROXY_API_KEY`), clients must send it
as `Authorization: Bearer <k>` (OpenAI) or `x-api-key: <k>` (Anthropic).

## Conversation lifecycle

Two modes control how Dust conversations are managed:

- **Ephemeral (default, recommended for Claude Code / stateless clients):** every
  request creates a throwaway Dust conversation, replays the full client history
  into it, streams the answer, then **deletes** the conversation. Result: zero
  accumulation in your Dust workspace, while context is preserved (the client
  resends the whole history each call anyway). Toggle with `--ephemeral` /
  `DUST_PROXY_EPHEMERAL=1`.
- **Persistent (`--persistent`):** the proxy keeps Dust conversations and reuses
  them across turns via fingerprint reconciliation (below). Fewer tokens
  re-sent, but conversations stay in Dust.

> Why ephemeral by default: agentic clients like Claude Code issue ~2 calls per
> turn (a main model + a "small fast" model) and inject extra context messages,
> which otherwise pile up as Dust conversations. Ephemeral mode keeps things tidy.

### State reconciliation (persistent mode)

Each request carries the full client history. The proxy fingerprints the ordered
list of **user** turns (scoped by workspace + agent). If the fingerprint of the
history *minus the last user turn* matches a known Dust conversation, it
**continues** that conversation by posting only the last user message. Otherwise
it **creates** a fresh conversation (replaying the whole transcript as the first
message when a non-empty prefix didn't match, so context is never lost). The
map is persisted to `~/.dust-cli/dust-exporter-state.json`.

Why fingerprint user turns only: they are verbatim and append-only from the
client, unlike assistant turns which a client may reformat or truncate.

### Conversation titles

Every conversation the proxy creates is titled `PROXY: <short title derived from
the first user message>`, so proxy-created conversations are easy to spot (and
filter) in your Dust workspace. Change the prefix with `--title-prefix "…"` or
`DUST_PROXY_TITLE_PREFIX`; set it to an empty string to let Dust auto-title.

### Step-cap auto-continuation

Dust caps each agent **run** at `maxStepsPerRun` steps (a per-agent setting,
e.g. 64). A long agentic task that exhausts this budget is cut off mid-flight.
Because Dust conversations are **stateful**, the proxy works around this
transparently: when it detects a run ended on the step cap (it reads the
`maxStepsPerRun` and the steps actually consumed straight from the terminal
agent message), it reposts a short "continue" message on the **same**
conversation. That starts a fresh run with a full step budget while preserving
all server-side context — no history replay. Deltas from every round stream
contiguously, so the OpenAI/Anthropic client sees one uninterrupted answer.

Bounded by `--max-continuations <n>` / `DUST_MAX_CONTINUATIONS` (default **4**,
`0` disables). A run that genuinely finishes under the cap is never continued; a
rare false positive (an agent finishing in exactly N steps) costs at most one
extra "continue" round.

## Claude Code

Claude Code speaks the Anthropic Messages API, so point it at the proxy:

```bash
# 1. start the proxy with client-tools passthrough + a default agent
npm run serve -- --agent claude-4.5-sonnet --client-tools

# 2. run Claude Code against it
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_API_KEY=dummy \
ANTHROPIC_MODEL=claude-4.5-sonnet \
ANTHROPIC_SMALL_FAST_MODEL=claude-4.5-haiku \
claude
```

Set `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` to any id listed by
`GET /v1/models` (agent name or `sId`). The `--agent` default catches any
internal model name Claude Code may send.

### Showing your agents in Claude Code's `/model` picker

`/model` only calls `GET /v1/models` when `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`
is set, and it then keeps just the ids matching `/(claude|anthropic)/i`. That is
why ids for agents named after other providers are `anthropic/`-prefixed
(`anthropic/GPT_5.6_Sol`): without it the picker would hide them. `matchAgent()`
strips the prefix, so both forms resolve.

In `~/.claude/settings.json`:

```json
{
  "model": "Claude_Sonnet_5",
  "env": {
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "<proxy --api-key, if set>"
  }
}
```

The picker caches the list in `~/.claude/cache/gateway-models.json`, keyed by base
URL, and primes it at startup: expect to relaunch `claude` once before the rows
appear. `claude --debug` logs `[gatewayDiscovery] cached N models`.

`npx tsx src/index.ts models` prints the ids to send as `model`. A model the
picker does not list is still usable by name (`/model <id>`, `ANTHROPIC_MODEL`,
or the `model` setting); Claude Code shows it as `Custom model (<id>)`.

Do not use `availableModels` for this: it is an allowlist that filters the
picker, it never adds entries. The `inferenceProvider` / `inferenceModels` /
`modelDiscoveryEnabled` keys are not user-settings keys either (they belong to
Claude Code's managed third-party config) and are ignored in
`~/.claude/settings.json`.

With `--client-tools`, **Claude Code's own tools work**: its Read/Edit/Bash/etc.
are bridged into the Dust agent (see below), so the agent drives them and Claude
Code executes them locally with its native UX (diffs, permissions). Sessions are
keyed by Claude Code's stable session id (`metadata.user_id`), so one Claude
Code conversation maps to exactly one Dust conversation.

## Client-tools passthrough (`--client-tools`)

Normally an OpenAI/Anthropic agent must drive *its own* tools via `tool_use`,
which a plain Dust agent (returning text) doesn't do. This mode bridges the gap
so a Dust agent can drive **the client's** tools:

1. The client's tool definitions are registered with Dust as a reverse-MCP
   server (dynamic, per session).
2. When the Dust agent calls a tool, the proxy parks the MCP call and surfaces
   it to the client as an Anthropic `tool_use` block (`stop_reason: tool_use`).
3. The client executes the tool locally and returns a `tool_result`.
4. The proxy feeds that result back into the parked call, resuming the (still
   alive) Dust turn — looping until the agent produces its final answer.

A single Dust conversation is held across the many HTTP round-trips a tool loop
needs. Requires OAuth (MCP registration).

**Concurrency & subagents.** Sessions are keyed by `session_id` **plus an anchor
hash of the first user message**. Claude Code runs its main agent and every
(sidechain) subagent under the *same* session id, so the anchor is what keeps
them in separate Dust conversations (no cross-talk). Tool calls the agent issues
together (parallel tools, multiple subagent launches) are batched into a single
`tool_use` response so the client can execute them concurrently.

> Difference with `--with-tools`: there the *Dust agent* owns a fixed set of
> local FS/shell tools; here the *client's* tools (e.g. all of Claude Code's)
> are used, executed by the client with its own UX.

## Local tools (experimental, opt-in)

With `--with-tools` (or `DUST_PROXY_WITH_TOOLS=1`) the proxy registers a local
**reverse-MCP** filesystem server with Dust (the same mechanism as `dust-cli`):
the agent loop runs server-side on Dust, but tool *execution* (`read_file`,
`list_files`, `search_text`, `write_file`, `run_command`) happens locally. This
**requires OAuth** (Dust rejects `sk-` API keys for MCP registration). Tools are
auto-approved. Use with care: `run_command` and `write_file` act on your machine.

## Notes / limitations

- `temperature`, `max_tokens`, `top_p`, etc. are ignored: the agent's model and
  parameters are configured server-side in Dust.
- `usage` token counts are reported as 0 (Dust does not expose them here).
- Multimodal image parts are flattened to a placeholder.
- A global `fetch` patch (`src/fetchPatch.ts`) works around a Dust SSE redirect
  bug (dust-tt#26472); it is a no-op once the server fix ships.
- Conversations are created with `context.origin = "cli"`. The Dust API only
  accepts that origin when the request identifies as the official CLI, so the
  proxy sends `User-Agent: "Dust CLI"` + `X-Dust-CLI-Version` (default `0.4.5`,
  override via `DUST_PROXY_CLI_VERSION`). Otherwise Dust returns
  `400 "This origin is not allowed"`.

## Docker

The proxy ships with a `Dockerfile` and a `docker-compose.yml`. The image runs
the TS sources directly via `tsx` (no build step) and forces the **file**
credential backend (`keytar` / the system keychain is useless in a container, so
it is omitted — no `libsecret` or native build tools needed). Credentials and
the conversation-state map are persisted on the `/data` volume.

```bash
docker compose build
```

**Authenticate once** (device flow — the URL opens on *your* machine, no browser
needed inside the container):

```bash
docker compose run --rm dust-exporter login
docker compose run --rm dust-exporter status   # should print authenticated: true
```

**Run** the proxy (listens on `http://localhost:8787`):

```bash
docker compose up -d
```

Set runtime options via a `.env` file next to `docker-compose.yml`, e.g.:

```env
DUST_PROXY_DEFAULT_AGENT=claude-4.5-sonnet
DUST_PROXY_API_KEY=sk-local-xyz
DUST_PROXY_CLIENT_TOOLS=1
```

### Reuse the host's dust-cli session

If you are already logged in with `dust login` on the host (file backend), skip
the in-container login by bind-mounting your home store. Replace the named
volume in `docker-compose.yml`:

```yaml
    volumes:
      - ${HOME}/.dust-cli:/data
```

> Note: the in-container credential file lives at `/data/credentials.json`,
> matching `dust-cli`'s `~/.dust-cli/credentials.json` schema — so a bind-mount
> of `~/.dust-cli` is read transparently (requires the `file` backend on the
> host: `DUST_CREDENTIAL_STORE=file dust login`).

### Plain `docker run`

```bash
docker build -t dust-exporter .
docker run -it --rm -v dust-data:/data dust-exporter login
docker run -d --name dust-exporter -p 8787:8787 -v dust-data:/data \
  -e DUST_PROXY_DEFAULT_AGENT=claude-4.5-sonnet dust-exporter
```

> `--with-tools` / `--client-tools` execute tools against the **container's**
> filesystem, not the host. To use them meaningfully, bind-mount your working
> directory into the container and pass the flag (e.g. append
> `serve --client-tools` to the run command).

## Develop / test

```bash
npm test          # vitest unit tests (pure logic: protocols, planner, events...)
npm run typecheck # tsc --noEmit
npm run dev       # tsx watch
```

## Layout

```
src/
  index.ts            CLI entry (serve | login | status | logout)
  server.ts           node:http server + routing
  config.ts           env-driven configuration
  fetchPatch.ts       SSE redirect workaround (dust-tt#26472)
  auth/               shared dust-cli credential store + WorkOS OAuth
  dust/               agents, planner (state reconciliation), runner, events, MCP tools
  protocols/          openai + anthropic request parsing & SSE serialization
  state/              fingerprint + persistent conversation map
test/                 vitest unit tests
```
