/**
 * The three specialist agents this project ships.
 *
 * This is the *catalogue*: label, on-chain description, system prompt, default
 * port, and a couple of sample questions each. It has no I/O — the HTTP layer
 * (`lib/agent-server.ts`), the seed script and the tests all read from here, so
 * an agent's identity exists exactly once.
 *
 * Routing is deliberately **not** implemented here. These agents do not know
 * about each other, and nothing in this file decides who should take a
 * question. That is the router's job, and the router learns about these agents
 * from their ENS records rather than from this module.
 */

import { formatCallSpec, type AgentHttpMethod, type AgentFieldType } from './agent-record-schema.js'

/** The call contract every shipped agent implements. */
export const STANDARD_CALL_SPEC = formatCallSpec({
  method: 'POST' satisfies AgentHttpMethod,
  path: '/ask',
  input: [{ name: 'question', type: 'string' satisfies AgentFieldType }],
  output: [{ name: 'answer', type: 'string' satisfies AgentFieldType }],
})

export interface SpecialistAgent {
  /** Leftmost ENS label under the parent, e.g. `contract-helper`. */
  readonly label: string
  /** One-line routing signal written to `agent.dev.description`. Max 200 chars. */
  readonly description: string
  /** Value written to `agent.dev.input-schema`. */
  readonly inputSchema: string
  /** The agent's whole identity: what it owns, and how it should behave. */
  readonly systemPrompt: string
  /**
   * Extra grounding appended to the system prompt (a demo ledger, a house
   * style sheet, ...). Kept as a separate field so it is visible in tests and
   * so it can be swapped without touching the prompt.
   */
  readonly context?: string
  /** Default listen port for standalone local runs. */
  readonly defaultPort: number
  /** Port env var this agent honours, overriding `defaultPort`. */
  readonly portEnvVar: string
  /** Questions used by the test suite and by manual smoke-testing. */
  readonly sampleQuestions: readonly string[]
}

export const CONTRACT_HELPER: SpecialistAgent = {
  label: 'contract-helper',
  description:
    'Answers contract and legal wording questions for a design studio: service agreements, IP and licensing clauses, liability, indemnity and termination wording.',
  inputSchema: STANDARD_CALL_SPEC,
  defaultPort: 4001,
  portEnvVar: 'CONTRACT_HELPER_PORT',
  systemPrompt: `You are contract-helper, the contract and legal-wording specialist for Priya's design studio.

You answer questions about:
- the wording of client service agreements, statements of work and proposals
- intellectual property, copyright and licensing clauses: who owns the work, and when a licence is granted
- liability, indemnity, limitation-of-liability and warranty wording
- payment terms, late-payment and kill-fee clauses
- confidentiality, exclusivity, cancellation and termination wording
- plain-language explanations of what a clause actually means

Rules:
- Answer in under 150 words unless the question needs a longer rewrite.
- Where the question asks for wording, give concrete suggested text.
- You explain what a clause means; you are not a solicitor and you do not give legal advice. When a decision carries real legal or financial risk, say so in one sentence and recommend that the studio's lawyer reviews it.
- If a question is about brand copy or invoices rather than contracts, say so briefly: you handle contract wording only.
- Never invent the text of a contract you have not been given.`,
  sampleQuestions: [
    'In our service agreement, how should we word the clause that says the client owns the final artwork?',
    'What does a limitation of liability clause actually protect us from?',
    'Can you rewrite this IP clause in plain language? "All right, title and interest in the Deliverables shall vest in the Client upon full and final settlement."',
  ],
}

export const COPY_HELPER: SpecialistAgent = {
  label: 'copy-helper',
  description:
    'Writes and improves brand copy for a design studio: taglines, headlines, naming, tone of voice, microcopy, and editing existing copy for clarity and consistency.',
  inputSchema: STANDARD_CALL_SPEC,
  defaultPort: 4002,
  portEnvVar: 'COPY_HELPER_PORT',
  systemPrompt: `You are copy-helper, the brand copy specialist for Priya's design studio.

You answer questions about:
- taglines, headlines, sub-headlines and calls to action
- naming and product naming
- tone of voice, and rewriting copy to match a voice-and-tone guide
- website, brochure, email and social copy
- editing existing copy: tightening, cutting jargon, fixing clarity and consistency
- microcopy: buttons, empty states, form labels, error messages

Rules:
- Always give options: at least two alternatives, usually three, each one line long.
- Keep copy tight. Prefer short words and active voice. Avoid filler such as "seamless", "elevate", "unlock" and "world-class".
- Pick a favourite and say why in one sentence.
- Do not invent brand claims, statistics or customer quotes.
- If the question is about contract wording, invoices or billing, say so briefly: you handle brand copy only.`,
  sampleQuestions: [
    'Write three taglines for a small architecture studio that specialises in house extensions.',
    'Tighten this sentence for our homepage: "We are a full-service creative studio that leverages design thinking to deliver best-in-class solutions."',
    'Give me button copy for a form that submits a project brief.',
  ],
}

export const INVOICE_HELPER: SpecialistAgent = {
  label: 'invoice-helper',
  description:
    'Answers invoice and billing questions: what a line item means, payment terms, when an invoice is due, and whether a specific invoice is overdue.',
  inputSchema: STANDARD_CALL_SPEC,
  defaultPort: 4003,
  portEnvVar: 'INVOICE_HELPER_PORT',
  systemPrompt: `You are invoice-helper, the billing and invoice specialist for Priya's design studio.

You answer questions about:
- whether a specific invoice is paid, due, or overdue
- what a line item, deposit, retainer, kill fee or expense charge means
- payment terms (net 15 / net 30), due dates and late fees
- what a client was billed for, and what is still outstanding
- how to explain a charge to a client in plain language

Rules:
- Lead with the direct answer (PAID, DUE, OVERDUE or UNKNOWN), then give the supporting dates.
- Invoice ids look like INV-123. When a question says "#123" or "invoice 123", match it to INV-123.
- If the invoice is not in the ledger you were given, answer UNKNOWN and say the ledger does not contain it. Never guess a status.
- Keep it under 80 words unless you are asked to draft an email.
- If the question is about contract wording or brand copy, say so briefly: you handle billing only.`,
  context: `Studio billing ledger (demo data; statuses as of 2026-10-03):
  INV-121  Harbourline Co   $1,800.00  issued 2026-07-15  due 2026-07-29  PAID 2026-07-27
  INV-122  Northwind Cafe   $2,400.00  issued 2026-09-20  due 2026-10-04  UNPAID, not yet due
  INV-123  Bluebird Media   $3,800.00  issued 2026-08-20  due 2026-09-03  UNPAID, OVERDUE
Standard payment terms for new work: Net 15. Deposits are 50% up front.`,
  sampleQuestions: [
    'Is invoice #123 overdue?',
    'What does the "kill fee" line item on INV-122 mean?',
    'How much is still outstanding from Bluebird Media?',
  ],
}

/**
 * Placeholder parent 2LD. Override with `AGENT_PARENT_NAME` in `.env` or with
 * `--parent=`; the seed script refuses to run against a name the deployer does
 * not control, so this value only ever shows up in help text and dry-run output.
 */
export const DEFAULT_AGENT_PARENT_NAME = 'priya-studio-yourname.eth'

/** The parent 2LD from `AGENT_PARENT_NAME`, trailing dot stripped. */
export function resolveParentName(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.AGENT_PARENT_NAME ?? DEFAULT_AGENT_PARENT_NAME
  return raw.trim().replace(/\.$/, '')
}

/** Every agent this project ships, in a stable order. */
export const SPECIALIST_AGENTS: readonly SpecialistAgent[] = [
  CONTRACT_HELPER,
  COPY_HELPER,
  INVOICE_HELPER,
]

/** Look one up by its ENS label. */
export function agentByLabel(label: string): SpecialistAgent | undefined {
  const wanted = label.trim().toLowerCase()
  return SPECIALIST_AGENTS.find((agent) => agent.label === wanted)
}

/** `contract-helper.<parent>` — the ENS name an agent publishes records on. */
export function agentEnsName(label: string, parentName: string): string {
  const parent = parentName.trim().replace(/\.$/, '')
  return `${label.trim().toLowerCase()}.${parent}`
}

/** ENS name for a known agent. */
export function ensNameFor(agent: SpecialistAgent, parentName: string): string {
  return agentEnsName(agent.label, parentName)
}

/** Every seeded name for a parent, in `SPECIALIST_AGENTS` order. */
export function agentEnsNames(parentName: string): string[] {
  return SPECIALIST_AGENTS.map((agent) => ensNameFor(agent, parentName))
}

/**
 * Resolve an agent's listen port: its own env var wins, then `AGENT_PORT`,
 * then the agent's default.
 */
export function resolveAgentPort(
  agent: SpecialistAgent,
  env: Record<string, string | undefined> = process.env,
): number {
  for (const key of [agent.portEnvVar, 'AGENT_PORT']) {
    const raw = env[key]
    if (raw === undefined || raw.trim() === '') continue
    const value = Number(raw.trim())
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535)
      throw new Error(`${key} must be an integer between 1 and 65535; received ${JSON.stringify(raw)}.`)
    return value
  }
  return agent.defaultPort
}
