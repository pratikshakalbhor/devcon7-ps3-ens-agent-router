/**
 * How a specialist agent produces an answer.
 *
 * Every agent does exactly the same three things: assemble a system prompt from
 * its own definition, send the caller's question as the user turn, and return
 * the model's prose. The timeout, retry and error taxonomy all come from
 * `lib/llm-client.ts`, so each agent's model call is bounded in exactly the way
 * the PS1/PS2 clients are.
 *
 * Two deliberate choices:
 *
 *  1. **JSON mode is turned off.** `loadLlmConfig()` defaults to
 *     `response_format: json_object` because PS2's answer pipeline parsed JSON.
 *     These agents answer in prose and their HTTP contract is `{ answer: string }`,
 *     so forcing JSON would only buy us a parse step for nothing. The endpoint
 *     and model id still come from config; only the response shape is dropped.
 *  2. **No shared state between agents.** Each process builds its prompt from
 *     its own `SpecialistAgent`, so nothing here can leak one agent's identity
 *     into another's reply.
 */

import { askModel, type ChatMessage } from './llm-client.js'
import { loadLlmConfig, type LlmConfig } from './llm-config.js'
import type { SpecialistAgent } from './agents.js'

export interface AnswerQuestionOptions {
  /** Endpoint configuration. Defaults to `loadLlmConfig()`. */
  readonly config?: LlmConfig | undefined
  /** Injection seam for tests. */
  readonly fetchImpl?: typeof fetch | undefined
  /** Injection seam for tests; records backoff delays that were applied. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
}

export interface AgentAnswer {
  readonly answer: string
  /** Model that actually served the request, as reported by the endpoint. */
  readonly model: string
  /** How many HTTP attempts were made, including the successful one. */
  readonly attempts: number
}

/**
 * The agent's full system prompt: its identity, plus any grounding context
 * (the invoice ledger, say) that it needs to answer real questions.
 *
 * Returns a single string rather than multiple system messages so the prompt
 * order is identical no matter which agent is running.
 */
export function buildSystemPrompt(agent: SpecialistAgent): string {
  const context = agent.context?.trim()
  if (context === undefined || context === '') return agent.systemPrompt
  return `${agent.systemPrompt}\n\n${context}`
}

/** The messages sent for one question, exposed so tests can assert on them. */
export function buildMessages(agent: SpecialistAgent, question: string): ChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(agent) },
    { role: 'user', content: question },
  ]
}

/**
 * Ask this agent's model one question.
 *
 * @throws {LlmTimeoutError} if an attempt exceeded `config.timeoutMs`.
 * @throws {LlmRateLimitError} if rate limiting persisted across every attempt.
 * @throws {LlmHttpError} for other non-2xx responses.
 * @throws {LlmNetworkError} if the endpoint was never reached.
 * @throws {LlmResponseError} if the payload was not a usable completion.
 * @throws {LlmConfigError} if the configuration is unusable.
 */
export async function answerQuestion(
  agent: SpecialistAgent,
  question: string,
  options: AnswerQuestionOptions = {},
): Promise<AgentAnswer> {
  const base = options.config ?? loadLlmConfig()
  const config: LlmConfig = { ...base, responseFormat: null }

  const result = await askModel(buildMessages(agent, question), {
    config,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
  })

  return { answer: result.content, model: result.model, attempts: result.attempts }
}
