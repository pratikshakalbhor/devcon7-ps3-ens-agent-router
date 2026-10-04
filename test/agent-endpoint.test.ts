import { describe, expect, it } from 'vitest'

import {
  isLocalhostExceptionEnabled,
  endpointOverrideVar,
  endpointPolicyFromEnv,
  resolveAgentEndpoint,
} from '../lib/agent-endpoint.js'
import {
  LOCAL_DEV_ENDPOINT_POLICY,
  PRODUCTION_ENDPOINT_POLICY,
  validateEndpoint,
} from '../lib/agent-record-schema.js'
import { CONTRACT, COPY, INVOICE } from './helpers.js'

const ENV = (overrides: Record<string, string> = {}) => ({ ...overrides })

describe('endpoint override variable names', () => {
  it('derives one per agent from its label', () => {
    expect(endpointOverrideVar(CONTRACT)).toBe('CONTRACT_HELPER_ENDPOINT')
    expect(endpointOverrideVar(COPY)).toBe('COPY_HELPER_ENDPOINT')
    expect(endpointOverrideVar(INVOICE)).toBe('INVOICE_HELPER_ENDPOINT')
  })
})

describe('resolveAgentEndpoint precedence', () => {
  it('prefers the per-agent override over everything else', () => {
    const env = ENV({
      CONTRACT_HELPER_ENDPOINT: 'https://a.example.com/ask',
      AGENT_PUBLIC_BASE_URL: 'https://shared.example.com',
      ALLOW_LOCALHOST_ENDPOINT: '1',
    })

    const resolved = resolveAgentEndpoint(CONTRACT, env)
    expect(resolved).toEqual({
      url: 'https://a.example.com/ask',
      source: 'env-override',
      requiresLocalhostException: false,
    })
    // The override is scoped to one agent: the others use the shared base.
    expect(resolveAgentEndpoint(COPY, env)).toEqual({
      url: 'https://shared.example.com/ask',
      source: 'public-base',
      requiresLocalhostException: false,
    })
  })

  it('scopes the override to its own agent', () => {
    const env = ENV({ CONTRACT_HELPER_ENDPOINT: 'https://a.example.com/ask' })
    expect(resolveAgentEndpoint(CONTRACT, env).url).toBe('https://a.example.com/ask')
    expect(resolveAgentEndpoint(COPY, env).url).toBe('http://127.0.0.1:4002/ask')
    expect(resolveAgentEndpoint(INVOICE, env).url).toBe('http://127.0.0.1:4003/ask')
  })

  it('falls back to the shared public base URL with /ask appended', () => {
    const resolved = resolveAgentEndpoint(COPY, ENV({ AGENT_PUBLIC_BASE_URL: 'https://agents.example.com' }))
    expect(resolved).toEqual({
      url: 'https://agents.example.com/ask',
      source: 'public-base',
      requiresLocalhostException: false,
    })
  })

  it('strips trailing slashes from the shared base URL', () => {
    for (const base of [
      'https://agents.example.com/',
      'https://agents.example.com///',
      '  https://agents.example.com  ',
    ]) {
      const resolved = resolveAgentEndpoint(COPY, ENV({ AGENT_PUBLIC_BASE_URL: base }))
      expect(resolved.url).toBe('https://agents.example.com/ask')
    }
  })

  it('ignores an empty override and an empty base URL', () => {
    const resolved = resolveAgentEndpoint(
      CONTRACT,
      ENV({ CONTRACT_HELPER_ENDPOINT: '   ', AGENT_PUBLIC_BASE_URL: '' }),
    )
    expect(resolved.source).toBe('localhost')
  })

  it('falls back to the loopback URL when nothing else is set', () => {
    const resolved = resolveAgentEndpoint(INVOICE, ENV())
    expect(resolved).toEqual({
      url: 'http://127.0.0.1:4003/ask',
      source: 'localhost',
      requiresLocalhostException: true,
    })
  })

  it('honours the agent-specific port variable', () => {
    const resolved = resolveAgentEndpoint(CONTRACT, ENV({ CONTRACT_HELPER_PORT: '5100' }))
    expect(resolved.url).toBe('http://127.0.0.1:5100/ask')
  })

  it('falls back to the shared AGENT_PORT when the agent has none', () => {
    const resolved = resolveAgentEndpoint(COPY, ENV({ AGENT_PORT: '5200' }))
    expect(resolved.url).toBe('http://127.0.0.1:5200/ask')
  })

  it('substitutes a reachable host when AGENT_HOST binds a wildcard', () => {
    for (const host of ['0.0.0.0', '::']) {
      const resolved = resolveAgentEndpoint(CONTRACT, ENV({ AGENT_HOST: host }))
      expect(resolved.url).toBe('http://127.0.0.1:4001/ask')
    }
    // A real interface name is used verbatim, because a caller asked for it.
    const resolved = resolveAgentEndpoint(CONTRACT, ENV({ AGENT_HOST: '192.168.1.50' }))
    expect(resolved.url).toBe('http://192.168.1.50:4001/ask')
  })

  it('always produces a URL its own policy accepts when localhost is opted in', () => {
    const env = ENV({ ALLOW_LOCALHOST_ENDPOINT: '1' })
    const policy = endpointPolicyFromEnv(env)
    for (const agent of [CONTRACT, COPY, INVOICE]) {
      const { url } = resolveAgentEndpoint(agent, env)
      expect(validateEndpoint(url, policy)).toEqual({ ok: true })
    }
  })

  it('produces a value the default policy rejects until localhost is opted in', () => {
    const policy = endpointPolicyFromEnv(ENV())
    const { url, requiresLocalhostException } = resolveAgentEndpoint(CONTRACT, ENV())
    expect(requiresLocalhostException).toBe(true)
    expect(validateEndpoint(url, policy).ok).toBe(false)
  })
})

describe('localhost exception flag', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['YES', true],
    ['On', true],
    ['  1  ', true],
    ['0', false],
    ['false', false],
    ['', false],
    ['nope', false],
  ])('%j -> %s', (raw, expected) => {
    expect(isLocalhostExceptionEnabled(ENV({ ALLOW_LOCALHOST_ENDPOINT: raw }))).toBe(expected)
  })

  it('is off when the variable is absent', () => {
    expect(isLocalhostExceptionEnabled(ENV())).toBe(false)
  })
})

describe('endpointPolicyFromEnv', () => {
  it('is HTTPS-only by default', () => {
    expect(endpointPolicyFromEnv(ENV())).toEqual(PRODUCTION_ENDPOINT_POLICY)
    expect(endpointPolicyFromEnv(ENV({ ALLOW_LOCALHOST_ENDPOINT: '0' }))).toEqual(
      PRODUCTION_ENDPOINT_POLICY,
    )
  })

  it('permits loopback http once the exception is enabled', () => {
    expect(endpointPolicyFromEnv(ENV({ ALLOW_LOCALHOST_ENDPOINT: '1' }))).toEqual(
      LOCAL_DEV_ENDPOINT_POLICY,
    )
  })

  it('still rejects plain http on a public host in local-dev mode', () => {
    const policy = endpointPolicyFromEnv(ENV({ ALLOW_LOCALHOST_ENDPOINT: '1' }))
    expect(validateEndpoint('http://agents.example.com/ask', policy).ok).toBe(false)
  })
})
