/**
 * Minimal .env loader + shared config.
 *
 * Node >= 20.12 exposes `process.loadEnvFile`, but we keep a hand-rolled parser as a
 * fallback so the scripts behave the same on older runtimes and under bundlers.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type Env = Record<string, string | undefined>

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/

function stripQuotes(value: string): string {
  const quote = value.charAt(0)
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1)
  }
  return value
}

function parseEnvFile(contents: string): Env {
  const out: Env = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const key = ENV_LINE.exec(line)?.[1]
    if (key === undefined) continue
    const value = ENV_LINE.exec(line)?.[2]
    out[key] = value === undefined ? '' : stripQuotes(value)
  }
  return out
}

/**
 * Load `path` into `process.env` without clobbering values that are already set.
 * Missing files are ignored so CI (and the test suite) need no .env at all.
 */
export function loadEnvFile(path = resolve(process.cwd(), '.env')): Env {
  const values = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {}
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value
  }
  return values
}

export function requireEnv(env: Env, key: string, hint?: string): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var ${key}.${hint ? ` ${hint}` : ''}`)
  }
  return value.trim()
}

export function optionalEnv(env: Env, key: string): string | undefined {
  const value = env[key]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}