import { afterEach, describe, expect, it } from 'vitest'

import { MAX_DESCRIPTION_LENGTH } from '../lib/agent-record-schema.js'
import { buildSystemPrompt } from '../lib/agent-answer.js'
import { createAgentApp, startAgentServer, type AgentServerDeps } from '../lib/agent-server.js'
import type { SpecialistAgent } from '../lib/agents.js'
import type { LlmConfig } from '../lib/llm-config.js'
import { LlmTimeoutError } from '../lib/llm-errors.js'
import {
  ALL_AGENTS,
  CONTRACT,
  COPY,
  INVOICE,
  TEST_LLM_CONFIG,
  mockTransport,
  systemPromptOf,
  userTextOf,
} from './helpers.js'

/** Build an app for one agent wired to a mock model transport. */
function appFor(
  agent: SpecialistAgent,
  respond: string | ((callIndex: number) => Response | Promise<Response>),
  config: LlmConfig = TEST_LLM_CONFIG,
) {
  const transport = mockTransport(respond)
  const deps: AgentServerDeps = { agent, llmConfig: config, fetchImpl: transport.fetchImpl }
  return { app: createAgentApp(deps), transport, deps }
}

async function postJson(app: ReturnType<typeof createAgentApp>, body: unknown, path = '/ask') {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /ask — each specialist agent', () => {
  for (const agent of ALL_AGENTS) {
    describe(agent.label, () => {
      it('answers a sample question with the model reply', async () => {
        const { app } = appFor(agent, `ANSWER FROM ${agent.label}`)

        const response = await postJson(app, { question: agent.sampleQuestions[0] })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('application/json')

        const payload = (await response.json()) as { answer: string }
        expect(payload).toEqual({ answer: `ANSWER FROM ${agent.label}` })
        // Only the documented field — nothing else leaks into the response.
        expect(Object.keys(payload)).toEqual(['answer'])
      })

      it('sends its own distinct system prompt and forwards the question verbatim', async () => {
        const { app, transport } = appFor(agent, 'ok')
        const question = 'A precise question about the work.'

        const response = await postJson(app, { question })
        expect(response.status).toBe(200)

        expect(transport.calls).toHaveLength(1)
        const call = transport.calls[0]
        expect(call?.url).toBe('http://model.test/v1/chat/completions')
        expect(call?.body.model).toBe('test-model')
        expect(systemPromptOf(call)).toBe(buildSystemPrompt(agent))
        expect(userTextOf(call)).toBe(question)
      })

      it('sends exactly one system and one user message, with JSON mode off', async () => {
        const { app, transport } = appFor(agent, 'ok')
        await postJson(app, { question: 'hello' })

        const body = transport.calls[0]?.body
        expect(body?.messages.map((message) => message.role)).toEqual(['system', 'user'])
        expect(body?.stream).toBe(false)
        // The agent answers in prose, so it must not ask the endpoint for JSON.
        expect(body?.response_format).toBeUndefined()
      })

      it('rejects a request with no question', async () => {
        const { app } = appFor(agent, 'ok')
        const response = await postJson(app, {})
        expect(response.status).toBe(400)
        const payload = (await response.json()) as { error: { code: string; retryable: boolean } }
        expect(payload.error.code).toBe('bad_request')
        expect(payload.error.retryable).toBe(false)
      })

      it('reports a provider failure as a 502, never as the raw upstream body', async () => {
        const failing: typeof fetch = async () =>
          new Response('upstream secret detail', { status: 500 })
        const deps: AgentServerDeps = {
          agent,
          llmConfig: TEST_LLM_CONFIG,
          fetchImpl: failing,
        }
        const response = await createAgentApp(deps).request('/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: 'hello' }),
        })

        expect(response.status).toBe(502)
        const text = JSON.stringify(await response.json())
        expect(text).not.toContain('upstream secret detail')
        expect(text).toContain('provider_error')
      })

      it('reports a model timeout as a 504', async () => {
        const hang: typeof fetch = () => new Promise<Response>(() => {})
        const config: LlmConfig = { ...TEST_LLM_CONFIG, timeoutMs: 40 }
        const response = await createAgentApp({ agent, llmConfig: config, fetchImpl: hang }).request(
          '/ask',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question: 'hello' }),
          },
        )

        expect(response.status).toBe(504)
        const payload = (await response.json()) as { error: { code: string } }
        expect(payload.error.code).toBe('timeout')
      })

      it('describes itself on GET /health without touching the model', async () => {
        const { app, transport } = appFor(agent, 'ok')
        const response = await app.request('/health')

        expect(response.status).toBe(200)
        const payload = (await response.json()) as Record<string, unknown>
        expect(payload).toMatchObject({
          ok: true,
          agent: agent.label,
          description: agent.description,
          inputSchema: agent.inputSchema,
          recordVersion: 1,
        })
        expect(transport.calls).toHaveLength(0)
      })
    })
  }
})

describe('the three agents are genuinely distinct', () => {
  it('has a unique label, port, description and system prompt per agent', () => {
    const labels = ALL_AGENTS.map((agent) => agent.label)
    const ports = ALL_AGENTS.map((agent) => agent.defaultPort)
    const descriptions = ALL_AGENTS.map((agent) => agent.description)
    const prompts = ALL_AGENTS.map((agent) => agent.systemPrompt)

    expect(new Set(labels).size).toBe(3)
    expect(new Set(ports).size).toBe(3)
    expect(new Set(descriptions).size).toBe(3)
    expect(new Set(prompts).size).toBe(3)
  })

  it('gives each agent a non-empty description that fits the record limit', () => {
    for (const agent of ALL_AGENTS) {
      expect(agent.description.length).toBeGreaterThan(0)
      expect(agent.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
      expect(agent.description).not.toContain('\n')
    }
  })

  it('gives each agent at least one sample question in its own domain', () => {
    expect(CONTRACT.sampleQuestions[0]?.toLowerCase()).toMatch(/clause|agreement|liability/)
    expect(COPY.sampleQuestions[0]?.toLowerCase()).toMatch(/tagline|headline|copy|button/)
    expect(INVOICE.sampleQuestions[0]?.toLowerCase()).toMatch(/invoice|billing|outstanding/)
  })

  it('puts the demo ledger only on invoice-helper', () => {
    expect(CONTRACT.context).toBeUndefined()
    expect(COPY.context).toBeUndefined()
    expect(INVOICE.context).toContain('INV-123')
    // The context is appended to the prompt, not sent as a separate message.
    expect(buildSystemPrompt(INVOICE)).toContain('INV-123')
    expect(buildSystemPrompt(CONTRACT)).not.toContain('INV-123')
  })

  it('binds the three agents to 4001, 4002 and 4003', () => {
    expect(ALL_AGENTS.map((agent) => agent.defaultPort)).toEqual([4001, 4002, 4003])
    expect(ALL_AGENTS.map((agent) => agent.portEnvVar)).toEqual([
      'CONTRACT_HELPER_PORT',
      'COPY_HELPER_PORT',
      'INVOICE_HELPER_PORT',
    ])
  })
})

describe('routing and method handling', () => {
  const { app } = appFor(CONTRACT, 'ok')

  it('returns 405 with an Allow header for the wrong method on /ask', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.request('/ask', { method })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
    }
  })

  it('returns 404 for an unknown path', async () => {
    const response = await app.request('/nope', { method: 'POST' })
    expect(response.status).toBe(404)
  })

  it('rejects a body that is not JSON', async () => {
    const response = await postJson(app, 'this is not json')
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { detail: string } }
    expect(payload.error.detail).toMatch(/not valid JSON/)
  })

  it('rejects a top-level array', async () => {
    const response = await postJson(app, '[1,2,3]')
    expect(response.status).toBe(400)
  })

  it('rejects a question longer than the limit', async () => {
    const response = await postJson(app, { question: 'x'.repeat(2_001) })
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { detail: string } }
    expect(payload.error.detail).toMatch(/character limit/)
  })

  it('trims the question before forwarding it', async () => {
    const { app: trimmed, transport } = appFor(CONTRACT, 'ok')
    await postJson(trimmed, { question: '  padded question  ' })
    expect(userTextOf(transport.calls[0])).toBe('padded question')
  })

  it('never echoes the technical error message back to the client', async () => {
    const broken: typeof fetch = () => {
      throw new Error('http://internal-model-host/v1 leaked detail')
    }
    const response = await createAgentApp({
      agent: CONTRACT,
      llmConfig: TEST_LLM_CONFIG,
      fetchImpl: broken,
    }).request('/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'hello' }),
    })

    expect(response.status).toBe(502)
    const text = JSON.stringify(await response.json())
    expect(text).not.toContain('internal-model-host')
  })
})

describe('binding a real socket', () => {
  const handles: { close: () => Promise<void> }[] = []

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
  })

  it('serves an agent over HTTP on an OS-assigned port', async () => {
    const transport = mockTransport('bound and answered')
    const handle = await startAgentServer(
      { agent: CONTRACT, llmConfig: TEST_LLM_CONFIG, fetchImpl: transport.fetchImpl },
      0,
    )
    handles.push(handle)

    expect(handle.port).toBeGreaterThan(0)

    const health = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(health.status).toBe(200)
    expect(((await health.json()) as { agent: string }).agent).toBe('contract-helper')

    const ask = await fetch(`http://127.0.0.1:${handle.port}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'How do we word the IP clause?' }),
    })
    expect(ask.status).toBe(200)
    expect(await ask.json()).toEqual({ answer: 'bound and answered' })
    expect(transport.calls).toHaveLength(1)
  })

  it('refuses to start when the port is already taken', async () => {
    const first = await startAgentServer({ agent: CONTRACT }, 0)
    handles.push(first)

    await expect(startAgentServer({ agent: COPY }, first.port)).rejects.toThrow(/EADDRINUSE/)
  })
})

describe('error presentation', () => {
  it('maps a timeout onto 504 with a retryable flag and no model URL', async () => {
    const deps: AgentServerDeps = {
      agent: CONTRACT,
      llmConfig: TEST_LLM_CONFIG,
      ask: () => Promise.reject(new LlmTimeoutError(10, 'http://model.test/v1/chat/completions')),
    }
    const response = await createAgentApp(deps).request('/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'hello' }),
    })

    expect(response.status).toBe(504)
    const payload = (await response.json()) as { error: { retryable: boolean; detail: string } }
    expect(payload.error.retryable).toBe(true)
    expect(payload.error.detail).not.toContain('http://model.test')
  })

  it('marks a rejected question as not retryable', async () => {
    const deps: AgentServerDeps = { agent: CONTRACT, llmConfig: TEST_LLM_CONFIG }
    const response = await createAgentApp(deps).request('/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '' }),
    })

    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { code: string; retryable: boolean } }
    expect(payload.error).toMatchObject({ code: 'bad_request', retryable: false })
  })
})
