/**
 * Turning internal errors into something safe to show over HTTP.
 *
 * Two rules, both load-bearing:
 *
 *  1. The client gets a short `title` and `detail` written for a human. The
 *     technical message stays in the server log, because it can contain an
 *     endpoint URL, a provider name, or a fragment of a response body.
 *  2. `retryable` is explicit, so a validation error never tells a caller that
 *     trying the exact same request again would help.
 */

import {
  LlmConfigError,
  LlmError,
  LlmHttpError,
  LlmNetworkError,
  LlmRateLimitError,
  LlmResponseError,
  LlmTimeoutError,
} from './llm-errors.js'

export type ErrorCode =
  | 'bad_request'
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'provider_unreachable'
  | 'bad_provider_response'
  | 'config_error'
  | 'internal_error'

export interface PresentedError {
  readonly code: ErrorCode
  readonly title: string
  readonly detail: string
  readonly retryable: boolean
}

/**
 * A malformed request — the caller's input was wrong, not the server.
 * Extends `Error` with a `code` so `presentError` can classify it cheaply.
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

const GENERIC_INTERNAL: PresentedError = {
  code: 'internal_error',
  title: 'Something went wrong on our side',
  detail: 'The server hit an unexpected problem. Check the server log for details.',
  retryable: true,
}

export function presentError(error: unknown): PresentedError {
  if (error instanceof BadRequestError)
    return {
      code: 'bad_request',
      title: 'That request was not valid',
      detail: error.message,
      retryable: false,
    }

  if (error instanceof LlmTimeoutError)
    return {
      code: 'timeout',
      title: 'The model took too long to answer',
      detail:
        'The request was cancelled after the configured timeout. A busy or unreachable model endpoint is the usual cause.',
      retryable: true,
    }

  if (error instanceof LlmRateLimitError)
    return {
      code: 'rate_limited',
      title: 'The model is rate limiting us',
      detail: 'The provider asked us to slow down. Wait a moment and try again.',
      retryable: true,
    }

  if (error instanceof LlmHttpError)
    return {
      code: 'provider_error',
      title: 'The model provider returned an error',
      // The status is a number, not a URL or a response body, so it is safe to show.
      detail: `The provider responded with HTTP ${error.status}. This is usually a model name the endpoint does not serve, or a missing API key.`,
      retryable: error.status >= 500 || error.status === 408 || error.status === 429,
    }

  if (error instanceof LlmNetworkError)
    return {
      code: 'provider_unreachable',
      title: 'Could not reach the model endpoint',
      detail:
        'The connection failed. Check that the endpoint in LLM_BASE_URL is running and reachable from this machine.',
      retryable: true,
    }

  if (error instanceof LlmResponseError)
    return {
      code: 'bad_provider_response',
      title: 'The model replied in an unexpected format',
      detail: 'The response did not look like a chat completion. Retrying may help.',
      retryable: true,
    }

  if (error instanceof LlmConfigError)
    return {
      code: 'config_error',
      title: 'The model is not configured correctly',
      detail: `${error.message}. Check the LLM_* values in your .env file.`,
      retryable: false,
    }

  if (error instanceof LlmError) return GENERIC_INTERNAL

  return GENERIC_INTERNAL
}

export function httpStatusFor(error: unknown): number {
  const code = presentError(error).code
  switch (code) {
    case 'bad_request':
      return 400
    case 'config_error':
      return 500
    case 'rate_limited':
      return 429
    case 'timeout':
      return 504
    default:
      return 502
  }
}
