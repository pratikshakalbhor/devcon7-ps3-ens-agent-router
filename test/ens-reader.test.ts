import { describe, expect, it } from 'vitest'

import {
  InMemoryAgentReader,
  mapWithConcurrency,
  readAgentRecords,
} from '../lib/ens-reader.js'
import { isRoutable, serialiseAgentRecord } from '../lib/agent-record-schema.js'
import { MALFORMED_RECORDS, WELL_FORMED_RECORDS } from './helpers.js'

const GOOD_NAME = 'contract-helper.priya-studio-alice.eth'

function goodReader(): InMemoryAgentReader {
  return new InMemoryAgentReader({ [GOOD_NAME]: { ...WELL_FORMED_RECORDS } })
}

describe('InMemoryAgentReader', () => {
  it('reads back exactly what was stored, without aliasing the source', async () => {
    const reader = goodReader()
    const first = await reader.readAgent(GOOD_NAME)

    expect(first.name).toBe(GOOD_NAME)
    expect(first.records).toEqual(WELL_FORMED_RECORDS)
    expect(first.errors).toEqual([])

    // Mutating the returned records must not corrupt the stored ones.
    const copy = first.records as Record<string, string>
    copy['agent.dev.description'] = 'tampered'
    const second = await reader.readAgent(GOOD_NAME)
    expect(second.records['agent.dev.description']).toBe(
      WELL_FORMED_RECORDS['agent.dev.description'],
    )
  })

  it('reports an unknown name as an error rather than throwing', async () => {
    const reader = new InMemoryAgentReader({})
    const result = await reader.readAgent('nobody.example.eth')
    expect(result.records).toEqual({})
    expect(result.errors).toHaveLength(1)
    expect(reader.readCount).toBe(1)
  })

  it('reads a batch in input order', async () => {
    const reader = new InMemoryAgentReader({
      'a.example.eth': { ...WELL_FORMED_RECORDS },
      'b.example.eth': {},
      'c.example.eth': { ...WELL_FORMED_RECORDS },
    })

    const results = await reader.readAgents(['c.example.eth', 'a.example.eth', 'b.example.eth'])
    expect(results.map((entry) => entry.name)).toEqual([
      'c.example.eth',
      'a.example.eth',
      'b.example.eth',
    ])
    expect(reader.readCount).toBe(1)
  })

  it('models a fresh subname appearing after the reader was built', async () => {
    const reader = new InMemoryAgentReader({})
    expect(reader.names()).toEqual([])

    reader.set(GOOD_NAME, { ...WELL_FORMED_RECORDS })
    expect(reader.names()).toEqual([GOOD_NAME])

    reader.patch(GOOD_NAME, 'agent.dev.endpoint', 'https://new.example.com/ask')
    const patched = await reader.readAgent(GOOD_NAME)
    expect(patched.records['agent.dev.endpoint']).toBe('https://new.example.com/ask')

    reader.patch(GOOD_NAME, 'agent.dev.endpoint', undefined)
    const removed = await reader.readAgent(GOOD_NAME)
    expect(removed.records['agent.dev.endpoint']).toBeUndefined()
  })
})

describe('readAgentRecords', () => {
  it('parses raw records into validated agent records', async () => {
    const records = await readAgentRecords(goodReader(), [GOOD_NAME])

    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record?.name).toBe(GOOD_NAME)
    expect(record?.callSpec).not.toBeNull()
    expect(isRoutable(record!)).toBe(true)
    expect(record?.issues).toEqual([])
  })

  it('accepts an endpoint policy so local-dev names can be read back', async () => {
    const local = serialiseAgentRecord(
      {
        description: 'Answers billing questions for the studio.',
        endpoint: 'http://127.0.0.1:4003/ask',
        inputSchema: 'POST /ask { question: string } -> { answer: string }',
      },
      { endpointPolicy: { allowLocalhostHttp: true } },
    )

    const reader = new InMemoryAgentReader({ 'invoice-helper.example.eth': local })

    const [production] = await readAgentRecords(reader, ['invoice-helper.example.eth'])
    expect(isRoutable(production!)).toBe(false)

    const [localDev] = await readAgentRecords(reader, ['invoice-helper.example.eth'], {
      endpointPolicy: { allowLocalhostHttp: true },
    })
    expect(isRoutable(localDev!)).toBe(true)
  })

  it('surfaces malformed records instead of dropping them from the batch', async () => {
    const entries = Object.entries(MALFORMED_RECORDS).map(([label, records], index) => ({
      name: `bad-${index}.${label.replace(/\s+/g, '-')}.example.eth`,
      records: { ...records },
    }))
    const source = new Map(entries.map((entry) => [entry.name, entry.records]))

    const records = await readAgentRecords(
      new InMemoryAgentReader(source),
      entries.map((entry) => entry.name),
    )
    expect(records).toHaveLength(entries.length)
    for (const record of records) expect(isRoutable(record)).toBe(false)
  })

  it('counts names that resolved to nothing as not routable', async () => {
    const records = await readAgentRecords(new InMemoryAgentReader({}), [GOOD_NAME])
    expect(isRoutable(records[0]!)).toBe(false)
    expect(records[0]?.issues.some((issue) => issue.field === 'description')).toBe(true)
  })
})

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const delays = [30, 1, 20, 2, 10]
    const results = await mapWithConcurrency(delays, 3, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return `${index}:${ms}`
    })
    expect(results).toEqual(['0:30', '1:1', '2:20', '3:2', '4:10'])
  })

  it('never runs more than the limit at once', async () => {
    let active = 0
    let peak = 0

    await mapWithConcurrency([...Array(20).keys()], 4, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
    })

    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('handles empty input and a limit wider than the input', async () => {
    expect(await mapWithConcurrency([], 5, async () => 'x')).toEqual([])
    expect(await mapWithConcurrency(['a'], 50, async (item) => item)).toEqual(['a'])
  })

  it('treats a non-positive limit as one', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 0, async (value) => value * 2)
    expect(results).toEqual([2, 4, 6])
  })

  it('rejects the whole batch if any item fails', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error('boom')
        return value
      }),
    ).rejects.toThrow('boom')
  })
})
