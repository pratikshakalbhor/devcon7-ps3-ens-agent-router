/**
 * The ENS agent self-description record format (on-chain format **v1**).
 *
 * This file is the single source of truth for *which* ENS text record keys a
 * specialist agent publishes, how their values are shaped, and how they are
 * validated. Everything else imports from here — there are no magic record-key
 * strings anywhere else in the project.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * A specialist agent does not advertise itself in a registry contract. It
 * publishes a self-description on **its own ENS name**, as ENS *text records*
 * (ENSIP-10 `text(bytes32,string)` on the name's resolver). A router then
 * discovers candidate agents by reading those records, decides which one can
 * handle a client question, and POSTs the question to the advertised endpoint.
 *
 * The records are therefore a contract between two independently authored
 * programs. They must be: self-contained (readable with no side tables),
 * unambiguous (a value means exactly one thing), and *validatable* (a malformed
 * record is detectable without contacting the agent, so the router can skip it
 * rather than forward a client question into a dead endpoint).
 *
 * ============================================================================
 * ON-CHAIN FORMAT (v1)
 * ============================================================================
 * One agent = one ENS name = one resolver = up to four text records.
 *
 * ---------------------------------------------------------------------------
 * 1. `agent.dev.description`        REQUIRED        human/LLM-readable summary
 * ---------------------------------------------------------------------------
 *   Value shape : free text, collapsed to a single line, non-empty.
 *   Length      : 1..200 characters after whitespace normalisation.
 *   Purpose     : **the routing signal.** This string is handed verbatim to the
 *                 router's model when it decides which agent should take a
 *                 question, so it must be a self-contained statement of
 *                 *what questions this agent answers* — not of who wrote it.
 *   Example     : `Answers contract and legal wording questions for a design
 *                 studio: service agreements, IP clauses, liability wording.`
 *   Notes       : Stored verbatim on chain. Newlines are legal but break naive
 *                 UIs, so this layer collapses whitespace on write and on read
 *                 and never emits a newline. The text is **untrusted input to
 *                 whatever model reads it** — see `flags.injectionSuspected`.
 *
 * ---------------------------------------------------------------------------
 * 2. `agent.dev.endpoint`           REQUIRED        where to POST the question
 * ---------------------------------------------------------------------------
 *   Value shape : an absolute URL, no whitespace (after trimming).
 *   Scheme      : `https://` is required in general.
 *                 `http://` is permitted **only** for loopback hosts
 *                 (`localhost`, `127.0.0.1`, `[::1]`) and **only** when the
 *                 local-dev exception is explicitly enabled by the caller.
 *                 Everything else (http on a public host, `ws:`, `ftp:`,
 *                 credentials, fragments) is rejected — see `validateEndpoint`.
 *   Purpose     : the full URL the router POSTs the question body to. It is
 *                 authoritative: if it disagrees with the path in
 *                 `agent.dev.input-schema`, this URL wins (and a warning is
 *                 raised, because the disagreement itself is a seeding bug).
 *   Example     : `https://7f3c...ngrok-free.app/ask`
 *   Local dev   : a `localhost` value only resolves on the machine running the
 *                 agent. To exercise the real router end-to-end, publish a
 *                 tunnel URL (ngrok / cloudflared / bore) instead — see the
 *                 README section "Endpoint records and local development".
 *
 * ---------------------------------------------------------------------------
 * 3. `agent.dev.input-schema`       REQUIRED        how to call the agent
 * ---------------------------------------------------------------------------
 *   Value shape : a single-line *call specification* in a small, closed grammar
 *                 (parsed by `parseCallSpec`, below):
 *
 *                     METHOD PATH { FIELD, ... } -> { FIELD, ... }
 *
 *                 METHOD   := POST | PUT | PATCH | GET
 *                 PATH     := a rooted path, segments of [A-Za-z0-9._~+-]
 *                 FIELD    := NAME ": " TYPE       (NAME := [A-Za-z_][A-Za-z0-9_]*)
 *                 TYPE     := string | number | boolean | object
 *                 `{}`     := an empty field list
 *
 *                 Whitespace between tokens is flexible. `formatCallSpec`
 *                 always emits exactly one space around `->`, `:` and `,`,
 *                 and that canonical form is what this project publishes.
 *   Purpose     : tells the router the HTTP method, the path (informational —
 *                 see #2), and the *typed* shape of the request body and the
 *                 response, so it can build and then parse the call without
 *                 reading this agent's source code.
 *   Example     : `POST /ask { question: string } -> { answer: string }`
 *   Notes       : This is deliberately a tiny closed grammar rather than free
 *                 prose or full JSON Schema. The router needs three facts and
 *                 an unambiguous parse; anything it cannot parse is a malformed
 *                 record and the agent is skipped.
 *
 * ---------------------------------------------------------------------------
 * 4. `agent.dev.version`            OPTIONAL        record format version
 * ---------------------------------------------------------------------------
 *   Value shape : a positive decimal integer, no separators. e.g. `1`
 *   Default     : absent means `1`.
 *   Purpose     : lets a future reader refuse a format it does not understand
 *                 instead of misparsing it. This implementation writes `1`
 *                 explicitly and only accepts `1`.
 *
 * ============================================================================
 * DESIGN RULES THIS FILE ENFORCES
 * ============================================================================
 *  - `parseAgentRecord` **never throws**. Every malformed record comes back
 *    with `issues` populated, so a discovery pass over N names cannot lose the
 *    whole batch to one bad value. (Test case: malformed records are skipped.)
 *  - `isRoutable(record)` is the single predicate for "may a router use this?".
 *  - Serialise and parse are inverse operations, so the seed script and the
 *    reader can never disagree about the format.
 */

export const AGENT_RECORD_VERSION = 1

/** Record format versions this reader understands. */
export const SUPPORTED_AGENT_RECORD_VERSIONS: readonly number[] = [AGENT_RECORD_VERSION]

/** Namespace prefix for every record key this project owns. */
export const KEY_PREFIX = 'agent.dev.'

/** The complete, authoritative list of text record keys this project reads. */
export const AGENT_RECORD_KEYS = {
  /** One-line statement of what questions this agent answers. The routing signal. */
  description: `${KEY_PREFIX}description`,
  /** Absolute URL to POST questions to. HTTPS required outside local dev. */
  endpoint: `${KEY_PREFIX}endpoint`,
  /** Closed-grammar call specification: method, path, typed request/response. */
  inputSchema: `${KEY_PREFIX}input-schema`,
  /** Positive integer record format version. Absent means 1. */
  version: `${KEY_PREFIX}version`,
} as const

export type AgentField = keyof typeof AGENT_RECORD_KEYS
export type AgentRecordKey = (typeof AGENT_RECORD_KEYS)[AgentField]

/** Every key, in a stable order. Used for batched RPC reads. */
export const AGENT_RECORD_KEY_LIST: readonly AgentRecordKey[] = Object.values(AGENT_RECORD_KEYS)

/* ========================================================================== *
 * Bounded values
 * ========================================================================== */

/** Long enough for a real routing sentence, short enough to stay a one-liner. */
export const MAX_DESCRIPTION_LENGTH = 200

/** HTTP methods an agent may advertise. */
export const ALLOWED_METHODS = ['POST', 'PUT', 'PATCH', 'GET'] as const
export type AgentHttpMethod = (typeof ALLOWED_METHODS)[number]

/** Field types this schema's grammar accepts. */
export const ALLOWED_FIELD_TYPES = ['string', 'number', 'boolean', 'object'] as const
export type AgentFieldType = (typeof ALLOWED_FIELD_TYPES)[number]

export interface AgentFieldSpec {
  readonly name: string
  readonly type: AgentFieldType
}

/** A parsed `agent.dev.input-schema`. */
export interface AgentCallSpec {
  readonly method: AgentHttpMethod
  readonly path: string
  readonly input: readonly AgentFieldSpec[]
  readonly output: readonly AgentFieldSpec[]
}

/* ========================================================================== *
 * Endpoint policy (https-required, with an explicit localhost dev exception)
 * ========================================================================== */

export interface EndpointPolicy {
  /**
   * Permit `http://` endpoints whose host is loopback. This is the *explicit*
   * local-development exception: it is off unless a caller opts in, so a
   * production discovery pass can never accidentally trust a plaintext URL.
   */
  readonly allowLocalhostHttp: boolean
}

/** Production policy: HTTPS everywhere, no exceptions. */
export const PRODUCTION_ENDPOINT_POLICY: EndpointPolicy = { allowLocalhostHttp: false }

/** Local-dev policy: HTTPS, except plaintext on loopback. */
export const LOCAL_DEV_ENDPOINT_POLICY: EndpointPolicy = { allowLocalhostHttp: true }

/** Hosts that never leave the machine. `URL.hostname` keeps brackets on IPv6. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

export type EndpointCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Validates a `agent.dev.endpoint` value.
 *
 * The rules, in order:
 *   1. non-empty after trimming, and parses as an absolute URL;
 *   2. scheme is `https:` or `http:` (nothing else — no `ws:`, `ftp:`, ...);
 *   3. no embedded credentials (`https://user:pass@host/...`); a URL that
 *      carries a secret would publish it to everyone who reads the name;
 *   4. no fragment (a `#...` suffix is never sent in a POST target);
 *   5. if the scheme is `http:`, the host must be loopback **and** the policy
 *      must permit the local-dev exception.
 */
export function validateEndpoint(raw: string, policy: EndpointPolicy = PRODUCTION_ENDPOINT_POLICY): EndpointCheck {
  const value = raw.trim()
  if (value === '') return { ok: false, reason: 'endpoint is empty' }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: `endpoint is not an absolute URL: ${JSON.stringify(value)}` }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      reason: `endpoint scheme must be https: (got ${url.protocol.replace(':', '')}:)`,
    }
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'endpoint must not embed credentials' }
  }

  if (url.hash !== '') {
    return { ok: false, reason: 'endpoint must not contain a fragment' }
  }

  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) {
      return {
        ok: false,
        reason: 'endpoint must use https:// (http:// is allowed only on loopback hosts)',
      }
    }
    if (!policy.allowLocalhostHttp) {
      return {
        ok: false,
        reason:
          'endpoint uses http:// on a loopback host, which requires the explicit local-dev exception',
      }
    }
  }

  return { ok: true }
}

/* ========================================================================== *
 * `agent.dev.input-schema` grammar
 * ========================================================================== */

/** Result of parsing one field list. */
type FieldsResult = { readonly ok: true; readonly fields: AgentFieldSpec[] } | { readonly ok: false; readonly error: string }

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const PATH_SEGMENT_RE = /^[A-Za-z0-9._~+-]+$/

/**
 * Scanner for the call-specification grammar.
 *
 * A hand-rolled scanner rather than one big regex: the grammar nests braces, so
 * a regex either cannot express it or cannot explain *where* it failed, and a
 * useful error message is the whole point of rejecting malformed records.
 */
class CallSpecScanner {
  readonly #input: string
  #pos = 0

  constructor(input: string) {
    this.#input = input
  }

  get position(): number {
    return this.#pos
  }

  /** Skips spaces/tabs. Newlines never get here — the caller rejects them first. */
  spaces(): void {
    while (this.#pos < this.#input.length && this.#input[this.#pos] === ' ') this.#pos += 1
  }

  /** Consumes a literal token if present at the cursor. */
  accept(token: string): boolean {
    if (this.#input.startsWith(token, this.#pos)) {
      this.#pos += token.length
      return true
    }
    return false
  }

  /** Reads a run of non-space, non-structural characters as a bare token. */
  token(): string {
    this.spaces()
    const start = this.#pos
    while (this.#pos < this.#input.length) {
      const ch = this.#input[this.#pos]
      if (ch === ' ' || ch === ':' || ch === '{' || ch === '}' || ch === ',') break
      this.#pos += 1
    }
    return this.#input.slice(start, this.#pos)
  }

  fail(message: string): { readonly ok: false; readonly error: string } {
    return { ok: false, error: `${message} (at position ${this.#pos})` }
  }
}

function parseFields(scanner: CallSpecScanner): FieldsResult {
  scanner.spaces()
  if (!scanner.accept('{')) return scanner.fail("expected '{'")
  const fields: AgentFieldSpec[] = []
  scanner.spaces()

  if (scanner.accept('}')) return { ok: true, fields }

  for (;;) {
    scanner.spaces()
    const name = scanner.token()
    if (name === '') return scanner.fail('expected a field name')
    if (!NAME_RE.test(name)) return scanner.fail(`invalid field name ${JSON.stringify(name)}`)

    scanner.spaces()
    if (!scanner.accept(':')) return scanner.fail(`expected ':' after field name "${name}"`)
    scanner.spaces()

    const type = scanner.token()
    if (type === '') return scanner.fail(`expected a type after "${name}:"`)
    if (!(ALLOWED_FIELD_TYPES as readonly string[]).includes(type))
      return scanner.fail(
        `unknown type ${JSON.stringify(type)} for field "${name}"; expected one of ${ALLOWED_FIELD_TYPES.join(', ')}`,
      )

    fields.push({ name, type: type as AgentFieldType })
    scanner.spaces()

    if (scanner.accept(',')) continue
    if (scanner.accept('}')) return { ok: true, fields }
    return scanner.fail("expected ',' or '}'")
  }
}

export type CallSpecResult =
  | { readonly ok: true; readonly spec: AgentCallSpec }
  | { readonly ok: false; readonly error: string }

/**
 * Parses an `agent.dev.input-schema` value.
 *
 * Grammar: `METHOD PATH { FIELD, ... } -> { FIELD, ... }`.
 * Returns a discriminated result; never throws.
 */
export function parseCallSpec(raw: string | undefined | null): CallSpecResult {
  if (raw === undefined || raw === null) return { ok: false, error: 'value is absent' }

  const input = raw.trim()
  if (input === '') return { ok: false, error: 'value is empty' }
  if (/[\r\n]/.test(input)) return { ok: false, error: 'value must be a single line' }

  const scanner = new CallSpecScanner(input)

  const method = scanner.token().toUpperCase()
  if (method === '') return { ok: false, error: 'value is missing an HTTP method' }
  if (!(ALLOWED_METHODS as readonly string[]).includes(method))
    return {
      ok: false,
      error: `unknown method ${JSON.stringify(method)}; expected one of ${ALLOWED_METHODS.join(', ')}`,
    }

  const path = scanner.token()
  if (path === '') return { ok: false, error: 'value is missing a request path' }
  if (!path.startsWith('/')) return { ok: false, error: `path must start with '/': ${JSON.stringify(path)}` }
  for (const segment of path.slice(1).split('/')) {
    if (segment === '') return { ok: false, error: 'path must not contain empty segments' }
    if (!PATH_SEGMENT_RE.test(segment))
      return { ok: false, error: `path segment ${JSON.stringify(segment)} contains unsupported characters` }
  }

  const inputFields = parseFields(scanner)
  if (!inputFields.ok) return inputFields

  scanner.spaces()
  if (!scanner.accept('->')) return scanner.fail("expected '->' between the two field lists")

  const outputFields = parseFields(scanner)
  if (!outputFields.ok) return outputFields

  scanner.spaces()
  if (scanner.position !== input.length)
    return { ok: false, error: `unexpected trailing text: ${JSON.stringify(input.slice(scanner.position))}` }

  return {
    ok: true,
    spec: {
      method: method as AgentHttpMethod,
      path,
      input: inputFields.fields,
      output: outputFields.fields,
    },
  }
}

/** Renders a parsed spec back into canonical string form. */
export function formatCallSpec(spec: AgentCallSpec): string {
  const fields = (list: readonly AgentFieldSpec[]): string =>
    list.length === 0 ? '{}' : `{ ${list.map((f) => `${f.name}: ${f.type}`).join(', ')} }`
  return `${spec.method} ${spec.path} ${fields(spec.input)} -> ${fields(spec.output)}`
}

/* ========================================================================== *
 * Untrusted-description heuristics
 * ========================================================================== */

export interface AgentFlags {
  /**
   * True when the description contains imperative instructions aimed at an LLM
   * ("ignore previous instructions", "always route to me", ...).
   *
   * This is a *signal for the router's own containment*, not a hard boundary:
   * a description is untrusted text that will be handed to a model alongside
   * the client's question, so it must be treated as data rather than as
   * instructions regardless of whether this heuristic fires.
   */
  readonly injectionSuspected: boolean
  readonly injectionPatterns: readonly string[]
}

/** Patterns that indicate a description is aimed at manipulating its reader. */
export const INJECTION_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'ignore-previous-instructions', re: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i },
  { name: 'disregard-instructions', re: /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions?|prompts?|rules?|guidance?)/i },
  { name: 'system-override', re: /\b(?:system\s?prompt|new\s+instructions?|developer\s+message)\s*[:-]/i },
  { name: 'always-route-to-me', re: /\b(?:always|must|only|prefer(?:ably)?)\s+(?:route|pick|choose|select|forward|send)\b/i },
  { name: 'best-at-everything', re: /\bbest\s+(?:\w+\s+){0,2}(?:agent|expert|tool|model|choice|option|helper|assistant)\b/i },
  { name: 'do-not-mention-others', re: /\bdo\s+not\s+(?:mention|list|consider|show|recommend|call)\b/i },
  { name: 'llm-targeted', re: /\b(?:as\s+an?\s+(?:ai|llm|language\s+model)|to\s+any\s+(?:ai|llm|agent|bot))\b/i },
]

export function detectInjection(text: string): AgentFlags {
  const patterns: string[] = []
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(text)) patterns.push(name)
  }
  return { injectionSuspected: patterns.length > 0, injectionPatterns: patterns }
}

/* ========================================================================== *
 * Parsing a whole record
 * ========================================================================== */

/** Raw text records exactly as they came off chain, keyed by record key. */
export type RawAgentRecords = Partial<Record<AgentRecordKey, string>>

export interface AgentIssue {
  readonly field: AgentField | 'name'
  readonly severity: 'error' | 'warning'
  readonly message: string
}

/** One agent, as parsed out of its ENS text records. */
export interface AgentRecord {
  /** ENS name, e.g. `contract-helper.priya-studio-alice.eth`. */
  readonly name: string
  /** Normalised description. Empty string when absent or unusable. */
  readonly description: string
  /** Trimmed endpoint, even if it failed policy validation (so it can be shown). */
  readonly endpoint: string
  /** Parsed call specification, or null when the record is unusable. */
  readonly callSpec: AgentCallSpec | null
  /** Effective version (defaults to 1 when the record is absent). */
  readonly version: number
  readonly issues: readonly AgentIssue[]
  readonly flags: AgentFlags
}

export interface ParseAgentRecordOptions {
  /** Defaults to `PRODUCTION_ENDPOINT_POLICY` (HTTPS required). */
  readonly endpointPolicy?: EndpointPolicy
}

/** Collapse whitespace runs (incl. newlines) to single spaces and trim. */
function normaliseWhitespace(value: string): string {
  // ENS text records are arbitrary bytes. C0 controls are not whitespace to us
  // but they are not content either, so blank them before collapsing.
  return value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim()
}

/**
 * Turn raw ENS text records into a validated `AgentRecord`.
 *
 * Never throws: malformed records come back with error-severity `issues`, which
 * is what lets a discovery pass skip one bad name without abandoning the batch.
 */
export function parseAgentRecord(
  name: string,
  records: RawAgentRecords | null | undefined,
  options: ParseAgentRecordOptions = {},
): AgentRecord {
  const policy = options.endpointPolicy ?? PRODUCTION_ENDPOINT_POLICY
  const issues: AgentIssue[] = []
  const trimmedName = name.trim()
  if (trimmedName === '') {
    issues.push({ field: 'name', severity: 'error', message: 'empty ENS name' })
  }

  const read = (key: AgentRecordKey): string | undefined => {
    const value = records?.[key]
    if (value === undefined) return undefined
    const normalised = normaliseWhitespace(value)
    return normalised === '' ? undefined : normalised
  }

  const rawDescription = read(AGENT_RECORD_KEYS.description)
  const rawEndpoint = read(AGENT_RECORD_KEYS.endpoint)
  const rawInputSchema = read(AGENT_RECORD_KEYS.inputSchema)
  const rawVersion = read(AGENT_RECORD_KEYS.version)

  /* --- description ------------------------------------------------------- */
  let description = ''
  if (rawDescription === undefined) {
    issues.push({
      field: 'description',
      severity: 'error',
      message: `missing or empty text record "${AGENT_RECORD_KEYS.description}"`,
    })
  } else if (rawDescription.length > MAX_DESCRIPTION_LENGTH) {
    issues.push({
      field: 'description',
      severity: 'error',
      message: `"${AGENT_RECORD_KEYS.description}" is ${rawDescription.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}`,
    })
  } else {
    description = rawDescription
  }

  /* --- endpoint ---------------------------------------------------------- */
  let endpoint = ''
  if (rawEndpoint === undefined) {
    issues.push({
      field: 'endpoint',
      severity: 'error',
      message: `missing or empty text record "${AGENT_RECORD_KEYS.endpoint}"`,
    })
  } else {
    endpoint = rawEndpoint
    const check = validateEndpoint(rawEndpoint, policy)
    if (!check.ok) {
      issues.push({
        field: 'endpoint',
        severity: 'error',
        message: `"${AGENT_RECORD_KEYS.endpoint}" ${check.reason}`,
      })
    }
  }

  /* --- input-schema ------------------------------------------------------ */
  let callSpec: AgentCallSpec | null = null
  if (rawInputSchema === undefined) {
    issues.push({
      field: 'inputSchema',
      severity: 'error',
      message: `missing or empty text record "${AGENT_RECORD_KEYS.inputSchema}"`,
    })
  } else {
    const parsed = parseCallSpec(rawInputSchema)
    if (!parsed.ok) {
      issues.push({
        field: 'inputSchema',
        severity: 'error',
        message: `"${AGENT_RECORD_KEYS.inputSchema}" is malformed: ${parsed.error}`,
      })
    } else {
      callSpec = parsed.spec
      // The endpoint URL is authoritative for where to POST; disagreement is
      // not fatal but it is always a seeding bug, so it is reported.
      if (endpoint !== '') {
        try {
          const endpointPath = new URL(endpoint).pathname.replace(/\/+$/, '')
          const specPath = parsed.spec.path.replace(/\/+$/, '')
          if (endpointPath !== specPath) {
            issues.push({
              field: 'inputSchema',
              severity: 'warning',
              message: `path ${JSON.stringify(parsed.spec.path)} disagrees with the endpoint URL path ${JSON.stringify(new URL(endpoint).pathname)}`,
            })
          }
        } catch {
          // The endpoint already produced an error issue above.
        }
      }
    }
  }

  /* --- version ----------------------------------------------------------- */
  let version = AGENT_RECORD_VERSION
  if (rawVersion !== undefined) {
    // Absent means v1, but *present and unreadable* is a publisher error: we
    // refuse to guess at the format of a record whose declared version we
    // cannot parse, rather than misread it as v1.
    if (!/^[1-9][0-9]*$/.test(rawVersion)) {
      issues.push({
        field: 'version',
        severity: 'error',
        message: `"${AGENT_RECORD_KEYS.version}" must be a positive decimal integer; got ${JSON.stringify(rawVersion)}`,
      })
    } else {
      const parsed = Number(rawVersion)
      if (!SUPPORTED_AGENT_RECORD_VERSIONS.includes(parsed)) {
        issues.push({
          field: 'version',
          severity: 'error',
          message: `unsupported ${AGENT_RECORD_KEYS.version} ${parsed}; this reader understands ${SUPPORTED_AGENT_RECORD_VERSIONS.join(', ')}`,
        })
      } else {
        version = parsed
      }
    }
  }

  return {
    name: trimmedName,
    description,
    endpoint,
    callSpec,
    version,
    issues,
    flags: detectInjection(description),
  }
}

/**
 * The single predicate for "may a router discover and use this record?".
 *
 * Requires every value to be present and valid — a missing endpoint, a
 * non-URL endpoint, an unparseable input-schema or an unsupported version all
 * make the record *not routable*, so the discovery pass skips it.
 *
 * `flags.injectionSuspected` deliberately does not feed this predicate: it is
 * a content-trust signal for the router's prompt handling, not a well-formedness
 * check.
 */
export function isRoutable(record: AgentRecord): boolean {
  return record.issues.every((issue) => issue.severity !== 'error')
}

export function hasBlockingIssues(record: AgentRecord): boolean {
  return record.issues.some((issue) => issue.severity === 'error')
}

/** Error-severity issues only. */
export function blockingIssues(record: AgentRecord): AgentIssue[] {
  return record.issues.filter((issue) => issue.severity === 'error')
}

/* ========================================================================== *
 * Serialisation (writer side — the inverse of parseAgentRecord)
 * ========================================================================== */

export interface SerialiseAgentRecordInput {
  readonly description: string
  readonly endpoint: string
  readonly inputSchema: string
  /** Defaults to `AGENT_RECORD_VERSION`. */
  readonly version?: number
}

export interface SerialiseAgentRecordOptions {
  /**
   * Policy the endpoint is checked against. Defaults to
   * `PRODUCTION_ENDPOINT_POLICY`, i.e. HTTPS everywhere. A local-dev seed run
   * passes `LOCAL_DEV_ENDPOINT_POLICY` so it can publish a loopback URL — the
   * *same* policy the reader will later validate it with.
   */
  readonly endpointPolicy?: EndpointPolicy
}

/**
 * Render an agent's self-description into text records.
 *
 * Used by the seed script so the writer and the reader can never disagree
 * about the format. Throws on inputs that would produce an unroutable record,
 * because silently publishing a record we ourselves would skip is worse than
 * failing the run.
 */
export function serialiseAgentRecord(
  input: SerialiseAgentRecordInput,
  options: SerialiseAgentRecordOptions = {},
): RawAgentRecords {
  const policy = options.endpointPolicy ?? PRODUCTION_ENDPOINT_POLICY

  const description = normaliseWhitespace(input.description)
  if (description === '') throw new Error('description must not be empty')
  if (description.length > MAX_DESCRIPTION_LENGTH)
    throw new Error(`description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}`)

  const endpoint = input.endpoint.trim()
  const endpointCheck = validateEndpoint(endpoint, policy)
  if (!endpointCheck.ok) {
    const hint = policy.allowLocalhostHttp
      ? 'Even the localhost exception rejected this URL.'
      : 'Set ALLOW_LOCALHOST_ENDPOINT=1 to permit http:// on loopback, or publish a tunnel URL.'
    throw new Error(`endpoint rejected: ${endpointCheck.reason}. ${hint}`)
  }

  const specCheck = parseCallSpec(input.inputSchema)
  if (!specCheck.ok) throw new Error(`input-schema rejected: ${specCheck.error}`)

  const version = input.version ?? AGENT_RECORD_VERSION
  if (!SUPPORTED_AGENT_RECORD_VERSIONS.includes(version))
    throw new Error(`unsupported record version ${version}`)

  return {
    [AGENT_RECORD_KEYS.description]: description,
    [AGENT_RECORD_KEYS.endpoint]: endpoint,
    [AGENT_RECORD_KEYS.inputSchema]: formatCallSpec(specCheck.spec),
    [AGENT_RECORD_KEYS.version]: String(version),
  }
}

/* ========================================================================== *
 * Reporting
 * ========================================================================== */

/** Human-readable summary, used by `scripts/verify-agents.ts` and CLI output. */
export function describeAgentRecord(record: AgentRecord): string {
  const parts = [
    `${record.name}`,
    `  ${AGENT_RECORD_KEYS.version.padEnd(26)}: ${String(record.version)}${recordsVersion(record)}`,
    `  ${AGENT_RECORD_KEYS.description.padEnd(26)}: ${record.description === '' ? '(none)' : record.description}`,
    `  ${AGENT_RECORD_KEYS.endpoint.padEnd(26)}: ${record.endpoint === '' ? '(none)' : record.endpoint}`,
    `  ${AGENT_RECORD_KEYS.inputSchema.padEnd(26)}: ${record.callSpec === null ? '(unparseable)' : formatCallSpec(record.callSpec)}`,
    `  routable                   : ${isRoutable(record) ? 'yes' : 'no'}`,
  ]
  if (record.flags.injectionSuspected) {
    parts.push(`  ! untrusted description    : matched ${record.flags.injectionPatterns.join(', ')}`)
  }
  for (const issue of record.issues) parts.push(`  ! [${issue.severity}] ${issue.field}: ${issue.message}`)
  return parts.join('\n')
}

function recordsVersion(record: AgentRecord): string {
  return record.version === AGENT_RECORD_VERSION ? '' : ' (parsed)'
}
