/**
 * Shared test doubles: a mock model transport, a fixed agent catalogue, and
 * helpers for driving the Hono app without binding a port.
 *
 * Nothing in here touches the network: `mockTransport` answers `fetch` locally
 * and records the request bodies, which is how the endpoint tests assert on the
 * system prompt each agent actually sent.
 */

import type { SpecialistAgent } from '../lib/agents.js'
import { CONTRACT_HELPER, COPY_HELPER, INVOICE_HELPER } from '../lib/agents.js'
import type { LlmConfig } from '../lib/llm-config.js'

export const CONTRACT = CONTRACT_HELPER
export const COPY = COPY_HELPER
export const INVOICE = INVOICE_HELPER
export const ALL_AGENTS: readonly SpecialistAgent[] = [CONTRACT, COPY, INVOICE]

/** A config with short timeouts and no real retry waits, for deterministic tests. */
export const TEST_LLM_CONFIG: LlmConfig = {
  baseUrl: 'http://model.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  timeoutMs: 2_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  maxRetryDelayMs: 5,
  responseFormat: null,
}

/** Wraps arbitrary assistant text in a minimal OpenAI-compatible response. */
export function completion(content: string, model = 'test-model'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

export interface CapturedCall {
  readonly url: string
  readonly body: {
    readonly model: string
    readonly messages: { role: string; content: string }[]
    readonly stream: boolean
    readonly response_format?: unknown
  }
}

export interface MockTransport {
  readonly fetchImpl: typeof fetch
  readonly calls: CapturedCall[]
}

/**
 * A `fetch` stand-in that replies with `respond(...)` and records every call.
 *
 * @param respond Either a string of assistant content, or a function of the
 * 1-based call index so a test can vary the reply across retries.
 */
export function mockTransport(
  respond: string | ((callIndex: number) => Response | Promise<Response>),
): MockTransport {
  const calls: CapturedCall[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    const body: CapturedCall['body'] = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(url), body })
    const reply = typeof respond === 'function' ? await respond(calls.length) : completion(respond)
    return reply
  }

  return { fetchImpl, calls }
}

/** The one system message a captured call carried, or null if it sent none. */
export function systemPromptOf(call: CapturedCall | undefined): string {
  return call?.body.messages.find((message) => message.role === 'system')?.content ?? ''
}

/** The one user message a captured call carried, or null if it sent none. */
export function userTextOf(call: CapturedCall | undefined): string {
  return call?.body.messages.find((message) => message.role === 'user')?.content ?? ''
}

/* ------------------------------------------------------------------------- *
 * Well-formed and deliberately malformed ENS record fixtures
 * ------------------------------------------------------------------------- */

export const WELL_FORMED_RECORDS = {
  'agent.dev.description':
    'Answers contract and legal wording questions for a design studio: service agreements, IP and licensing clauses.',
  'agent.dev.endpoint': 'https://agents.example.com/ask',
  'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  'agent.dev.version': '1',
} as const

/** Every one of these must leave `isRoutable()` false. */
export const MALFORMED_RECORDS: Readonly<Record<string, Record<string, string>>> = {
  'missing endpoint': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  },
  'missing description': {
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  },
  'missing input-schema': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
  },
  'endpoint is not a URL': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  },
  'endpoint is a bare word': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'not-a-url',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  },
  'endpoint has a forbidden scheme': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'ftp://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  },
  'endpoint embeds credentials': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://user:pass@agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  },
  'endpoint has a fragment': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask#frag',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  },
  'http on a public host': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'http://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  },
  'input-schema has no method': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': '/ask { question: string } -> { answer: string }',
  },
  'input-schema uses a disallowed method': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'TRACE /ask { question: string } -> { answer: string }',
  },
  'input-schema path is not rooted': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'POST ask { question: string } -> { answer: string }',
  },
  'input-schema has an unknown field type': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string2 } -> { answer: string }',
  },
  'input-schema is unbalanced': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string -> { answer: string }',
  },
  'input-schema is missing the arrow': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } { answer: string }',
  },
  'input-schema has trailing junk': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string } extra',
  },
  'version is unsupported': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
    'agent.dev.version': '2',
  },
  'version is not an integer': {
    'agent.dev.description': 'Answers billing questions.',
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
    'agent.dev.version': 'one',
  },
  'description is too long': {
    'agent.dev.description': 'x'.repeat(201),
    'agent.dev.endpoint': 'https://agents.example.com/ask',
    'agent.dev.input-schema': 'POST /ask { question: string } -> { answer: string }',
  },
  'everything empty': {},
}
