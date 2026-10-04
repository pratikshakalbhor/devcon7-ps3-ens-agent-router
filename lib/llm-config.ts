/**
 * Model endpoint configuration.
 *
 * Ported from the PS1 project (`/mnt/d/vll ps1/lib/llm-config.ts`) with one addition:
 * `responseFormat` controls whether the request asks for JSON mode. This layer is the
 * single place that knows an endpoint address or a model id — no call site ever writes
 * either as a literal.
 *
 * Defaults target a local Ollama server, the only OpenAI-compatible endpoint that needs
 * no API key, so the project runs with zero setup. Point `LLM_BASE_URL` / `LLM_API_KEY` /
 * `LLM_MODEL` at Groq, OpenRouter, Gemini's OpenAI-compatible endpoint, or anything else
 * that speaks `/chat/completions`.
 */

import { LlmConfigError } from './llm-errors.js'

export interface LlmConfig {
  /** OpenAI-compatible API root, without a trailing slash. */
  readonly baseUrl: string
  /** Sent as a bearer token. Empty string omits the Authorization header entirely. */
  readonly apiKey: string
  /** Model identifier passed in the request body. */
  readonly model: string
  /** Per-attempt timeout. A hung request cannot hang the caller for longer than this. */
  readonly timeoutMs: number
  /** Extra attempts after the first one. 0 disables retrying. */
  readonly maxRetries: number
  /** First backoff delay; doubles per attempt. */
  readonly retryBaseDelayMs: number
  /** Ceiling for a single backoff delay, including one derived from `Retry-After`. */
  readonly maxRetryDelayMs: number
  /**
   * Ask the endpoint for a JSON object matching the given schema.
   *
   * JSON mode is a *shape* guarantee, not a truth guarantee: it stops the model from
   * replying with prose we cannot parse, and does nothing to stop it from inventing a
   * name inside that JSON. `lib/verify-candidates.ts` is what stops the latter.
   */
  readonly responseFormat?: Readonly<{ type: 'json_object' }> | null
}

export const LLM_DEFAULTS = {
  // Ollama's OpenAI-compatible endpoint.
  baseUrl: 'http://localhost:11434/v1',
  // Ollama ignores the key, but most OpenAI-compatible clients require a non-empty one.
  apiKey: 'ollama',
  model: 'llama3.2',
  timeoutMs: 30_000,
  maxRetries: 3,
  retryBaseDelayMs: 500,
  maxRetryDelayMs: 8_000,
} as const satisfies Omit<LlmConfig, 'responseFormat'>

/** Environment variable backing each config field. */
export const LLM_ENV_VARS = {
  baseUrl: 'LLM_BASE_URL',
  apiKey: 'LLM_API_KEY',
  model: 'LLM_MODEL',
  timeoutMs: 'LLM_TIMEOUT_MS',
  maxRetries: 'LLM_MAX_RETRIES',
  retryBaseDelayMs: 'LLM_RETRY_BASE_DELAY_MS',
  maxRetryDelayMs: 'LLM_MAX_RETRY_DELAY_MS',
} as const satisfies Record<keyof Omit<LlmConfig, 'responseFormat'>, string>

/**
 * Reads a string setting.
 *
 * `allowEmpty` exists because blank is meaningful for exactly one field. Setting
 * `LLM_API_KEY=` explicitly says "this endpoint needs no key", which differs from
 * leaving the variable unset, where the placeholder default applies. Collapsing the two
 * would send `Authorization: Bearer ollama` to a keyless endpoint.
 */
function readString(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
  allowEmpty = false,
): string {
  const raw = env[key]
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (trimmed === '') return allowEmpty ? '' : fallback
  return trimmed
}

function readInteger(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback

  const value = Number(raw.trim())
  if (!Number.isSafeInteger(value) || value < min)
    throw new LlmConfigError(
      `${key} must be an integer >= ${min}, received ${JSON.stringify(raw)}.`,
    )
  return value
}

/**
 * Builds an `LlmConfig` from environment variables, falling back to `LLM_DEFAULTS` for
 * anything unset.
 *
 * @throws {LlmConfigError} if a numeric variable holds something unusable. Failing loudly
 * beats silently defaulting a timeout to `NaN`.
 */
export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const baseUrl = readString(env, LLM_ENV_VARS.baseUrl, LLM_DEFAULTS.baseUrl).replace(/\/+$/, '')

  return {
    baseUrl,
    apiKey: readString(env, LLM_ENV_VARS.apiKey, LLM_DEFAULTS.apiKey, true),
    model: readString(env, LLM_ENV_VARS.model, LLM_DEFAULTS.model),
    timeoutMs: readInteger(env, LLM_ENV_VARS.timeoutMs, LLM_DEFAULTS.timeoutMs, 1),
    maxRetries: readInteger(env, LLM_ENV_VARS.maxRetries, LLM_DEFAULTS.maxRetries, 0),
    retryBaseDelayMs: readInteger(
      env,
      LLM_ENV_VARS.retryBaseDelayMs,
      LLM_DEFAULTS.retryBaseDelayMs,
      0,
    ),
    maxRetryDelayMs: readInteger(
      env,
      LLM_ENV_VARS.maxRetryDelayMs,
      LLM_DEFAULTS.maxRetryDelayMs,
      0,
    ),
    responseFormat: { type: 'json_object' },
  }
}

/** Full request URL for a config's chat completions endpoint. */
export function chatCompletionsUrl(config: LlmConfig): string {
  return `${config.baseUrl}/chat/completions`
}
