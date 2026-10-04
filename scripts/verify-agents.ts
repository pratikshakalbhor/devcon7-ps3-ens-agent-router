/**
 * Read every agent's self-description back off chain and print it. Read-only,
 * no wallet, no private key — this is the "is any of this actually live?" script.
 *
 *   npm run verify
 *   npm run verify -- --json
 *   npm run verify -- --parent=yourname.eth
 *   npm run verify -- --addresses
 *
 * Reports, per agent name: the registry owner, the resolver, each raw
 * `agent.dev.*` value, the parse result, and any schema issues. Records that
 * fail validation are marked UNROUTABLE — exactly the ones a discovery pass
 * must skip (test case: malformed records are skipped).
 *
 * Exits non-zero if any agent is missing records or is unparseable, so it can
 * gate a deploy.
 */
import { namehash, type Address } from 'viem'
import { getEnsAddress } from 'viem/actions'

import { loadEnvFile, requireEnv } from '../lib/env.js'
import {
  SPECIALIST_AGENTS,
  agentEnsName,
  resolveParentName,
} from '../lib/agents.js'
import { endpointPolicyFromEnv } from '../lib/agent-endpoint.js'
import { ENS_ADDRESSES, ZERO_ADDRESS, ensRegistryAbi } from '../lib/ens-contracts.js'
import { createEnsReader, createPublicClientFromEnv, type PublicClient } from '../lib/ens-reader.js'
import {
  AGENT_RECORD_KEY_LIST,
  describeAgentRecord,
  isRoutable,
  parseAgentRecord,
  type AgentRecord,
} from '../lib/agent-record-schema.js'
import { SEPOLIA_CHAIN as sepolia } from '../lib/chain.js'

interface CliOptions {
  readonly parentName: string
  readonly json: boolean
  readonly includeAddresses: boolean
  readonly allowLocalhost: boolean
  readonly help: boolean
}

const USAGE = `Usage: npm run verify [--options]

Reads the agent.dev.* records for every specialist subname. Read-only:
no private key, no transactions.

Options:
  --parent=<name>   Parent 2LD to check (default: AGENT_PARENT_NAME, else priya-studio-yourname.eth)
  --addresses       Also resolve and print each addr record
  --allow-localhost Accept http:// loopback endpoints, matching ALLOW_LOCALHOST_ENDPOINT=1
  --json            Machine-readable output, for CI
  --help            Show this message

Environment:
  SEPOLIA_RPC_URL   Required. Any Sepolia JSON-RPC endpoint.

Exits non-zero if any agent is missing records or fails schema validation.
`

function parseArgs(argv: readonly string[]): CliOptions {
  let parentName = resolveParentName()
  let json = false
  let includeAddresses = false
  let allowLocalhost = process.env.ALLOW_LOCALHOST_ENDPOINT === '1'
  let help = false
  for (const arg of argv) {
    if (arg.startsWith('--parent=')) parentName = arg.slice('--parent='.length)
    else if (arg === '--json') json = true
    else if (arg === '--addresses') includeAddresses = true
    else if (arg === '--allow-localhost') allowLocalhost = true
    else if (arg === '--help' || arg === '-h') help = true
  }
  return {
    parentName: parentName.trim().replace(/\.$/, ''),
    json,
    includeAddresses,
    allowLocalhost,
    help,
  }
}

async function describeResolver(client: PublicClient, name: string): Promise<string> {
  const resolver = await client.readContract({
    address: ENS_ADDRESSES.registry.address,
    abi: ensRegistryAbi,
    functionName: 'resolver',
    args: [namehash(name)],
  })
  if (resolver === ZERO_ADDRESS) return 'none'
  if (resolver === ENS_ADDRESSES.publicResolver.address) return 'PublicResolver (current)'
  if (resolver === ENS_ADDRESSES.legacyPublicResolver.address) return 'PublicResolver (legacy)'
  return resolver
}

async function describeOwner(client: PublicClient, name: string): Promise<string> {
  const owner: Address = await client.readContract({
    address: ENS_ADDRESSES.registry.address,
    abi: ensRegistryAbi,
    functionName: 'owner',
    args: [namehash(name)],
  })
  if (owner === ZERO_ADDRESS) return 'UNREGISTERED'
  if (owner === ENS_ADDRESSES.nameWrapper.address) return 'NameWrapper (wrapped)'
  return owner
}

interface VerificationAgentView {
  readonly name: string
  readonly owner: string
  readonly resolver: string
  readonly address: string | null
  readonly records: Record<string, string>
  readonly routable: boolean
  readonly issues: AgentRecord['issues']
  readonly injectionSuspected: boolean
}

interface VerificationSummary {
  readonly ok: boolean
  readonly parentName: string
  readonly checkedKeys: readonly string[]
  readonly agents: VerificationAgentView[]
  readonly missing: string[]
  readonly unroutable: string[]
  readonly flagged: string[]
}

async function main(): Promise<void> {
  loadEnvFile()
  const options = parseArgs(process.argv.slice(2))
  // --help must work without an RPC endpoint.
  if (options.help) {
    console.log(USAGE)
    return
  }

  const rpcUrl = requireEnv(
    process.env,
    'SEPOLIA_RPC_URL',
    'e.g. https://ethereum-sepolia-rpc.publicnode.com',
  )

  const names = SPECIALIST_AGENTS.map((agent) => agentEnsName(agent.label, options.parentName))
  const reader = createEnsReader(rpcUrl, { concurrency: 3, chain: sepolia })
  const client = createPublicClientFromEnv({ rpcUrl, chain: sepolia })
  const endpointPolicy = endpointPolicyFromEnv({
    ...process.env,
    ALLOW_LOCALHOST_ENDPOINT: options.allowLocalhost ? '1' : undefined,
  })

  if (!options.json) {
    console.log('\nENS agent verifier — read-only, Sepolia')
    console.log(`  parent : ${options.parentName}`)
    console.log(`  names  : ${names.length}`)
    console.log(`  keys   : ${AGENT_RECORD_KEY_LIST.join(', ')}`)
    console.log(
      `  policy : ${endpointPolicy.allowLocalhostHttp ? 'https required, http allowed on loopback' : 'https required, no exceptions'}\n`,
    )
  }

  const raw = await reader.readAgents(names, { concurrency: 3 })
  // Keep the untouched on-chain strings alongside the parsed view: the parser
  // normalises whitespace, and the verifier's job includes showing what the
  // chain actually says.
  const rawByName = new Map(raw.map((entry) => [entry.name, entry.records]))

  const records: AgentRecord[] = raw.map((entry) =>
    parseAgentRecord(entry.name, entry.records, { endpointPolicy }),
  )

  const missing = records.filter(
    (record) => record.description === '' && record.endpoint === '' && record.callSpec === null,
  )
  const unroutable = records.filter((record) => !isRoutable(record))
  const flagged = records.filter((record) => record.flags.injectionSuspected)

  const views: VerificationAgentView[] = await Promise.all(
    records.map(async (record): Promise<VerificationAgentView> => {
      const [owner, resolver, address] = await Promise.all([
        describeOwner(client, record.name),
        describeResolver(client, record.name),
        options.includeAddresses
          ? getEnsAddress(client, { name: record.name, strict: true }).catch(() => null)
          : Promise.resolve(null),
      ])
      return {
        name: record.name,
        owner,
        resolver,
        address,
        records: { ...rawByName.get(record.name) },
        routable: isRoutable(record),
        issues: record.issues,
        injectionSuspected: record.flags.injectionSuspected,
      }
    }),
  )

  const summary: VerificationSummary = {
    ok: missing.length === 0 && unroutable.length === 0,
    parentName: options.parentName,
    checkedKeys: AGENT_RECORD_KEY_LIST,
    agents: views,
    missing: missing.map((record) => record.name),
    unroutable: unroutable.map((record) => record.name),
    flagged: flagged.map((record) => record.name),
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2))
    process.exitCode = summary.ok ? 0 : 1
    return
  }

  for (const view of views) {
    const record = records.find((candidate) => candidate.name === view.name)
    console.log(`  ${view.routable ? '✓' : '✗'} ${view.name}`)
    console.log(`      owner    : ${view.owner}`)
    console.log(`      resolver : ${view.resolver}`)
    if (view.address) console.log(`      address  : ${view.address}`)
    if (record !== undefined) console.log(indent(describeAgentRecord(record), 6))
    else console.log(`      ! no records read`)
    if (!view.routable) console.log('      ! UNROUTABLE — a discovery pass must skip this name')
    console.log('')
  }

  const readable = views.length - missing.length - unroutable.length
  console.log(`  ${Math.max(0, readable)}/${views.length} agents routable from chain.`)
  if (summary.missing.length > 0) console.log(`  Missing : ${summary.missing.join(', ')}`)
  if (summary.unroutable.length > 0) {
    console.log(`  Unroutable: ${summary.unroutable.join(', ')}`)
    console.log('  Run `npm run seed` after fixing the endpoint records.')
  }
  if (summary.flagged.length > 0) {
    console.log(
      `  Flagged for untrusted description text: ${summary.flagged.join(', ')}`,
    )
  }
  if (!summary.ok) {
    console.log('')
    process.exitCode = 1
    return
  }
  console.log('')
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n')
}

main().catch((error: unknown) => {
  console.error(`\nVerify failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
