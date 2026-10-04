/**
 * Resolving what gets written into `agent.dev.endpoint`.
 *
 * Three sources, in strict precedence order:
 *
 *   1. `CONTRACT_HELPER_ENDPOINT` / `COPY_HELPER_ENDPOINT` /
 *      `INVOICE_HELPER_ENDPOINT` — a full URL including the path. This is the
 *      realistic setup for local development, because each agent listens on its
 *      own port and therefore needs its own tunnel.
 *
 *   2. `AGENT_PUBLIC_BASE_URL` — one shared origin; `/ask` is appended. This is
 *      the setup where a reverse proxy or an ingress routes on path, so one
 *      public URL reaches all three agents.
 *
 *   3. `http://127.0.0.1:<port>/ask` — the localhost fallback. Only usable when
 *      `ALLOW_LOCALHOST_ENDPOINT=1`, i.e. the **explicit localhost dev
 *      exception**: production discovery requires `https://`.
 *
 * The same file derives the `EndpointPolicy` used to *validate* what it just
 * produced, so a seed run cannot publish a URL its own reader would reject.
 */

import type { EndpointPolicy } from './agent-record-schema.js'
import { LOCAL_DEV_ENDPOINT_POLICY, PRODUCTION_ENDPOINT_POLICY } from './agent-record-schema.js'
import type { SpecialistAgent } from './agents.js'
import { resolveAgentPort } from './agents.js'

export type EndpointSource = 'env-override' | 'public-base' | 'localhost'

export interface ResolvedEndpoint {
  /** The full URL that will be written to `agent.dev.endpoint`. */
  readonly url: string
  readonly source: EndpointSource
  /** True when the caller must opt in explicitly for this value to be legal. */
  readonly requiresLocalhostException: boolean
}

/** `CONTRACT_HELPER_ENDPOINT` for `contract-helper`, etc. */
export function endpointOverrideVar(agent: SpecialistAgent): string {
  return `${agent.label.replace(/-/g, '_').toUpperCase()}_ENDPOINT`
}

/** `true` when `ALLOW_LOCALHOST_ENDPOINT` is set to a truthy value. */
export function isLocalhostExceptionEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.ALLOW_LOCALHOST_ENDPOINT?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/** The policy implied by the environment: HTTPS-only, unless loopback is opted in. */
export function endpointPolicyFromEnv(env: Record<string, string | undefined>): EndpointPolicy {
  return isLocalhostExceptionEnabled(env) ? LOCAL_DEV_ENDPOINT_POLICY : PRODUCTION_ENDPOINT_POLICY
}

function withPath(origin: string, path: string): string {
  return `${origin.trim().replace(/\/+$/, '')}${path}`
}

/**
 * Work out this agent's published URL.
 *
 * Never throws on missing configuration — the localhost fallback always exists,
 * so the caller decides what to do with a value that the policy would reject
 * (the seed script refuses; `--dry-run` shows it).
 */
export function resolveAgentEndpoint(
  agent: SpecialistAgent,
  env: Record<string, string | undefined> = process.env,
): ResolvedEndpoint {
  const overrideVar = endpointOverrideVar(agent)
  const override = env[overrideVar]?.trim()
  if (override !== undefined && override !== '') {
    return { url: override, source: 'env-override', requiresLocalhostException: false }
  }

  const base = env.AGENT_PUBLIC_BASE_URL?.trim()
  if (base !== undefined && base !== '') {
    return {
      url: withPath(base, '/ask'),
      source: 'public-base',
      requiresLocalhostException: false,
    }
  }

  const port = resolveAgentPort(agent, env)
  const host = env.AGENT_HOST?.trim() || '127.0.0.1'
  const hostname = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return {
    url: `http://${hostname}:${port}/ask`,
    source: 'localhost',
    requiresLocalhostException: true,
  }
}
