// Durable per-session Codex Mode state.
//
// Preferred backend: DSH's `storageDomain` facility (schema-validated KV over
// the profile storage backend). Fallback: a small JSON file under $DSH_HOME so
// headless/test profiles without storageDomain still persist state.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const DOMAIN = 'codex_mode'
const TABLE = 'sessions'
const VERSION = 1

const routeSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})

const sessionStateSchema = z.object({
  enabled: z.boolean(),
  threadId: z.string().optional(),
  previousRoute: routeSchema.optional(),
  cwd: z.string().optional(),
  updatedAt: z.number(),
})

const domainSpec = {
  name: DOMAIN,
  version: VERSION,
  tables: { [TABLE]: { valueSchema: sessionStateSchema } },
}

function stateFilePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'codex-mode', 'state.json')
}

/** Coerce a stored record into the known shape (drops unknown keys). */
function normalizeRecord(record) {
  const parsed = sessionStateSchema.safeParse(record)
  return parsed.success ? parsed.data : undefined
}

export class ModeStore {
  constructor({ ctx, log }) {
    this.ctx = ctx
    this.log = log
    this.memory = new Map()
    this.backend = 'memory'
    this.domain = undefined
    this.table = undefined
    this.writeChain = Promise.resolve()
  }

  async init() {
    const facility = this.ctx.get?.('storageDomain')
    if (facility && typeof facility.open === 'function') {
      try {
        this.domain = await facility.open(domainSpec)
        this.table = this.domain.table(TABLE)
        for (const [key, value] of this.table.entries()) {
          const record = normalizeRecord(value)
          if (record) this.memory.set(key, record)
        }
        this.backend = 'storageDomain'
        this.log?.debug?.(`[codex-mode] state backend: storageDomain (${this.memory.size} records)`)
        return
      } catch (error) {
        this.log?.warn?.(`[codex-mode] storageDomain unavailable, falling back to JSON state: ${error?.message || error}`)
      }
    }
    await this.#loadFile()
    this.log?.debug?.(`[codex-mode] state backend: json (${this.memory.size} records)`)
  }

  get(sessionId) {
    return this.memory.get(sessionId)
  }

  entries() {
    return this.memory.entries()
  }

  set(sessionId, value) {
    const record = normalizeRecord(value)
    if (!record) throw new Error(`[codex-mode] invalid state record for ${sessionId}`)
    this.memory.set(sessionId, record)
    if (this.table) {
      this.#enqueue(() => this.table.put(sessionId, record))
    } else if (this.backend === 'json') {
      this.#enqueue(() => this.#writeFile())
    }
    return Promise.resolve()
  }

  delete(sessionId) {
    this.memory.delete(sessionId)
    if (this.table) {
      this.#enqueue(() => this.table.delete(sessionId))
    } else if (this.backend === 'json') {
      this.#enqueue(() => this.#writeFile())
    }
    return Promise.resolve()
  }

  async close() {
    try {
      await this.writeChain
    } catch {}
    try {
      await this.domain?.close?.()
    } catch (error) {
      this.log?.debug?.(`[codex-mode] domain close failed: ${error?.message || error}`)
    }
    this.domain = undefined
    this.table = undefined
  }

  #enqueue(task) {
    this.writeChain = this.writeChain.then(task).catch((error) => {
      this.log?.warn?.(`[codex-mode] state write failed: ${error?.message || error}`)
    })
  }

  async #loadFile() {
    this.backend = 'json'
    try {
      const raw = await fs.readFile(stateFilePath(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        for (const [key, value] of Object.entries(parsed.sessions)) {
          const record = normalizeRecord(value)
          if (record) this.memory.set(key, record)
        }
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        this.log?.warn?.(`[codex-mode] could not read state file: ${error.message}`)
      }
    }
  }

  async #writeFile() {
    const file = stateFilePath()
    const dir = path.dirname(file)
    await fs.mkdir(dir, { recursive: true })
    const sessions = Object.fromEntries(this.memory.entries())
    const payload = JSON.stringify({ version: VERSION, sessions }, null, 2)
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, payload, 'utf8')
    await fs.rename(temporary, file)
  }
}
