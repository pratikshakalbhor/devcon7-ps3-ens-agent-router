import { CONTRACT_HELPER } from '../lib/agents.js'
import { runAgent } from '../lib/run-agent.js'

runAgent(CONTRACT_HELPER).catch((error: unknown) => {
  console.error(
    `\ncontract-helper failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
