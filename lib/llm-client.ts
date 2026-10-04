/**
 * Minimal OpenAI-compatible chat client.
 *
 * Ported from the PS1 project (`/mnt/d/vll ps1/lib/llm-client.ts`). Uses `fetch`
 * directly rather than a vendor SDK so the timeout and the `Retry-After` behaviour are
 * exactly what this project needs, and so both are testable without a network. Every
 * value that identifies the endpoint or the model comes from `LlmConfig`.
 *
 * One change from PS1: `config.responseFormat` is merged into the request body so the
 * endpoint is asked for JSON mode. See `LlmConfig.responseFormat` for why that is a
 * convenience and not a safety property.
 */

import { chatCompletionsUrl, loadLlmConfig, type LlmConfig } from './llm-config.js'
import {
  LlmHttpError,
  LlmNetworkError,
  LlmRateLimitError,
  LlmResponseError,
  LlmTimeoutError,
} from './llm-errors.js'

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  readonly role: ChatRole
  readonly content: string
}

export interface AskModelOptions {
  /** Endpoint configuration. Defaults to `loadLlmConfig()`. */
  readonly config?: LlmConfig | undefined
  /** Injection seam for tests. */
  readonly fetchImpl?: typeof fetch | undefined
  /** Injection seam for tests; records the backoff delays that were applied. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  /** Extra request fields merged into the JSON body. */
  readonly body?: Readonly<Record<string, unknown>> | undefined
}

export interface AskResult {
  /** Assistant reply text. */
  readonly content: string
  /** Model that actually served the request, as reported by the endpoint. */
  readonly model: string
  readonly finishReason: string | null
  readonly usage: {
    readonly promptTokens: number | null
    readonly completionTokens: number | null
    readonly totalTokens: number | null
  }
  /** How many HTTP attempts were made, including the successful one. */
  readonly attempts: number
}

/** Statuses worth retrying: rate limits plus the usual transient gateway faults. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504, 529,
])

/** Truncated so a server error page cannot flood the logs. */
const MAX_DETAIL_LENGTH = 300

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads a `Retry-After` header, which may be either a delay in seconds or an HTTP date.
 *
 * @returns Milliseconds to wait, or null when the header is absent or unparseable.
 */
export function parseRetryAfter(
  headerValue: string | null,
  now: number = Date.now(),
): number | null {
  if (headerValue === null) return null
  const trimmed = headerValue.trim()
  if (trimmed === '') return null

  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)

  const target = Date.parse(trimmed)
  if (Number.isNaN(target)) return null
  return Math.max(0, target - now)
}

function backoffDelay(config: LlmConfig, attempt: number): number {
  return clampDelay(config, config.retryBaseDelayMs * 2 ** attempt)
}

/**
 * Keeps any server-requested wait inside the configured ceiling.
 *
 * `Retry-After` is attacker- or bug-controlled: an endpoint replying `retry-after: 86400`
 * would otherwise park the caller for a day, which is exactly the unbounded hang this
 * client exists to prevent. Honouring the header means respecting it up to the cap.
 */
function clampDelay(config: LlmConfig, delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) return 0
  return Math.min(delayMs, config.maxRetryDelayMs)
}

async function readBodySnippet(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}...` : text
  } catch {
    return '<unreadable body>'
  }
}

/**
 * Performs one fetch that cannot outlive `timeoutMs`.
 *
 * The abort signal is passed to `fetch`, and the fetch promise is *also* raced against an
 * abort promise. The race matters: it means a transport that ignores the signal still
 * cannot hang the caller, so the timeout guarantee does not depend on fetch internals.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false

  const onAbort = (): void => {
    reject(new LlmTimeoutError(timeoutMs, url))
  }
  let reject!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, rejectFn) => {
    reject = rejectFn
  })
  controller.signal.addEventListener('abort', onAbort)

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), aborted])
  } catch (error) {
    // Distinguish "we aborted because it was too slow" from "the caller went away".
    if (error instanceof Error && error.name === 'AbortError' && !timedOut)
      throw new LlmNetworkError(1, error)
    throw error
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

async function toResult(response: Response, attempts: number, fallbackModel: string): Promise<AskResult> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new LlmResponseError(
      `body was not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }

  const choices = (payload as { choices?: unknown })?.choices
  if (!Array.isArray(choices) || choices.length === 0)
    throw new LlmResponseError('response contained no choices')

  const choice = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown }
  const content = choice.message?.content
  if (typeof content !== 'string' || content.trim() === '')
    throw new LlmResponseError('response choice contained no message content')

  const rawUsage = (payload as { usage?: Record<string, unknown> }).usage
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' ? value : null

  return {
    content,
    model:
      typeof (payload as { model?: unknown }).model === 'string'
        ? (payload as { model: string }).model
        : fallbackModel,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: {
      promptTokens: numberOrNull(rawUsage?.prompt_tokens),
      completionTokens: numberOrNull(rawUsage?.completion_tokens),
      totalTokens: numberOrNull(rawUsage?.total_tokens),
    },
    attempts,
  }
}

/**
 * Sends messages to an OpenAI-compatible chat completions endpoint.
 *
 * Retries transient failures (429 and the usual 5xx) with exponential backoff, honouring
 * `Retry-After` when the endpoint sends it. Retries are bounded by `maxRetries`, so total
 * wait time is bounded too. Timeouts are *not* retried; they surface immediately.
 *
 * @throws {LlmConfigError} if the configuration is unusable.
 * @throws {LlmTimeoutError} if an attempt exceeded `config.timeoutMs`.
 * @throws {LlmRateLimitError} if rate limiting persisted across every attempt.
 * @throws {LlmHttpError} for other non-2xx responses.
 * @throws {LlmNetworkError} if the endpoint was never reached.
 * @throws {LlmResponseError} if the payload was not a usable completion.
 */
export async function askModel(
  messages: readonly ChatMessage[],
  options: AskModelOptions = {},
): Promise<AskResult> {
  const config = options.config ?? loadLlmConfig()
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep

  const url = chatCompletionsUrl(config)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey !== '') headers.authorization = `Bearer ${config.apiKey}`

  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      ...(config.responseFormat ? { response_format: config.responseFormat } : {}),
      ...options.body,
    }),
  }

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const attempts = attempt + 1
    let response: Response

    try {
      response = await fetchWithTimeout(url, init, config.timeoutMs, fetchImpl)
    } catch (error) {
      if (error instanceof LlmTimeoutError) throw error
      if (attempts > config.maxRetries) throw new LlmNetworkError(attempts, error)
      await sleep(backoffDelay(config, attempt))
      continue
    }

    if (response.ok) return toResult(response, attempts, config.model)

    const detail = await readBodySnippet(response)
    const retryable = RETRYABLE_STATUSES.has(response.status)

    if (retryable && attempts <= config.maxRetries) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
      await sleep(retryAfter === null ? backoffDelay(config, attempt) : clampDelay(config, retryAfter))
      continue
    }

    if (response.status === 429) throw new LlmRateLimitError(response.status, attempts, detail)
    throw new LlmHttpError(response.status, attempts, detail)
  }

  // Unreachable: the loop either returns or throws on its final iteration.
  throw new LlmHttpError(0, config.maxRetries + 1, 'retry loop exited unexpectedly')
}
