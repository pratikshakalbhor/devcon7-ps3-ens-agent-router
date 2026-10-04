/**
 * Publish the three specialist agents' ENS self-descriptions on Sepolia.
 *
 *   npm run seed                       # real run
 *   npm run seed -- --dry-run          # print the plan, touch nothing
 *   npm run seed -- --parent=yourname.eth --only=invoice-helper
 *   npm run seed -- --help
 *
 * Per agent:
 *   1. Create `<label>.<parent>` — via NameWrapper.setSubnodeRecord when the
 *      parent is wrapped, or registry.setSubnodeOwner + setResolver when it is
 *      not. Subnames cost gas only; there is no registration premium.
 *   2. Write the four `agent.dev.*` text records in one resolver multicall.
 *
 * The Sepolia Public Resolver resolves `ens.owner(node) == nameWrapper` down to
 * the wrapper's NFT owner, so a plain EOA can write records on its own wrapped
 * subnames without deploying a subname-registrar contract.
 *
 * The script is idempotent: existing names are reused and only records are
 * rewritten, so re-running after changing an endpoint is the intended way to
 * update a self-description.
 *
 * ENDPOINTS
 * -------------------------------------------------------------------------
 * `agent.dev.endpoint` is the URL the router will POST to. It is resolved by
 * `lib/agent-endpoint.ts` (per-agent override → shared base → localhost), then
 * validated against the endpoint policy derived from `ALLOW_LOCALHOST_ENDPOINT`
 * — the **explicit localhost dev exception**. A URL the reader would later
 * reject is refused here rather than published, so a seed run can never create
 * a record its own verifier flags as malformed.
 */
import {
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http as httpTransport,
  namehash,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { loadEnvFile, requireEnv } from '../lib/env.js'
import {
  DEFAULT_AGENT_PARENT_NAME,
  SPECIALIST_AGENTS,
  ensNameFor,
  resolveParentName,
  type SpecialistAgent,
} from '../lib/agents.js'
import {
  endpointPolicyFromEnv,
  resolveAgentEndpoint,
  type ResolvedEndpoint,
} from '../lib/agent-endpoint.js'
import {
  ENS_ADDRESSES,
  ZERO_ADDRESS,
  describeFuses,
  ensRegistryAbi,
  nameWrapperAbi,
  resolverAbi,
} from '../lib/ens-contracts.js'
import { createPublicClientFromEnv, type PublicClient } from '../lib/ens-reader.js'
import {
  serialiseAgentRecord,
  validateEndpoint,
  type EndpointPolicy,
  type RawAgentRecords,
} from '../lib/agent-record-schema.js'
import { SEPOLIA_CHAIN as sepolia } from '../lib/chain.js'

const SEPOLIA_CHAIN_ID = 11155111

interface CliOptions {
  readonly parentName: string
  readonly dryRun: boolean
  readonly only: string[] | null
  readonly help: boolean
}

const USAGE = `Usage: npm run seed [--options]

Publishes agent.dev.description / endpoint / input-schema / version for each
specialist agent, creating the ENS subname when it does not exist yet.

Options:
  --parent=<name>   Parent 2LD to publish under (default: AGENT_PARENT_NAME,
                    else ${DEFAULT_AGENT_PARENT_NAME})
  --only=<labels>   Comma-separated labels, e.g. --only=copy-helper,invoice-helper
  --dry-run         Print the plan and send no transaction
  --help            Show this message

Environment:
  SEPOLIA_RPC_URL              Required. Any Sepolia JSON-RPC endpoint.
  PRIVATE_KEY                  Required unless --dry-run. Must control the parent.
  CONTRACT_HELPER_ENDPOINT     Full URL for one agent (wins over the shared base).
  COPY_HELPER_ENDPOINT
  INVOICE_HELPER_ENDPOINT
  AGENT_PUBLIC_BASE_URL        Shared origin; "/ask" is appended.
  ALLOW_LOCALHOST_ENDPOINT=1   Explicit exception permitting http:// on loopback.

Without any endpoint configuration the script publishes the loopback URL, which
is only legal with ALLOW_LOCALHOST_ENDPOINT=1. See the README section
"Endpoint records and local development" for the ngrok/cloudflared setup.
`

function parseArgs(argv: readonly string[]): CliOptions {
  let parentName = resolveParentName()
  let dryRun = process.env.SEED_DRY_RUN === '1'
  let help = false
  const only: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('--parent=')) parentName = arg.slice('--parent='.length)
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg.startsWith('--only=')) only.push(...arg.slice('--only='.length).split(','))
  }
  return {
    parentName: parentName.trim().replace(/\.$/, ''),
    dryRun,
    help,
    only: only.length > 0 ? only.map((value) => value.trim()).filter(Boolean) : null,
  }
}

/** How the parent is held, which decides how subnames get created. */
type ParentMode = 'wrapped' | 'unwrapped' | 'unavailable'

interface ParentState {
  readonly mode: ParentMode
  readonly registryOwner: Address
  readonly wrapperOwner: Address | null
  readonly canCreateSubnames: boolean
  readonly expiry: bigint
  readonly detail: string
}

async function inspectParent(client: PublicClient, parentName: string): Promise<ParentState> {
  const parentNode = namehash(parentName)
  const registryOwner = await client.readContract({
    address: ENS_ADDRESSES.registry.address,
    abi: ensRegistryAbi,
    functionName: 'owner',
    args: [parentNode],
  })
  const resolver = await client.readContract({
    address: ENS_ADDRESSES.registry.address,
    abi: ensRegistryAbi,
    functionName: 'resolver',
    args: [parentNode],
  })

  if (registryOwner === ZERO_ADDRESS) {
    return {
      mode: 'unavailable',
      registryOwner,
      wrapperOwner: null,
      canCreateSubnames: false,
      expiry: 0n,
      detail: `"${parentName}" does not exist on Sepolia (no registry owner)`,
    }
  }

  if (registryOwner === ENS_ADDRESSES.nameWrapper.address) {
    const [wrapperOwner, fuses, expiry] = await client.readContract({
      address: ENS_ADDRESSES.nameWrapper.address,
      abi: nameWrapperAbi,
      functionName: 'getData',
      args: [BigInt(parentNode)],
    })
    const canCreateSubnames = await client.readContract({
      address: ENS_ADDRESSES.nameWrapper.address,
      abi: nameWrapperAbi,
      functionName: 'canModifyName',
      args: [parentNode, wrapperOwner],
    })
    return {
      mode: 'wrapped',
      registryOwner,
      wrapperOwner,
      canCreateSubnames,
      expiry,
      detail: `wrapped by ${wrapperOwner}, resolver ${resolver}, fuses: ${describeFuses(fuses)}`,
    }
  }

  return {
    mode: 'unwrapped',
    registryOwner,
    wrapperOwner: null,
    canCreateSubnames: true,
    expiry: 0n,
    detail: `owned directly in the registry by ${registryOwner}, resolver ${resolver}`,
  }
}

function assertDeployerControlsParent(parent: ParentState, deployer: Address): void {
  const controls =
    parent.mode === 'wrapped'
      ? parent.canCreateSubnames && parent.wrapperOwner === deployer
      : parent.registryOwner === deployer
  if (controls) return

  const reason =
    parent.mode === 'wrapped'
      ? parent.canCreateSubnames
        ? `its NameWrapper owner is ${parent.wrapperOwner}, not ${deployer}`
        : `its PARENT_CANNOT_CONTROL / CANNOT_CREATE_SUBDOMAIN fuse is burned, so subnames cannot be created`
      : `its registry owner is ${parent.registryOwner}, not ${deployer}`

  throw new Error(`${deployer} cannot create subnames under this parent: ${reason}.`)
}

function recordCallsFor(node: Hex, records: RawAgentRecords): Hex[] {
  return Object.entries(records).map(([key, value]) =>
    encodeFunctionData({
      abi: resolverAbi,
      functionName: 'setText',
      args: [node, key, value],
    }),
  )
}

/* -------------------------------------------------------------------------- *
 * Planning: resolve every agent's records before anything touches the chain
 * -------------------------------------------------------------------------- */

interface PlannedAgent {
  readonly agent: SpecialistAgent
  readonly name: string
  readonly endpoint: ResolvedEndpoint
  /** Null when the endpoint would not survive validation. */
  readonly records: RawAgentRecords | null
  readonly endpointError: string | null
}

function buildPlan(
  agents: readonly SpecialistAgent[],
  parentName: string,
  env: Record<string, string | undefined>,
  policy: EndpointPolicy,
): PlannedAgent[] {
  return agents.map((agent) => {
    const endpoint = resolveAgentEndpoint(agent, env)
    const check = validateEndpoint(endpoint.url, policy)
    if (!check.ok) {
      return { agent, name: ensNameFor(agent, parentName), endpoint, records: null, endpointError: check.reason }
    }
    return {
      agent,
      name: ensNameFor(agent, parentName),
      endpoint,
      records: serialiseAgentRecord(
        {
          description: agent.description,
          endpoint: endpoint.url,
          inputSchema: agent.inputSchema,
        },
        { endpointPolicy: policy },
      ),
      endpointError: null,
    }
  })
}

const ENDPOINT_SOURCE_LABEL: Record<ResolvedEndpoint['source'], string> = {
  'env-override': 'per-agent env override',
  'public-base': 'AGENT_PUBLIC_BASE_URL + /ask',
  localhost: 'localhost fallback',
}

function printPlan(plan: readonly PlannedAgent[], policy: EndpointPolicy): void {
  console.log(
    `\n  Endpoint policy: ${policy.allowLocalhostHttp ? 'HTTPS required, http:// allowed on loopback (ALLOW_LOCALHOST_ENDPOINT=1)' : 'HTTPS required, no exceptions'}\n`,
  )
  for (const entry of plan) {
    console.log(`  ${entry.name}`)
    console.log(`    ${'endpoint'.padEnd(26)} : ${entry.endpoint.url}`)
    console.log(`      ${'source'.padEnd(26)} : ${ENDPOINT_SOURCE_LABEL[entry.endpoint.source]}`)
    console.log(`      ${'description'.padEnd(26)} : ${entry.agent.description}`)
    console.log(`      ${'input-schema'.padEnd(26)} : ${entry.agent.inputSchema}`)
    if (entry.endpointError !== null) {
      console.log(`      ! REJECTED: ${entry.endpointError}`)
    }
    console.log('')
  }
  const rejected = plan.filter((entry) => entry.endpointError !== null)
  if (rejected.length > 0) {
    console.log(
      `  ${rejected.length} endpoint(s) would be rejected by the reader. Fix them before seeding:\n`,
    )
  }
}

const MISSING_PARENT_HELP = [
  'How to get a parent name on Sepolia:',
  '  1. Mint one at https://sepolia.ens.domains (testnet mode) — free on testnet, or',
  '  2. Reuse any Sepolia name whose owner is the address of PRIVATE_KEY.',
  '',
  'Then set AGENT_PARENT_NAME=<yourname>.eth in .env (or pass --parent=).',
  'Subnames are created by the NameWrapper, so no registration premium is paid —',
  'only gas.',
].join('\n')

async function main(): Promise<void> {
  loadEnvFile()
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }

  const rpcUrl = requireEnv(
    process.env,
    'SEPOLIA_RPC_URL',
    'e.g. https://ethereum-sepolia-rpc.publicnode.com',
  )
  const publicClient = createPublicClientFromEnv({ rpcUrl, chain: sepolia })

  const chainId = await publicClient.getChainId()
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Refusing to seed: the RPC reports chain id ${chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID}).`,
    )
  }

  const selected = options.only
    ? SPECIALIST_AGENTS.filter((agent) => options.only?.includes(agent.label))
    : SPECIALIST_AGENTS
  if (selected.length === 0) {
    throw new Error(
      `--only matched nothing. Available labels: ${SPECIALIST_AGENTS.map((a) => a.label).join(', ')}`,
    )
  }

  const policy = endpointPolicyFromEnv(process.env)
  const plan = buildPlan(selected, options.parentName, process.env, policy)

  console.log('\nENS agent seeder — Sepolia')
  console.log(`  rpc       : ${redactUrl(rpcUrl)}`)
  console.log(`  parent    : ${options.parentName}`)
  console.log(`  agents    : ${plan.length}`)
  console.log(`  resolver  : ${ENS_ADDRESSES.publicResolver.address}`)

  const parent = await inspectParent(publicClient, options.parentName)
  console.log(`  parent    : ${parent.detail}`)

  if (parent.mode === 'unavailable') {
    throw new Error([parent.detail, '', MISSING_PARENT_HELP].join('\n'))
  }

  printPlan(plan, policy)

  const rejected = plan.filter((entry) => entry.endpointError !== null)

  if (options.dryRun) {
    console.log('  DRY RUN — no wallet, no transactions.\n')
    if (rejected.length > 0) {
      console.log(`  ${rejected.length} endpoint(s) would be rejected; see above.\n`)
      process.exitCode = 1
    } else {
      console.log(`  Would create/refresh ${plan.length} agent record set(s) under ${options.parentName}.\n`)
    }
    return
  }

  if (rejected.length > 0) {
    throw new Error(
      [
        `${rejected.length} endpoint(s) failed validation, so nothing was written:`,
        ...rejected.map((entry) => `  ${entry.name}: ${entry.endpointError}`),
        '',
        policy.allowLocalhostHttp
          ? 'Set one of CONTRACT_HELPER_ENDPOINT / COPY_HELPER_ENDPOINT / INVOICE_HELPER_ENDPOINT, or AGENT_PUBLIC_BASE_URL.'
          : 'Set ALLOW_LOCALHOST_ENDPOINT=1 to publish loopback URLs for local testing, or provide a tunnel URL.',
      ].join('\n'),
    )
  }

  const privateKey = requireEnv(
    process.env,
    'PRIVATE_KEY',
    `Deployer key; must control ${options.parentName}.`,
  )
  const account = privateKeyToAccount(privateKey as Hex)
  assertDeployerControlsParent(parent, account.address)
  console.log(`  deployer  : ${account.address}`)

  const balance = await publicClient.getBalance({ address: account.address })
  if (balance === 0n) {
    throw new Error(
      `${account.address} has 0 ETH on Sepolia. Faucet: https://sepoliafaucet.com (or any Sepolia faucet).`,
    )
  }
  console.log(`  balance   : ${formatEther(balance)} ETH`)

  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: httpTransport(rpcUrl),
  })

  const parentNode = namehash(options.parentName)
  const resolverAddress = ENS_ADDRESSES.publicResolver.address
  let createdCount = 0

  for (const entry of plan) {
    if (entry.records === null) continue
    const node = namehash(entry.name)

    const exists = await publicClient.readContract({
      address: ENS_ADDRESSES.registry.address,
      abi: ensRegistryAbi,
      functionName: 'recordExists',
      args: [node],
    })

    if (!exists) {
      createdCount += 1
      if (parent.mode === 'wrapped') {
        console.log(`  ${entry.name}: creating wrapped subname`)
        const hash = await walletClient.writeContract({
          address: ENS_ADDRESSES.nameWrapper.address,
          abi: nameWrapperAbi,
          functionName: 'setSubnodeRecord',
          // args: parentNode, label, owner, resolver, ttl (uint64), fuses (uint32), expiry (uint64)
          args: [parentNode, entry.agent.label, account.address, resolverAddress, 0n, 0, parent.expiry],
          chain: sepolia,
          account,
        })
        await publicClient.waitForTransactionReceipt({ hash })
        console.log(`      tx ${hash}`)
      } else {
        console.log(`  ${entry.name}: creating registry subname`)
        // namehash('contract-helper') === labelhash('contract-helper') for a single label.
        const ownerHash = await walletClient.writeContract({
          address: ENS_ADDRESSES.registry.address,
          abi: ensRegistryAbi,
          functionName: 'setSubnodeOwner',
          args: [parentNode, namehash(entry.agent.label), account.address],
          chain: sepolia,
          account,
        })
        await publicClient.waitForTransactionReceipt({ hash: ownerHash })
        const resolverHash = await walletClient.writeContract({
          address: ENS_ADDRESSES.registry.address,
          abi: ensRegistryAbi,
          functionName: 'setResolver',
          args: [node, resolverAddress],
          chain: sepolia,
          account,
        })
        await publicClient.waitForTransactionReceipt({ hash: resolverHash })
        console.log(`      tx ${ownerHash}`)
        console.log(`      tx ${resolverHash}`)
      }
    } else {
      const currentResolver = await publicClient.readContract({
        address: ENS_ADDRESSES.registry.address,
        abi: ensRegistryAbi,
        functionName: 'resolver',
        args: [node],
      })
      if (currentResolver === ZERO_ADDRESS) {
        const resolverHash = await walletClient.writeContract({
          address: ENS_ADDRESSES.registry.address,
          abi: ensRegistryAbi,
          functionName: 'setResolver',
          args: [node, resolverAddress],
          chain: sepolia,
          account,
        })
        await publicClient.waitForTransactionReceipt({ hash: resolverHash })
        console.log(`  ${entry.name}: resolver set (tx ${resolverHash})`)
      } else {
        console.log(`  ${entry.name}: exists, refreshing records`)
      }
    }

    const calls = recordCallsFor(node, entry.records)
    const hash = await walletClient.writeContract({
      address: resolverAddress,
      abi: resolverAbi,
      functionName: 'multicall',
      args: [calls],
      chain: sepolia,
      account,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`      ${calls.length} records written (tx ${hash})`)
  }

  console.log(
    `\n  Done. ${plan.length} agent record set(s) live under ${options.parentName} (${createdCount} newly created).`,
  )
  console.log(`  Verify: npm run verify\n`)
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const param of ['key', 'apikey', 'api_key']) {
      if (parsed.searchParams.has(param)) parsed.searchParams.set(param, '***')
    }
    return parsed.toString()
  } catch {
    return url
  }
}

main().catch((error: unknown) => {
  console.error(`\nSeed failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
