/**
 * Standalone bootstrap for one specialist agent.
 *
 * Every agent entrypoint does the same thing — load `.env`, bind, log, and shut
 * down cleanly — so the three `agents/*.ts` files stay a couple of lines each
 * and cannot drift apart.
 */

import { loadEnvFile } from './env.js'
import { resolveAgentPort, type SpecialistAgent } from './agents.js'
import { startAgentServer } from './agent-server.js'

export async function runAgent(agent: SpecialistAgent): Promise<void> {
  loadEnvFile()

  const host = process.env.AGENT_HOST?.trim() || '127.0.0.1'
  const port = resolveAgentPort(agent)
  const handle = await startAgentServer({ agent }, port, host)

  console.log(`\n  ${agent.label} — specialist agent`)
  console.log(`  listening  : http://${host}:${handle.port}`)
  console.log(`  ask        : POST /ask  { "question": "..." }`)
  console.log(`  health     : GET  /health`)
  console.log(`  describe   : ${agent.description}`)
  if (agent.context !== undefined) console.log(`  context    : ${agent.context.split('\n')[0] ?? ''} ...`)
  console.log(`  model      : ${process.env.LLM_MODEL ?? '(LLM_MODEL unset)'}`)
  console.log(`             : ${process.env.LLM_BASE_URL ?? '(LLM_BASE_URL unset)'}`)
  console.log(`  ens name   : <label>.<parent>  (records are written by \`npm run seed\`)\n`)

  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n  ${agent.label}: received ${signal}, shutting down.`)
    void handle.close().then(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
