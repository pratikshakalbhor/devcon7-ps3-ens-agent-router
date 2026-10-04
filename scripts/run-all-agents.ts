/**
 * Convenience runner: start all three specialist agents in one process.
 *
 *   npm run agents
 *
 * Each agent still gets its own Hono app and its own port (4001 / 4002 / 4003),
 * so this is exactly what three separate `npm run agent:*` processes would give
 * you — just with one terminal instead of three. Any agent that fails to bind
 * is reported and the rest keep running.
 */

import { loadEnvFile } from '../lib/env.js'
import { SPECIALIST_AGENTS, resolveAgentPort } from '../lib/agents.js'
import { startAgentServer, type AgentServerHandle } from '../lib/agent-server.js'

async function main(): Promise<void> {
  loadEnvFile()
  const host = process.env.AGENT_HOST?.trim() || '127.0.0.1'

  console.log('\n  Starting specialist agents...\n')
  const handles: AgentServerHandle[] = []

  for (const agent of SPECIALIST_AGENTS) {
    try {
      const handle = await startAgentServer({ agent }, resolveAgentPort(agent), host)
      handles.push(handle)
      console.log(`    ✓ ${agent.label.padEnd(18)} http://${host}:${handle.port}/ask`)
    } catch (error: unknown) {
      console.error(
        `    ✗ ${agent.label.padEnd(18)} ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (handles.length === 0) {
    console.error('\n  No agent started.\n')
    process.exitCode = 1
    return
  }

  console.log(`\n  ${handles.length}/${SPECIALIST_AGENTS.length} agents up. Ctrl-C to stop.\n`)

  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n  Received ${signal}, shutting down ${handles.length} agent(s).`)
    void Promise.all(handles.map((handle) => handle.close())).then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
