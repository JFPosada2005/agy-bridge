// agy-bridge daemon manager plugin for opencode.
//
// Canonical source of this file is the agy-bridge project repo
// (plugins/agy-bridge.ts). The copy installed in ~/.config/opencode/plugin/
// is deployed by hand until the plugin ships as an npm package. Keep both in
// sync when editing.
//
// Behavior: ensures the agy-bridge HTTP daemon (Node, fastify) is running on
// 127.0.0.1:41667 when opencode starts AND every 30s afterwards (watchdog:
// self-heals daemon crashes mid-session). Reuses an already-healthy daemon
// and leaves it running (detached) after opencode exits so later sessions
// reuse it. Never fails opencode startup: all errors are logged and swallowed.
//
// Phase 0 identity channel (design slice3-session-architecture.md section 3):
// injects x-agy-* headers ONLY for provider agy-bridge via chat.headers.
// The hook never throws, never awaits network, and returns fast.
import type { Plugin } from "@opencode-ai/plugin"

const HEALTH_URL = "http://127.0.0.1:41667/healthz"
// Default OpenAI-compatible base URL the daemon serves. Used by the portable
// provider registration below; a user-defined provider entry keeps its own.
const AGY_BASE_URL_DEFAULT = "http://127.0.0.1:41667/v1"
// Deployment-scoped: resolved from environment first — the user's checkout
// path NEVER lives in tracked source. Set AGY_BRIDGE_REPO on machines whose
// clone lives elsewhere; fallback is the standard LOCALAPPDATA install spot.
const BRIDGE_DIR =
  process.env.AGY_BRIDGE_REPO ?? `${process.env.LOCALAPPDATA ?? "."}\\agy-bridge`
const WATCHDOG_INTERVAL_MS = 30_000
const AGY_PROVIDER_ID = "agy-bridge"
const AGY_PROTOCOL_VERSION = "1"

// Random client instance id, generated once per plugin init.
function newClientInstanceId(): string {
  try {
    const rand = Math.floor(Math.random() * 0xffffff).toString(36)
    return `${Date.now().toString(36)}-${rand}`
  } catch {
    return "unknown"
  }
}

// Bridge log file passed to the daemon so request logging lands on disk.
// Matches the daemon's AGY_BRIDGE_LOG contract (append-only, UTF-8, no BOM).
function bridgeLogPath(): string | null {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || ""
    if (!home) return null
    const sep = home.endsWith("\\") || home.endsWith("/") ? "" : "\\"
    return `${home}${sep}.agy-bridge\\bridge.log`
  } catch {
    return null
  }
}

async function ensureBridgeLogDir(logPath: string | null): Promise<void> {
  if (!logPath) return
  try {
    const { default: fs } = await import("node:fs")
    const { default: path } = await import("node:path")
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
  } catch {
    // Best effort; the daemon creates its own dir as well.
  }
}

const spawnDaemon = async (logPath: string | null): Promise<boolean> => {
  try {
    const node = process.env.AGY_BRIDGE_NODE || "C:\\Program Files\\nodejs\\node.exe"
    const { spawn } = await import("node:child_process")
    spawn(node, ["dist/index.js"], {
      cwd: BRIDGE_DIR,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        // BUGFIX: the undeclared AGY_BRIDGE_LOG variable here crashed every
        // watchdog respawn attempt (latent: spawnDaemon only runs when the
        // daemon is DOWN). Pass the computed logPath instead.
        ...(logPath ? { AGY_BRIDGE_LOG: logPath } : {}),
        AGY_SESSION_MODE: "1",
      },
    })
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (await healthy()) {
        console.error("[agy-bridge] daemon started on 127.0.0.1:41667")
        return true
      }
    }
    console.error("[agy-bridge] daemon did not become healthy in 10s; check `npm run start` in the agy-bridge repo")
  } catch (error) {
    console.error("[agy-bridge] daemon bootstrap failed:", error)
  }
  return false
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Same build-id algorithm as the daemon (computeBuildId in src/server.ts):
 * sha1 over sorted dist/*.js (name\0content). Cached once per plugin init.
 * Returns null when dist is missing — handshake then stays dormant.
 */
async function expectedBuildId(): Promise<string | null> {
  try {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const { createHash } = await import("node:crypto")
    const files = fs
      .readdirSync(path.join(BRIDGE_DIR, "dist"))
      .filter((f) => f.endsWith(".js"))
      .sort()
    if (files.length === 0) return null
    const hash = createHash("sha1")
    // Identical to the daemon: one sha1 over parts joined by NUL, no trailing separator.
    const parts = files.map(
      (f) => `${f}\0${fs.readFileSync(path.join(BRIDGE_DIR, "dist", f), "utf8")}`,
    )
    hash.update(parts.join("\0"))
    return hash.digest("hex")
  } catch {
    return null
  }
}

interface HealthInfo {
  ok: boolean
  buildId?: string
  pid?: number
  inflight?: number
}

async function healthInfo(): Promise<HealthInfo> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return { ok: false }
    const body = (await res.json()) as { buildId?: string; pid?: number; inflight?: number }
    return {
      ok: true,
      buildId: typeof body.buildId === "string" ? body.buildId : undefined,
      pid: typeof body.pid === "number" ? body.pid : undefined,
      inflight: typeof body.inflight === "number" ? body.inflight : undefined,
    }
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// Portable registration (user standing directive): the plugin must register
// agy-bridge as just another provider — provider entry plus its models — on
// ANY machine, without manual opencode.json edits. It deliberately does NOT
// inject agent definitions or workflow assumptions: using a model as a
// subagent is opencode's native mechanism (spawned agents inherit the
// session model, and users bind their own agents to any provider they like).
// opencode deep-merges configs, and every entry is only added when the user
// has not defined it herself — her own overrides are never clobbered.
// ---------------------------------------------------------------------------

// Mirrors the user's proven global provider block so a fresh install matches
// the same model surface the daemon exposes (ids are the bridge's
// task/model registry contract).
const AGY_MODELS: Record<string, { name: string; context: number; output: number }> = {
  "gemini-3.1-pro-high": { name: "Gemini 3.1 Pro (High)", context: 1_000_000, output: 65_536 },
  "gemini-3.1-pro-low": { name: "Gemini 3.1 Pro (Low)", context: 1_000_000, output: 65_536 },
  "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)", context: 1_000_000, output: 65_536 },
  "gemini-3.8-flash-medium": { name: "Gemini 3.8 Flash (Medium)", context: 1_000_000, output: 65_536 },
  "gemini-3.8-flash-low": { name: "Gemini 3.8 Flash (Low)", context: 1_000_000, output: 65_536 },
  "gemini-3.7-flash-high": { name: "Gemini 3.7 Flash (High)", context: 1_000_000, output: 65_536 },
  "gemini-3.7-flash-medium": { name: "Gemini 3.7 Flash (Medium)", context: 1_000_000, output: 65_536 },
  "gemini-3.7-flash-low": { name: "Gemini 3.7 Flash (Low)", context: 1_000_000, output: 65_536 },
  "gemini-3.6-flash-high": { name: "Gemini 3.6 Flash (High)", context: 1_000_000, output: 65_536 },
  "gemini-3.6-flash-medium": { name: "Gemini 3.6 Flash (Medium)", context: 1_000_000, output: 65_536 },
  "gemini-3.6-flash-low": { name: "Gemini 3.6 Flash (Low)", context: 1_000_000, output: 65_536 },
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6 (Thinking)", context: 200_000, output: 32_768 },
  "claude-opus-4-6-thinking": { name: "Claude Opus 4.6 (Thinking)", context: 200_000, output: 32_768 },
  "gpt-oss-120b-medium": { name: "GPT-OSS 120B (Medium)", context: 200_000, output: 32_768 },
}

// Ready-to-spawn subagents stay out of the plugin on purpose (see the
// portable registration note above).

export default (async () => {
  const clientInstanceId = newClientInstanceId()
  const parentBySession = new Map<string, string>()
  let logPath: string | null = null
  try {
    logPath = bridgeLogPath()
    await ensureBridgeLogDir(logPath)
  } catch {
    logPath = null
  }

  const expectedBuild = await expectedBuildId()
  void expectedBuild
  // Stale-cache fix: expectedBuildId must NEVER be cached for the plugin's
  // lifetime. When it was cached at init, any rebuild between window start
  // and now made every watchdog tick see a permanent mismatch -> the plugin
  // killed a HEALTHY daemon and respawned it, forever ("daemon started"
  // printed repeatedly, spawn windows flashing). Compute fresh per call.

  async function ensureDaemon(): Promise<boolean> {
    // Stale-daemon handshake (T12): healthz 200 alone can hide an old build.
    // On buildId mismatch with ZERO in-flight turns, restart with current
    // code; with turns in flight, defer to the next watchdog tick.
    const health = await healthInfo()
    if (!health.ok) {
      return spawnDaemon(logPath)
    }
    const expectedBuild = await expectedBuildId()
    if (
      expectedBuild &&
      health.buildId &&
      health.buildId !== expectedBuild &&
      health.inflight === 0 &&
      health.pid &&
      health.pid !== process.pid
    ) {
      try {
        process.kill(health.pid)
      } catch {
        // Already gone; the respawn below recreates it.
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
      return spawnDaemon(logPath)
    }
    return true
  }

  try {
    await ensureDaemon()
    // Watchdog: restart the daemon if it dies mid-session (crash, manual kill).
    // Timers die with the opencode process; make sure they never block exit.
    const timer = setInterval(() => void ensureDaemon(), WATCHDOG_INTERVAL_MS)
    timer.unref?.()
  } catch (error) {
    console.error("[agy-bridge] plugin init failed:", error)
  }

  return {
    // Portable provider registration (see AGY_MODELS). Mutate in place;
    // add-only: a user's own provider entries are never clobbered.
    config: (cfg) => {
      try {
        const typed = cfg as { provider?: Record<string, unknown> }
        if (!typed.provider || typeof typed.provider !== "object") typed.provider = {}
        const providers = typed.provider

        const existingProvider = providers[AGY_PROVIDER_ID]
        const providerBlock =
          existingProvider && typeof existingProvider === "object"
            ? (existingProvider as Record<string, unknown>)
            : {}
        if (!providerBlock.npm) providerBlock.npm = "@ai-sdk/openai-compatible"
        if (!providerBlock.name) providerBlock.name = "Antigravity (agy local)"
        const options =
          providerBlock.options && typeof providerBlock.options === "object"
            ? (providerBlock.options as Record<string, unknown>)
            : {}
        // Add-only: don't clobber a user-set baseURL.
        if (options.baseURL === undefined) options.baseURL = AGY_BASE_URL_DEFAULT
        providerBlock.options = options
        const models =
          providerBlock.models && typeof providerBlock.models === "object"
            ? (providerBlock.models as Record<string, unknown>)
            : {}
        for (const [id, m] of Object.entries(AGY_MODELS)) {
          if (!models[id]) {
            models[id] = { name: m.name, limit: { context: m.context, output: m.output } }
          }
        }
        providerBlock.models = models
        providers[AGY_PROVIDER_ID] = providerBlock
      } catch {
        // Never break opencode from the config hook.
      }
    },
    // Track parent linkage from observed session events (fast, in-memory).
    // Absent parent means omit the header; never throw.
    event: async (input) => {
      try {
        const event = (input as { event?: unknown }).event as
          | { type?: unknown; properties?: unknown }
          | undefined
        if (!event || typeof event.type !== "string") return
        if (event.type !== "session.created" && event.type !== "session.updated") {
          // T15: forward session.deleted so the bridge tombstones the record.
          if (event.type === "session.deleted") {
            const props = event.properties as { info?: unknown } | undefined
            const info = props?.info as { id?: unknown } | undefined
            if (typeof info?.id === "string" && info.id) {
              void fetch("http://127.0.0.1:41667/v1/__session/tombstone", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: info.id }),
              }).catch(() => {
                // Fire-and-forget: bridge may be down; GC tolerates it.
              })
            }
          }
          return
        }
        const props = event.properties as { info?: unknown } | undefined
        const info = props?.info as { id?: unknown; parentID?: unknown } | undefined
        if (typeof info?.id !== "string" || !info.id) return
        if (typeof info.parentID === "string" && info.parentID) {
          parentBySession.set(info.id, info.parentID)
        }
      } catch {
        // Never break opencode from the event hook.
      }
    },
    // Identity headers for the agy-bridge provider only. Sync, no network.
    "chat.headers": async (input, output) => {
      try {
        const typed = input as {
          sessionID?: unknown
          agent?: unknown
          model?: { providerID?: unknown } | null
          provider?: { info?: { id?: unknown } } | null
          message?: { id?: unknown; model?: { providerID?: unknown } } | null
        }
        const modelProvider =
          typeof typed.model?.providerID === "string" ? typed.model.providerID : ""
        const contextProvider =
          typeof typed.provider?.info?.id === "string" ? typed.provider.info.id : ""
        const messageProvider =
          typeof typed.message?.model?.providerID === "string"
            ? typed.message.model.providerID
            : ""
        const isAgy =
          modelProvider === AGY_PROVIDER_ID ||
          contextProvider === AGY_PROVIDER_ID ||
          messageProvider === AGY_PROVIDER_ID
        if (!isAgy) return
        // Explicit non-agy provider involved means do not inject.
        const involved = [modelProvider, contextProvider, messageProvider].filter(Boolean)
        if (involved.length > 0 && !involved.includes(AGY_PROVIDER_ID)) return

        const out = output as { headers?: Record<string, string> }
        if (!out.headers || typeof out.headers !== "object") {
          out.headers = {}
        }
        if (typeof typed.sessionID === "string" && typed.sessionID) {
          out.headers["x-agy-session-id"] = typed.sessionID
          const parent = parentBySession.get(typed.sessionID)
          if (parent) {
            out.headers["x-agy-parent-session-id"] = parent
          }
        }
        if (typeof typed.agent === "string" && typed.agent) {
          out.headers["x-agy-agent"] = typed.agent
        }
        const messageId = typed.message?.id
        if (typeof messageId === "string" && messageId) {
          out.headers["x-agy-message-id"] = messageId
        }
        out.headers["x-agy-client-instance"] = clientInstanceId
        out.headers["x-agy-protocol-version"] = AGY_PROTOCOL_VERSION
      } catch {
        // Hook must never throw.
      }
    },
  }
}) satisfies Plugin
