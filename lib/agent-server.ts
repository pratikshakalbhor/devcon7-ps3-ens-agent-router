/**
 * The agent HTTP layer: one POST endpoint per specialist agent.
 *
 * Dependencies are injected rather than imported directly, so the whole request
 * path can be exercised in tests with no network and no model key.
 *
 * The contract, which is also what `agent.dev.input-schema` advertises on chain:
 *
 *     POST /ask  { "question": string }  ->  200 { "answer": string }
 *
 * plus a `GET /health` liveness probe that returns no model output and touches
 * no configuration, so it stays useful even when the model endpoint is down.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { serve, type ServerType } from '@hono/node-server'

import { answerQuestion } from './agent-answer.js'
import type { SpecialistAgent } from './agents.js'
import type { LlmConfig } from './llm-config.js'
import { BadRequestError, httpStatusFor, presentError, type PresentedError } from './present-error.js'
import { AGENT_RECORD_VERSION } from './agent-record-schema.js'

/** Caps on caller input, so one request cannot allocate or transmit without bound. */
export const LIMITS = {
  /** Generous for a natural-language question, short enough to keep one call cheap. */
  questionChars: 2_000,
  /** Request bodies are small JSON documents; anything larger is refused. */
  bodyBytes: 16 * 1024,
} as const

export interface AgentServerDeps {
  readonly agent: SpecialistAgent
  /** Injectable for tests; defaults to the real model call. */
  readonly ask?: typeof answerQuestion
  /** Model endpoint configuration. Defaults to `loadLlmConfig()`. */
  readonly llmConfig?: LlmConfig
  /** Model transport seam for tests. */
  readonly fetchImpl?: typeof fetch
  /** Retry-sleep seam for tests. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
}

function sendError(c: Context, error: unknown, context: string): Response {
  const presented: PresentedError = presentError(error)
  // The technical message goes to the server log, never to the client: it can
  // contain an endpoint URL or a provider response fragment.
  console.error(
    `[${context}] ${presented.code}:`,
    error instanceof Error ? error.message : String(error),
  )
  c.header('cache-control', 'no-store')
  c.header('x-content-type-options', 'nosniff')
  const status = httpStatusFor(error) as ContentfulStatusCode
  return c.json({ error: presented }, status)
}

/** Reads a bounded JSON body, refusing anything oversized rather than buffering it. */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > LIMITS.bodyBytes)
    throw new BadRequestError(`The request was too large (limit ${LIMITS.bodyBytes} bytes).`)

  const text = await c.req.text()
  if (Buffer.byteLength(text) > LIMITS.bodyBytes)
    throw new BadRequestError(`The request was too large (limit ${LIMITS.bodyBytes} bytes).`)
  if (text.trim() === '') return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BadRequestError('The request body was not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new BadRequestError('Expected a JSON object at the top level.')
  return parsed as Record<string, unknown>
}

function requireQuestion(body: Record<string, unknown>): string {
  const value = body.question
  if (typeof value !== 'string' || value.trim() === '')
    throw new BadRequestError('Provide a non-empty "question" string.')
  if (value.length > LIMITS.questionChars)
    throw new BadRequestError(
      `That question is longer than the ${LIMITS.questionChars} character limit.`,
    )
  return value.trim()
}

/** Build the Hono app for one agent. Pure: no socket is opened. */
export function createAgentApp(deps: AgentServerDeps): Hono {
  const app = new Hono()
  const { agent } = deps

  app.get('/health', (c) =>
    c.json(
      {
        ok: true,
        agent: agent.label,
        description: agent.description,
        inputSchema: agent.inputSchema,
        recordVersion: AGENT_RECORD_VERSION,
      },
      200,
    ),
  )

  app.on(['GET', 'PUT', 'PATCH', 'DELETE'], '/ask', (c) => {
    c.header('allow', 'POST')
    c.header('cache-control', 'no-store')
    c.header('x-content-type-options', 'nosniff')
    return c.json(
      {
        error: {
          code: 'bad_request',
          title: 'That endpoint needs a POST request',
          detail: 'POST the question body to this address.',
          retryable: false,
        },
      },
      405,
    )
  })

  app.post('/ask', async (c) => {
    try {
      const body = await readJsonBody(c)
      const question = requireQuestion(body)

      const ask = deps.ask ?? answerQuestion
      const result = await ask(agent, question, {
        config: deps.llmConfig,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      })

      c.header('cache-control', 'no-store')
      c.header('x-content-type-options', 'nosniff')
      return c.json({ answer: result.answer }, 200)
    } catch (error) {
      return sendError(c, error, agent.label)
    }
  })

  app.onError((error, c) => sendError(c, error, agent.label))

  app.notFound((c) => {
    c.header('content-type', 'text/plain; charset=utf-8')
    c.header('cache-control', 'no-store')
    // Only /ask and /health exist. Anything else is a wrong URL, not a wrong method.
    return c.text('Not found', 404)
  })

  return app
}

export interface AgentServerHandle {
  readonly app: Hono
  readonly server: ServerType
  /** The port actually bound (useful when starting on port 0 in tests). */
  readonly port: number
  /** Resolves once the listener has shut down. */
  close(): Promise<void>
}

/**
 * Bind an agent to a port.
 *
 * `port` may be `0`, in which case the OS picks one and the handle reports it
 * back — that is what the endpoint tests use so the suite can run in parallel.
 *
 * Defaults to loopback so a locally-running agent is not reachable from the
 * network by accident. A container or a shared dev box can pass `'0.0.0.0'`.
 */
export function startAgentServer(
  deps: AgentServerDeps,
  port: number,
  hostname = '127.0.0.1',
): Promise<AgentServerHandle> {
  const app = createAgentApp(deps)

  return new Promise<AgentServerHandle>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      resolve({
        app,
        server,
        port: info.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })

    server.once('error', reject)
  })
}
