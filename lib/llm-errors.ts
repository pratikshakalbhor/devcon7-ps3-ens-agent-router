/**
 * Errors raised while talking to the model endpoint.
 *
 * Ported from the PS1 project (`/mnt/d/vll ps1/lib/llm-errors.ts`) so both halves of
 * this project share one vocabulary. Kept verbatim on purpose: the retry/timeout
 * semantics in `lib/llm-client.ts` are only trustworthy if the error types match.
 */

/** Base class for every model-call failure. */
export class LlmError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LlmError'
  }
}

/** Raised when an environment variable holds an unusable value. */
export class LlmConfigError extends LlmError {
  constructor(message: string) {
    super(message)
    this.name = 'LlmConfigError'
  }
}

/**
 * Raised when a request exceeded its per-attempt timeout and was aborted.
 *
 * Timeouts surface immediately rather than being retried: a silent multi-attempt stall
 * is worse than a prompt, actionable error.
 */
export class LlmTimeoutError extends LlmError {
  readonly timeoutMs: number

  constructor(timeoutMs: number, url: string) {
    super(`Model request to ${url} timed out after ${timeoutMs}ms and was aborted.`)
    this.name = 'LlmTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** Raised when the endpoint rate-limited us and the retry budget ran out. */
export class LlmRateLimitError extends LlmError {
  readonly status: number
  readonly attempts: number

  constructor(status: number, attempts: number, detail?: string) {
    super(
      `Model endpoint rate-limited the request (HTTP ${status}) after ${attempts} attempt(s).${detail === undefined ? '' : ` ${detail}`}`,
    )
    this.name = 'LlmRateLimitError'
    this.status = status
    this.attempts = attempts
  }
}

/** Raised for a non-2xx response that was not retried, or whose retries ran out. */
export class LlmHttpError extends LlmError {
  readonly status: number
  readonly attempts: number

  constructor(status: number, attempts: number, detail: string) {
    super(`Model endpoint returned HTTP ${status} after ${attempts} attempt(s). ${detail}`)
    this.name = 'LlmHttpError'
    this.status = status
    this.attempts = attempts
  }
}

/** Raised when the request never produced an HTTP response (DNS, TLS, socket errors). */
export class LlmNetworkError extends LlmError {
  readonly attempts: number

  constructor(attempts: number, cause: unknown) {
    super(`Model request failed after ${attempts} attempt(s): ${describe(cause)}`, { cause })
    this.name = 'LlmNetworkError'
    this.attempts = attempts
  }
}

/** Raised when the endpoint answered 2xx but the payload was not a usable completion. */
export class LlmResponseError extends LlmError {
  constructor(detail: string) {
    super(`Model endpoint returned an unusable response: ${detail}`)
    this.name = 'LlmResponseError'
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
