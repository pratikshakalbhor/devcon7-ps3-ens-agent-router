# ens-agent-router — Part 1: agents and their ENS self-descriptions

Three specialist HTTP agents, and a typed on-chain format they use to describe
themselves.

| | |
|---|---|
| **Part 1 (this repo)** | contract-helper · copy-helper · invoice-helper, plus the `agent.dev.*` ENS text record format |
| **Part 2 (next)** | the router that reads those records, decides who should answer, and forwards the question |

There is deliberately **no router, no discovery loop, and no selection logic
anywhere in this codebase yet.** These agents do not know about each other, and
nothing here decides which agent should take a question. What Part 1 provides is
the contract that Part 2 will consume.

```bash
npm install
npm run check        # typecheck + lint + tests
npm run agents       # start all three on 4001 / 4002 / 4003
```

---

## The three agents

| Label | Port | What it answers |
|---|---|---|
| `contract-helper` | 4001 | Service agreements, SOWs, IP and licensing clauses, liability, indemnity, termination wording |
| `copy-helper` | 4002 | Taglines, headlines, naming, tone of voice, microcopy, editing existing copy |
| `invoice-helper` | 4003 | Invoice status, line items, payment terms, what is outstanding (ships with a demo ledger) |

The catalogue — label, on-chain description, system prompt, default port, sample
questions — lives once in [`lib/agents.ts`](lib/agents.ts). The seed script, the
server and the tests all read from it, so an agent's identity cannot drift
between them.

```bash
npm run agent:contract     # one agent
npm run agents             # all three in one process
```

---

## HTTP contract

```
POST /ask    { "question": string }   ->  200 { "answer": string }
GET  /health                          ->  200 { ok, agent, description, inputSchema, recordVersion }
```

`POST /ask` is the only method the endpoint accepts. Anything else on `/ask`
returns `405` with an `allow: POST` header; unknown paths return `404`.

Errors are always the same shape:

```json
{ "error": { "code": "bad_request", "title": "…", "detail": "…", "retryable": false } }
```

| `code` | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 | Missing/empty/over-long `question`, non-JSON body, top-level array |
| `timeout` | 504 | The model call exceeded `LLM_TIMEOUT_MS` |
| `rate_limited` | 429 | The model endpoint rate-limited us and retries ran out |
| `provider_error` | 502 | The model endpoint returned a non-2xx status |
| `provider_unreachable` | 502 | DNS/TLS/socket failure reaching the model endpoint |
| `bad_provider_response` | 502 | 2xx, but not a usable chat completion |
| `config_error` | 500 | Unusable `LLM_*` configuration |

`retryable` is explicit so a caller never retries a validation error. The
technical message — which can contain a model URL or a fragment of a provider
response — goes to the server log, never into `detail`.

The system prompt is built from the agent's own definition and the caller's
question is sent verbatim as the user turn. JSON mode is **off**: these agents
answer in prose and the HTTP contract is already `{ answer: string }`, so
forcing JSON would only add a parse step.

---

## The ENS self-description record format (on-chain format v1)

This is the deliverable Part 2's router will read.

An agent does **not** register with a contract. It publishes a self-description
on **its own ENS name**, as ENS *text records* (`ENSIP-10` `text(bytes32,string)`
on the name's resolver). One agent = one ENS name = one resolver = up to four
text records.

```
contract-helper.priya-studio-alice.eth
```

### The four keys

| Key | Required | Purpose |
|---|---|---|
| `agent.dev.description` | **yes** | One-line statement of *what questions this agent answers* — the routing signal |
| `agent.dev.endpoint` | **yes** | Absolute URL to POST the question to |
| `agent.dev.input-schema` | **yes** | Method, path, typed request/response |
| `agent.dev.version` | no | Record format version. Absent means `1` |

All four are namespaced `agent.dev.` so they never collide with `url`,
`description`, `avatar` or `com.twitter`, which wallets already render.

[`lib/agent-record-schema.ts`](lib/agent-record-schema.ts) is the single source
of truth for these names, their value shapes and their validation. There is no
record-key string anywhere else in the project.

### 1. `agent.dev.description`

- **Shape:** free text, collapsed to a single line, non-empty.
- **Length:** 1..200 characters after whitespace normalisation.
- **Purpose:** the routing signal. It is handed verbatim to the router's model
  when it decides which agent should take a question, so it must be a
  self-contained statement of *what questions this agent answers* — not of who
  wrote it.
- **Example:**
  `Answers contract and legal wording questions for a design studio: service agreements, IP clauses, liability wording.`
- Whitespace runs (including newlines) are collapsed on write and on read, so
  this layer never emits a newline.

### 2. `agent.dev.endpoint`

- **Shape:** an absolute URL after trimming.
- **Scheme:** `https://` required in general. `http://` permitted **only** for
  loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) **and only** when the
  local-dev exception is explicitly enabled.
- **Rejected:** http on a public host, `ws:`, `ftp:`, anything that is not an
  absolute URL, embedded credentials (`https://user:pass@…`) and fragments
  (`#…`).
- **Purpose:** the full URL the router POSTs the question body to. It is
  authoritative: if it disagrees with the path in `agent.dev.input-schema`, this
  URL wins and a **warning** is raised (the disagreement itself is a seeding
  bug).

### 3. `agent.dev.input-schema`

A single-line call specification in a small, closed grammar:

```
METHOD PATH { FIELD, ... } -> { FIELD, ... }
```

```
METHOD   := POST | PUT | PATCH | GET
PATH     := a rooted path; segments of [A-Za-z0-9._~+-]
FIELD    := NAME ": " TYPE        NAME := [A-Za-z_][A-Za-z0-9_]*
TYPE     := string | number | boolean | object
{}       := an empty field list
```

Whitespace between tokens is flexible. Canonical form (what this project
publishes, produced by `formatCallSpec`):

```
POST /ask { question: string } -> { answer: string }
```

Anything that does not parse is a malformed record and the agent is skipped.
This is deliberately a tiny closed grammar rather than free prose or full JSON
Schema: the router needs three facts (method, path, typed shapes) and an
unambiguous parse.

### 4. `agent.dev.version`

- **Shape:** a positive decimal integer, no separators. This implementation
  writes `1` and only accepts `1`.
- **Absent means `1`.**
- Present and *unreadable* (e.g. `one`) is an **error**, not a silent fallback:
  we refuse to guess at the format of a record whose declared version we cannot
  parse.
- An unsupported integer (e.g. `2`) is also an error, so a future reader refuses
  a format it does not understand instead of misparsing it.

### Validation and routability

`parseAgentRecord(name, records)` **never throws.** Every malformed record comes
back with `issues`, so a discovery pass over N names cannot lose the whole batch
to one bad value.

```ts
interface AgentIssue {
  field: 'name' | 'description' | 'endpoint' | 'inputSchema' | 'version'
  severity: 'error' | 'warning'
  message: string
}
```

`isRoutable(record)` is the single predicate for *"may a router use this?"* —
every issue must be non-`error`. Warnings (a path disagreement) do not block;
missing/invalid required fields and an unusable version do.

`flags.injectionSuspected` is a **separate** signal. It is set when the
description contains imperative instructions aimed at an LM reader
(`ignore previous instructions`, `always route to this agent`, …). It does
**not** feed `isRoutable`: a description is untrusted data regardless of whether
the heuristic fires, and the router must treat it as data rather than as
instructions either way.

`serialiseAgentRecord(input, options)` is the inverse of `parseAgentRecord`, and
it **throws** on any input that would produce a record this reader itself would
skip. The writer and the reader therefore cannot disagree about the format.

---

## Endpoint records and local development

`agent.dev.endpoint` is the URL a router will POST to, so the value you publish
depends entirely on where the agent is reachable *from*.

### Resolution order

Defined in [`lib/agent-endpoint.ts`](lib/agent-endpoint.ts); first match wins.

1. **`CONTRACT_HELPER_ENDPOINT` / `COPY_HELPER_ENDPOINT` / `INVOICE_HELPER_ENDPOINT`**
   — a full URL including the path. Realistic for local development, because
   each agent listens on its own port and therefore needs its own tunnel.
2. **`AGENT_PUBLIC_BASE_URL`** — one shared origin, `/ask` appended. Use this
   when a reverse proxy or ingress routes on path, so one URL reaches all three.
3. **`http://127.0.0.1:<port>/ask`** — the localhost fallback. Only legal with
   `ALLOW_LOCALHOST_ENDPOINT=1`.

### The policy

The same file derives the `EndpointPolicy` used to validate what it just
produced, so a seed run cannot publish a URL its own verifier would reject:

- `ALLOW_LOCALHOST_ENDPOINT` unset/`0` → **`PRODUCTION_ENDPOINT_POLICY`**:
  HTTPS everywhere, no exceptions.
- `ALLOW_LOCALHOST_ENDPOINT=1` → **`LOCAL_DEV_ENDPOINT_POLICY`**: HTTPS, except
  plaintext on loopback.
- Plain `http://` on a **public** host is rejected in *both* modes.

### Option A — run everything locally (no tunnel)

Everything is on one machine, so a loopback URL is honest:

```bash
ALLOW_LOCALHOST_ENDPOINT=1
CONTRACT_HELPER_ENDPOINT=http://127.0.0.1:4001/ask
COPY_HELPER_ENDPOINT=http://127.0.0.1:4002/ask
INVOICE_HELPER_ENDPOINT=http://127.0.0.1:4003/ask
```

```bash
npm run seed -- --dry-run   # check the plan
npm run seed                # publish
npm run verify              # read it back
```

The exception is explicit on purpose: a production discovery pass can never
accidentally trust a plaintext URL.

### Option B — publish a real HTTPS URL (what a second machine needs)

A `localhost` value only resolves on the machine running the agent. To exercise
a router end-to-end from anywhere else, publish a tunnel URL:

```bash
# one tunnel per agent, because each listens on its own port
ngrok http 4001   # -> https://7f3c...ngrok-free.app
ngrok http 4002
ngrok http 4003
```

or with cloudflared:

```bash
cloudflared tunnel --url http://127.0.0.1:4001
```

Then publish what the tunnel gives you:

```bash
CONTRACT_HELPER_ENDPOINT=https://7f3c...ngrok-free.app/ask
COPY_HELPER_ENDPOINT=https://…ngrok-free.app/ask
INVOICE_HELPER_ENDPOINT=https://…ngrok-free.app/ask
ALLOW_LOCALHOST_ENDPOINT=0     # not needed; https passes production policy
```

If all three are reachable through one origin on path, use
`AGENT_PUBLIC_BASE_URL=https://agents.example.com` instead and let `/ask` be
appended for you.

---

## Seeding and verifying

```bash
npm run seed -- --help
npm run seed -- --dry-run                                  # print the plan, send nothing
npm run seed -- --parent=yourname.eth                      # choose the parent 2LD
npm run seed -- --only=copy-helper,invoice-helper          # subset
npm run verify -- --help
npm run verify -- --json                                   # machine-readable, for CI
npm run verify -- --allow-localhost                        # match ALLOW_LOCALHOST_ENDPOINT=1
npm run verify -- --addresses                              # also resolve addr records
```

`npm run seed` will:

1. Inspect the parent (wrapped / unwrapped / unavailable) and refuse to run
   against a name the deployer does not control.
2. Create `<label>.<parent>` if it does not exist — `NameWrapper.setSubnodeRecord`
   when the parent is wrapped, `registry.setSubnodeOwner` + `setResolver` when it
   is not. Subnames cost gas only; there is no registration premium.
3. Write the four `agent.dev.*` records in one resolver multicall.

It is idempotent: existing names are reused and only records are rewritten, so
re-running after changing an endpoint is the intended way to update a
self-description.

`npm run verify` is **read-only**. For each name it prints the registry owner,
the resolver, every raw record, the parsed issues, and a routable yes/no, exiting
non-zero if any agent is missing or unroutable.

**You need a parent 2LD you own.** Set `AGENT_PARENT_NAME` in `.env` (or pass
`--parent=`). Testnet names mint for free at <https://sepolia.ens.domains>.

---

## Configuration

Copy [`.env.example`](.env.example) to `.env`. It is loaded automatically by
`lib/env.ts` — no dotenv dependency.

| Variable | Required for | Notes |
|---|---|---|
| `SEPOLIA_RPC_URL` | seed, verify | Any Sepolia JSON-RPC endpoint |
| `AGENT_PARENT_NAME` | seed | Parent 2LD the subnames live under |
| `PRIVATE_KEY` | seed (real run) | 32-byte hex. Leave empty for `--dry-run` |
| `ALLOW_LOCALHOST_ENDPOINT` | — | `1` enables the loopback-`http` exception |
| `CONTRACT_HELPER_ENDPOINT` … | seed | Per-agent published URL |
| `AGENT_PUBLIC_BASE_URL` | seed | Shared origin, `/ask` appended |
| `CONTRACT_HELPER_PORT` … | running agents | Default 4001 / 4002 / 4003 |
| `AGENT_HOST` | running agents | Default `127.0.0.1` |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | answering | Any OpenAI-compatible `/chat/completions` endpoint |
| `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, … | — | Bounded per-attempt timeout and bounded retries |
| `SEED_DRY_RUN` | — | `1` prints the plan without sending transactions |

---

## Testing

```bash
npm test             # vitest
npm run check        # typecheck + lint + test
```

The suite is hermetic: no RPC, no wallet, no API keys, no model quota. Model
calls go through an injected `fetch` stub ([`test/helpers.ts`](test/helpers.ts))
that records the request body, which is how the tests assert the system prompt
each agent actually sent. Chain reads are covered by `npm run verify` (read-only,
needs only `SEPOLIA_RPC_URL`).

Covered:

- the record format — key names, every malformed fixture skipped, the call-spec
  grammar, endpoint policy, serialise→parse round-trip, injection flags, version
  handling;
- the HTTP layer — all three agents, distinct prompts, validation and error
  paths, 405/404, and one test over a real OS-assigned socket;
- endpoint resolution precedence and policy derivation;
- the in-memory reader and bounded-concurrency helper.

---

## Layout

```
lib/
  agent-record-schema.ts   The on-chain format: keys, grammar, validation, serialise
  agents.ts                The agent catalogue (labels, prompts, ports, ENS names)
  agent-server.ts          Hono app: POST /ask, GET /health
  agent-answer.ts          System prompt assembly + the model call
  agent-endpoint.ts        Endpoint URL resolution and policy derivation
  ens-reader.ts            Chain / in-memory readers for agent records
  llm-*.ts                 Model client, config and error taxonomy
  present-error.ts         Internal error -> safe HTTP error
  run-agent.ts             Standalone bootstrap for one agent
agents/                    contract-helper.ts, copy-helper.ts, invoice-helper.ts
scripts/
  seed-agents.ts           Publish records to Sepolia
  verify-agents.ts         Read-only on-chain verification
  run-all-agents.ts        Start all three in one process
test/                      Hermetic vitest suite
```

---

## Not in this repo yet

- **Discovery**: finding agent names and reading their records in bulk.
- **Selection**: choosing which agent should take a question.
- **Forwarding**: POSTing the question and relaying the answer.

Those are Part 2, and they are expected to consume exactly what this Part 1
defines: `parseAgentRecord` → `isRoutable` → `record.endpoint` +
`record.callSpec`.
