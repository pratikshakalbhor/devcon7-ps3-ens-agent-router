import { INVOICE_HELPER } from '../lib/agents.js'
import { runAgent } from '../lib/run-agent.js'

runAgent(INVOICE_HELPER).catch((error: unknown) => {
  console.error(
    `\ninvoice-helper failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
