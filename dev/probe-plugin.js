// dev/probe-plugin.js — T-test dev tool (NOT part of the shipped plugin).
//
// Mounted into `dsh --profile headless` via dev/probe.overlay.yml to record which
// services the composed headless profile actually provides, plus a few method
// shapes the codex-mode plugin will want (agent loop, session, llm, tools,
// commands, storage, sessionController, ...).
//
// Output contract:
//   - one compact line on stderr:   [probe] <json>   (always visible in logs)
//   - full report JSON at           $DSH_PROBE_OUT (default /tmp/dsh-codex-probe.json)
// Two snapshots are taken: immediately in apply() (mount-time) and ~2s later
// (steady state, after the loader has settled and the run has started).
//
// Services are discovered from the Cordis root isolation map (every name ever
// `provide`d in the root scope) and each is classified with ctx.get(name):
//   'active' — currently active provider (strict availability)
//   'mounted-but-inactive' — provider fiber exists but is not active
//                             (e.g. its `inject` cannot be satisfied)
import { writeFileSync } from 'node:fs'

export const name = 'codex-mode-probe'

// Cordis exposes the root isolation map under a well-known symbol; using
// Symbol.for keeps this dev probe dependency-free (the repo does not symlink
// @deepseek-ai/cordis, and loader module resolution runs from this directory).
const ISOLATE = Symbol.for('cordis.isolate')

/** Services the codex-mode implementation is expected to consume, if mounted. */
const INTERESTING = [
  // core / loop
  'agent', 'agents', 'agentLoop', 'agent-loop', 'session', 'sessions',
  'llm', 'tools', 'commands', 'commandFeedback', 'systemPrompt',
  // persistence / storage
  'sessionPersistence', 'sessionQuery', 'sessionProjection', 'storage',
  'storageDomain', 'storageHub', 'attachments',
  // control-plane (web-oriented; may be absent in headless)
  'sessionController', 'modelCatalog', 'gateway', 'apiGateway', 'remote',
  'profileContext', 'loader', 'logger', 'settings', 'credentials',
  'authorization', 'approval', 'userApproval', 'permission',
  'sandbox', 'sandboxPolicy', 'fs', 'subprocess', 'jobs',
  // misc
  'timer', 'hmr', 'typert', 'typertRegistry', 'spill', 'tokenMeter',
  'skills', 'web', 'mcp', 'otel',
]

/** Bounded shape of one service value: ctor name, own fields, prototype methods. */
function describe(value) {
  const info = { ctor: value?.constructor?.name ?? typeof value }
  if (typeof value === 'function') return info
  try {
    const keys = Object.keys(value ?? {})
    if (keys.length && keys.length <= 80) info.fields = keys.sort()
  } catch {}
  try {
    const methods = new Set()
    for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue
        const descriptor = Object.getOwnPropertyDescriptor(proto, key)
        if (typeof descriptor?.value === 'function') methods.add(key)
      }
    }
    if (methods.size) info.methods = [...methods].sort()
  } catch {}
  return info
}

function collect(ctx) {
  // Cordis exposes the root isolation map via the well-known isolate symbol.
  const root = ctx.root
  const map = root?.[ISOLATE] ?? {}
  const allNames = Object.keys(map)

  const services = {}
  const inactive = []
  for (const serviceName of allNames) {
    const value = ctx.get(serviceName)
    if (value === undefined) {
      inactive.push(serviceName)
      continue
    }
    services[serviceName] = describe(value)
  }

  const interesting = {}
  for (const serviceName of INTERESTING) {
    const value = ctx.get(serviceName)
    interesting[serviceName] = { active: value !== undefined }
    if (value !== undefined) interesting[serviceName].impl = describe(value)
  }

  return {
    time: new Date().toISOString(),
    pid: process.pid,
    counts: { all: allNames.length, active: Object.keys(services).length, inactive: inactive.length },
    services,
    inactiveNames: inactive.sort(),
    interesting,
  }
}

export function apply(ctx) {
  const out = process.env.DSH_PROBE_OUT || '/tmp/dsh-codex-probe.json'
  const snapshots = []
  let written = false

  const write = (why) => {
    try {
      writeFileSync(out, JSON.stringify({ why, snapshots }, null, 2))
      written = true
    } catch (error) {
      console.error('[probe] report write failed:', error?.message ?? error)
    }
  }
  const snap = (why) => {
    try {
      const report = collect(ctx)
      report.why = why
      snapshots.push(report)
      write(why)
      // Compact stderr line so the counts are visible even without the file.
      console.error(
        `[probe] ${why} services=${report.counts.active}/${report.counts.all}` +
          ` inactive=${report.counts.inactive}` +
          ` agentLoop=${report.interesting['agentLoop']?.active || report.interesting['agent-loop']?.active || false}` +
          ` sessionController=${report.interesting.sessionController?.active || false}`,
      )
    } catch (error) {
      console.error('[probe] snapshot failed:', error?.stack ?? error)
    }
  }

  snap('mount')
  const timer = setTimeout(() => snap('steady'), 2000)
  timer.unref?.()
  process.once('beforeExit', () => {
    if (!written) snap('beforeExit')
  })

  return () => {
    clearTimeout(timer)
    snap('dispose')
  }
}
