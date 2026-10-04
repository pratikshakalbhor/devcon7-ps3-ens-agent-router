/**
 * Reading agent self-descriptions off ENS.
 *
 * The seed script, the verifier and (later) the router's discovery pass all go
 * through this seam, so none of them touches viem's text-record API directly
 * and the router can be tested against an in-memory reader instead of a chain.
 *
 * Every live read is a `getEnsText` call through the Universal Resolver, which
 * transparently handles wrapped subnames and CCIP-read resolvers.
 */
import type { Chain, PublicClient as ViemPublicClient, Transport } from 'viem'
import { createPublicClient, http as httpTransport } from 'viem'
import { getEnsText } from 'viem/actions'

import {
  AGENT_RECORD_KEY_LIST,
  parseAgentRecord,
  type AgentRecord,
  type AgentRecordKey,
  type EndpointPolicy,
  type RawAgentRecords,
} from './agent-record-schema.js'
import { SEPOLIA_CHAIN as sepolia } from './chain.js'

/** An agent exactly as stored on chain, plus whatever else we could resolve. */
export interface RawEnsAgent {
  readonly name: string
  readonly records: RawAgentRecords
  /** Any read errors encountered. A record with errors is still returned. */
  readonly errors: readonly string[]
}

export interface ReadAgentRecordsOptions {
  /**
   * Maximum names read in parallel. Public RPCs commonly rate-limit, so keep
   * this modest (default 3 — there are only three agents anyway).
   */
  readonly concurrency?: number
  /** Block to read at. Defaults to `latest`. */
  readonly blockNumber?: bigint
}

/** The single seam discovery depends on. */
export interface AgentReader {
  readAgents(names: readonly string[], options?: ReadAgentRecordsOptions): Promise<RawEnsAgent[]>
  readAgent(name: string, options?: ReadAgentRecordsOptions): Promise<RawEnsAgent>
}

export interface ReadParsedOptions extends ReadAgentRecordsOptions {
  readonly endpointPolicy?: EndpointPolicy
}

/** Read + parse in one step: what `npm run verify` and the router both want. */
export async function readAgentRecords(
  reader: AgentReader,
  names: readonly string[],
  options: ReadParsedOptions = {},
): Promise<AgentRecord[]> {
  const raw = await reader.readAgents(names, options)
  return raw.map((entry) =>
    parseAgentRecord(entry.name, entry.records, {
      ...(options.endpointPolicy === undefined ? {} : { endpointPolicy: options.endpointPolicy }),
    }),
  )
}

/** A viem public client. Aliased so consumers can share the type without importing viem. */
export type PublicClient = ViemPublicClient<Transport, Chain>

const KEYS: readonly AgentRecordKey[] = AGENT_RECORD_KEY_LIST

/** Live reader. Every value comes from an on-chain `getEnsText` call. */
export class EnsTextAgentReader implements AgentReader {
  readonly #client: PublicClient
  readonly #concurrency: number

  constructor(client: PublicClient, options: { concurrency?: number } = {}) {
    this.#client = client
    this.#concurrency = options.concurrency ?? 3
  }

  async readAgent(name: string, options: ReadAgentRecordsOptions = {}): Promise<RawEnsAgent> {
    const [result] = await this.readAgents([name], options)
    if (result === undefined) throw new Error(`Failed to read agent records for "${name}"`)
    return result
  }

  async readAgents(
    names: readonly string[],
    options: ReadAgentRecordsOptions = {},
  ): Promise<RawEnsAgent[]> {
    const concurrency = Math.max(1, options.concurrency ?? this.#concurrency)
    const readOptions = { blockNumber: options.blockNumber, strict: true } as const

    const readOne = async (rawName: string): Promise<RawEnsAgent> => {
      const name = rawName.trim()
      const records: RawAgentRecords = {}
      const errors: string[] = []

      await mapWithConcurrency(KEYS, concurrency, async (key) => {
        try {
          const value = await getEnsText(this.#client, { ...readOptions, name, key })
          if (value !== null && value !== undefined) records[key] = value
        } catch (cause) {
          errors.push(`${key}: ${errorMessage(cause)}`)
        }
      })

      return { name, records, errors }
    }

    return mapWithConcurrency(names, concurrency, readOne)
  }
}

/**
 * In-memory reader backed by a plain object. This is what the tests use, and it
 * models the chain faithfully: mutate the source and the next read reflects it.
 */
export class InMemoryAgentReader implements AgentReader {
  readonly #source: Map<string, RawAgentRecords>
  /** Number of `readAgents` calls, so tests can assert a refresh hit the source. */
  readCount = 0

  constructor(source: Record<string, RawAgentRecords> | Map<string, RawAgentRecords>) {
    this.#source = source instanceof Map ? source : new Map(Object.entries(source))
  }

  set(name: string, records: RawAgentRecords): this {
    this.#source.set(name, records)
    return this
  }

  /** Patch one record key for one name; `undefined` deletes it. */
  patch(name: string, key: AgentRecordKey, value: string | undefined): this {
    const current: RawAgentRecords = { ...(this.#source.get(name) ?? {}) }
    if (value === undefined) delete current[key]
    else current[key] = value
    this.#source.set(name, current)
    return this
  }

  names(): string[] {
    return [...this.#source.keys()]
  }

  async readAgent(name: string): Promise<RawEnsAgent> {
    const [result] = await this.readAgents([name])
    if (result === undefined) throw new Error(`Unknown name "${name}"`)
    return result
  }

  readAgents(names: readonly string[]): Promise<RawEnsAgent[]> {
    this.readCount += 1
    return Promise.resolve(
      names.map((rawName) => {
        const name = rawName.trim()
        const records = this.#source.get(name)
        return {
          name,
          records: records ? { ...records } : {},
          errors: records ? [] : [`no records for "${name}"`],
        }
      }),
    )
  }
}

export interface CreatePublicClientOptions {
  readonly rpcUrl: string
  /** Defaults to Sepolia; overridable so callers are not locked to one chain. */
  readonly chain?: Chain
  readonly timeout?: number
  readonly retries?: number
}

/** Build a Sepolia public client from an RPC URL. */
export function createPublicClientFromEnv(options: CreatePublicClientOptions): PublicClient {
  return createPublicClient({
    chain: options.chain ?? sepolia,
    transport: httpTransport(options.rpcUrl, {
      timeout: options.timeout ?? 30_000,
      retryCount: options.retries ?? 2,
    }),
  })
}

export function createEnsReader(
  rpcUrl: string,
  options: { concurrency?: number; chain?: Chain } = {},
): EnsTextAgentReader {
  const client = createPublicClientFromEnv({ rpcUrl, chain: options.chain })
  return new EnsTextAgentReader(client, { concurrency: options.concurrency })
}

/** Run `fn` over `items` with bounded parallelism, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor++
      const item = items[index]
      if (index >= items.length || item === undefined) return
      results[index] = await fn(item, index)
    }
  })
  await Promise.all(workers)
  return results
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    const withShort = cause as Error & { shortMessage?: string }
    return withShort.shortMessage ?? cause.message
  }
  return String(cause)
}
