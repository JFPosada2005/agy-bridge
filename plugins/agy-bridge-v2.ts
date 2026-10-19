// agy-bridge daemon manager plugin for opencode V2.
//
// V1 counterpart: plugins/agy-bridge.ts (kept unchanged). This file is the V2
// implementation: OpenCode 2.x loads a default-exported definition with a
// stable id and a setup(ctx) function that registers hooks, transforms and
// subscriptions through the context. V1 plugin implementations do not run in
// V2.
//
// Deployed by scripts/install.ps1 on V2 hosts to
// ~/.config/opencode/plugins/agy-bridge.ts. The V1 copy under
// ~/.config/opencode/plugin/ is retired on V2 hosts so only one copy loads.
//
// Behavior parity with V1: ensures the agy-bridge HTTP daemon (Node, fastify)
// is running on 127.0.0.1:41667 when opencode starts AND every 30 s afterwards
// (watchdog: self-heals daemon crashes mid-session). Reuses an already-healthy
// daemon and leaves it running (detached) after opencode exits so later
// sessions reuse it. Never fails opencode startup: all errors are logged and
// swallowed.
//
// Types are declared structurally and nothing is imported at runtime: V1 hosts
// cannot resolve @opencode/plugin, and tests import this file directly.

// Same AGY_BRIDGE_PORT contract as the daemon (src/index.ts), so the port
// can be moved if another program ever holds 41667.
const BRIDGE_PORT = Number(process.env.AGY_BRIDGE_PORT ?? "") || 41667
const BRIDGE_ORIGIN = `http://127.0.0.1:${BRIDGE_PORT}`
const HEALTH_URL = `${BRIDGE_ORIGIN}/healthz`
// Default OpenAI-compatible base URL the daemon serves. Used by the portable
// provider registration below; a user-defined provider entry keeps its own.
const AGY_BASE_URL_DEFAULT = `${BRIDGE_ORIGIN}/v1`
// Install token shared with the daemon (src/security.ts). Sent ONLY after
// the listener proved it knows the same token (HMAC over a fresh nonce).
const TOKEN_HEADER = "x-agy-token"
let currentToken: string | null = null
let daemonVerified = false
let impostorWarned = false
// Deployment-scoped: resolved from environment first — the user's checkout
// path NEVER lives in tracked source. Set AGY_BRIDGE_REPO on machines whose
// clone lives elsewhere; fallback is the standard LOCALAPPDATA install spot.
const BRIDGE_DIR =
  process.env.AGY_BRIDGE_REPO ?? `${process.env.LOCALAPPDATA ?? "."}\\agy-bridge`
const WATCHDOG_INTERVAL_MS = 30_000
const AGY_PROVIDER_ID = "agy-bridge"
const AGY_PROTOCOL_VERSION = "1"

// ---------------------------------------------------------------------------
// V2 plugin API (structural, runtime-dependency free)
// ---------------------------------------------------------------------------

interface V2Registration {
  dispose: () => Promise<void>
}

type V2Hook = (
  name: string,
  callback: (event: any) => void | Promise<void>,
  options?: { providerID?: string },
) => Promise<V2Registration>

interface V2ProviderEditor {
  get: (providerID: string) => { models: ReadonlyMap<string, any> } | undefined
  add: (input: { info: Record<string, unknown>; models: any[] }) => void
  models: {
    set: (providerID: string, models: readonly any[]) => void
  }
}

interface V2ModelEditor {
  get: (providerID: string, modelID: string) => any | undefined
  remove: (providerID: string, modelID: string) => void
}

interface V2Context {
  location?: { directory?: string }
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<any>
  }
  session: {
    hook: V2Hook
  }
  provider: {
    transform: (callback: (editor: V2ProviderEditor) => void) => Promise<V2Registration>
  }
  model?: {
    transform: (callback: (editor: V2ModelEditor) => void) => Promise<V2Registration>
  }
}

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

// Same home convention as the daemon: AGY_BRIDGE_HOME wins, else ~/.agy-bridge.
function bridgeHomeDir(): string | null {
  const override = process.env.AGY_BRIDGE_HOME?.trim()
  if (override) return override
  const home = process.env.USERPROFILE || process.env.HOME || ""
  if (!home) return null
  const sep = home.endsWith("\\") || home.endsWith("/") ? "" : "\\"
  return `${home}${sep}.agy-bridge`
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/

/**
 * Same algorithm as loadOrCreateToken in src/security.ts: read
 * <home>/token, or create it exclusively (`wx`, 0600) so the plugin and the
 * daemon never disagree. Returns null (no token sent) on any failure.
 */
async function loadOrCreateToken(): Promise<string | null> {
  try {
    const home = bridgeHomeDir()
    if (!home) return null
    const fs = await import("node:fs")
    const path = await import("node:path")
    const { randomBytes } = await import("node:crypto")
    const file = path.join(home, "token")
    try {
      const existing = fs.readFileSync(file, "utf8").trim()
      if (TOKEN_PATTERN.test(existing)) return existing
    } catch {
      // Missing: create below.
    }
    fs.mkdirSync(home, { recursive: true })
    const token = randomBytes(32).toString("hex")
    try {
      fs.writeFileSync(file, token, { encoding: "utf8", mode: 0o600, flag: "wx" })
      return token
    } catch {
      // Lost the race with the daemon, or a malformed file exists (the
      // daemon replaces it on start): use whatever valid token is there.
      const again = fs.readFileSync(file, "utf8").trim()
      return TOKEN_PATTERN.test(again) ? again : null
    }
  } catch {
    return null
  }
}

// Keep the "agy-bridge-health:" prefix identical to healthProof in src/security.ts.
async function expectedProof(token: string, nonce: string): Promise<string> {
  const { createHmac } = await import("node:crypto")
  return createHmac("sha256", token).update(`agy-bridge-health:${nonce}`).digest("hex")
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const { timingSafeEqual } = await import("node:crypto")
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

function warnImpostorOnce(): void {
  if (impostorWarned) return
  impostorWarned = true
  console.error(
    `[agy-bridge] ${BRIDGE_ORIGIN} is answering but could not prove it is your agy-bridge daemon. ` +
      "Not killing it and not sending your token. If you just upgraded agy-bridge, stop the old " +
      "daemon once; otherwise check which program holds the port " +
      `(Get-NetTCPConnection -LocalPort ${BRIDGE_PORT}) or set AGY_BRIDGE_PORT.`,
  )
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
        ...(logPath ? { AGY_BRIDGE_LOG: logPath } : {}),
        AGY_SESSION_MODE: "1",
      },
    })
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (!currentToken) currentToken = await loadOrCreateToken()
      if ((await healthInfo(currentToken)).verified) {
        daemonVerified = true
        console.error(`[agy-bridge] daemon started on ${BRIDGE_ORIGIN}`)
        return true
      }
    }
    console.error("[agy-bridge] daemon did not become healthy in 10s; check `npm run start` in the agy-bridge repo")
  } catch (error) {
    console.error("[agy-bridge] daemon bootstrap failed:", error)
  }
  return false
}

/**
 * Same build-id algorithm as the daemon (computeBuildId in src/server.ts):
 * sha1 over sorted dist/*.js (name\0content). Computed fresh per call: a
 * cached value made every watchdog tick see a permanent mismatch after a
 * rebuild and killed a healthy daemon forever.
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
  /** True only when the listener proved it knows the install token. */
  verified: boolean
  buildId?: string
  pid?: number
  inflight?: number
}

// The token is NEVER sent here: the listener may be any program holding the
// port. It must answer HMAC(token, nonce) for a fresh nonce instead.
async function healthInfo(token: string | null): Promise<HealthInfo> {
  try {
    const { randomBytes } = await import("node:crypto")
    const nonce = randomBytes(16).toString("hex")
    const res = await fetch(`${HEALTH_URL}?nonce=${nonce}`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return { ok: false, verified: false }
    const body = (await res.json()) as {
      buildId?: string
      pid?: number
      inflight?: number
      proof?: unknown
    }
    const verified =
      token !== null &&
      typeof body.proof === "string" &&
      (await safeEqual(body.proof, await expectedProof(token, nonce)))
    return {
      ok: true,
      verified,
      buildId: typeof body.buildId === "string" ? body.buildId : undefined,
      pid: typeof body.pid === "number" ? body.pid : undefined,
      inflight: typeof body.inflight === "number" ? body.inflight : undefined,
    }
  } catch {
    return { ok: false, verified: false }
  }
}

// Stale-daemon handshake (V1 parity): healthz 200 alone can hide an old build.
// On buildId mismatch with ZERO in-flight turns, restart with current code;
// with turns in flight, defer to the next watchdog tick.
async function ensureDaemon(logPath: string | null): Promise<boolean> {
  if (!currentToken) currentToken = await loadOrCreateToken()
  let health = await healthInfo(currentToken)
  if (!health.ok) {
    daemonVerified = false
    return spawnDaemon(logPath)
  }
  if (!health.verified) {
    // The daemon may have replaced a malformed/deleted token file: re-read once.
    currentToken = await loadOrCreateToken()
    health = await healthInfo(currentToken)
  }
  if (!health.verified) {
    // Security audit 2026-10-09: never trust (or kill) a pid reported by
    // a listener that cannot prove it is our daemon.
    daemonVerified = false
    warnImpostorOnce()
    return false
  }
  daemonVerified = true
  const expectedBuild = await expectedBuildId()
  if (
    expectedBuild &&
    health.buildId &&
    health.buildId !== expectedBuild &&
    health.inflight === 0 &&
    health.pid &&
    health.pid !== process.pid
  ) {
    daemonVerified = false
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

// ---------------------------------------------------------------------------
// Portable provider registration (user standing directive): the plugin must
// register agy-bridge as just another provider — provider entry plus its
// models — on ANY machine, without manual opencode.json edits. It deliberately
// does NOT inject agent definitions or workflow assumptions. OpenCode V2 has no
// mutable global config object, so this uses ctx.provider.transform (add-only:
// a user-defined provider/model is never clobbered).
// ---------------------------------------------------------------------------

// One entry per model family. Reasoning effort is a V2 model variant
// (agy-bridge/gemini-3.8-flash#high), which OpenCode applies as the OpenAI
// `reasoning_effort` field; the daemon translates it to the agy --effort flag.
const AGY_MODELS: Record<
  string,
  { name: string; context: number; output: number; efforts: string[]; defaultEffort?: string }
> = {
  "gemini-3.8-flash": { name: "Gemini 3.8 Flash", context: 1_048_576, output: 65_536, efforts: ["low", "medium", "high"] },
  "gemini-3.7-flash": { name: "Gemini 3.7 Flash", context: 1_048_576, output: 65_536, efforts: ["low", "medium", "high"] },
  "gemini-3.6-flash": { name: "Gemini 3.6 Flash", context: 1_048_576, output: 65_536, efforts: ["low", "medium", "high"] },
  "gemini-3.1-pro": { name: "Gemini 3.1 Pro", context: 1_048_576, output: 65_536, efforts: ["low", "high"] },
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6 (Thinking)", context: 1_000_000, output: 128_000, efforts: [] },
  "claude-opus-4-6-thinking": { name: "Claude Opus 4.6 (Thinking)", context: 1_000_000, output: 128_000, efforts: [] },
  "gpt-oss-120b": { name: "GPT-OSS 120B", context: 131_072, output: 131_072, efforts: ["medium"], defaultEffort: "medium" },
}

// V1 surfaced one model per effort level. Those ids remain valid daemon
// aliases (V1 configs keep working) but are removed from the V2 surface so
// each family is one selectable model with variants.
const LEGACY_MODEL_IDS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gpt-oss-120b-medium",
]

function buildModelInfos(): any[] {
  return Object.entries(AGY_MODELS).map(([modelID, model]) => {
    // A single-effort model adds no variant (the base request carries its
    // default); two or more efforts become selectable variants.
    const variants =
      model.efforts.length > 1
        ? model.efforts.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }))
        : []
    return {
      id: modelID,
      modelID,
      providerID: AGY_PROVIDER_ID,
      name: model.name,
      // V1 provider models were text models; capabilities are only claimed when
      // the bridge actually relays that modality.
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants,
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: model.context, output: model.output },
      ...(model.defaultEffort ? { settings: { reasoningEffort: model.defaultEffort } } : {}),
    }
  })
}

function registerProvider(editor: V2ProviderEditor): void {
  try {
    const models = buildModelInfos()
    const existing = editor.get(AGY_PROVIDER_ID)
    if (!existing) {
      editor.add({
        info: {
          id: AGY_PROVIDER_ID,
          name: "Antigravity (agy local)",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: AGY_BASE_URL_DEFAULT },
        },
        models,
      })
      return
    }
    // Migrate the V2 surface in place: remove the V1 per-effort ids, preserve
    // every user-defined model and field, and fill the variants this release
    // owns only when the model has none. A user-defined variant wins.
    const legacy = new Set(LEGACY_MODEL_IDS)
    const next: any[] = []
    const present = new Set<string>()
    let changed = false
    for (const [id, model] of existing.models) {
      if (legacy.has(id)) {
        changed = true
        continue
      }
      const replacement = models.find((candidate) => candidate.modelID === id)
      if (replacement) {
        present.add(id)
        const hasVariants = Array.isArray(model.variants) && model.variants.length > 0
        if (!hasVariants && replacement.variants.length > 0) {
          next.push({ ...model, variants: replacement.variants })
          changed = true
        } else {
          next.push(model)
        }
      } else {
        next.push(model)
      }
    }
    for (const model of models) {
      if (!present.has(model.modelID)) {
        next.push(model)
        changed = true
      }
    }
    if (changed) {
      editor.models.set(AGY_PROVIDER_ID, next)
    }
  } catch {
    // A transform must never throw: a provider registration failure cannot
    // take down the plugin or opencode startup.
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function postTombstone(sessionID: string): void {
  try {
    void fetch(`${BRIDGE_ORIGIN}/v1/__session/tombstone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(daemonVerified && currentToken ? { [TOKEN_HEADER]: currentToken } : {}),
      },
      body: JSON.stringify({ sessionId: sessionID }),
    }).catch(() => {
      // Fire-and-forget: bridge may be down; GC tolerates it.
    })
  } catch {
    // Never break the event loop.
  }
}

function delayUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

async function listenSessions(
  ctx: V2Context,
  signal: AbortSignal,
  parents: Map<string, string>,
  messages: Map<string, string>,
): Promise<void> {
  // The V2 service is shared across locations: ignore session events that
  // belong to a different location when the envelope carries one.
  const directory = ctx.location?.directory
  const belongsHere = (data: any): boolean =>
    !directory || !data?.location?.directory || data.location.directory === directory

  let retry = 500
  while (!signal.aborted) {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        if (signal.aborted) break
        // Every subscription opens with a server.connected handshake; only a
        // real event proves the stream is healthy enough to reset the backoff.
        if (event?.type !== "server.connected") retry = 500
        const data = event?.data
        if (event?.type === "session.created" && typeof data?.sessionID === "string" && data.sessionID) {
          if (!belongsHere(data)) continue
          if (typeof data.parentID === "string" && data.parentID) {
            parents.set(data.sessionID, data.parentID)
          }
        } else if (event?.type === "session.deleted" && typeof data?.sessionID === "string" && data.sessionID) {
          if (!belongsHere(data)) continue
          parents.delete(data.sessionID)
          messages.delete(data.sessionID)
          postTombstone(data.sessionID)
        }
      }
    } catch {
      // Disconnected: events missed while down are lost (same as V1), and the
      // header hook still binds sessions lazily from model.request.
    }
    if (signal.aborted) break
    await delayUnlessAborted(retry, signal)
    retry = Math.min(retry * 2, 10_000)
  }
}

// ---------------------------------------------------------------------------
// V2 entrypoint
// ---------------------------------------------------------------------------

async function setupAgyBridgeV2(ctx: V2Context): Promise<() => Promise<void>> {
  const clientInstanceId = newClientInstanceId()
  const parentBySession = new Map<string, string>()
  const messageBySession = new Map<string, string>()
  const abort = new AbortController()
  const registrations: V2Registration[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let listening: Promise<void> = Promise.resolve()

  const cleanup = async () => {
    disposed = true
    if (timer) clearInterval(timer)
    abort.abort()
    await Promise.allSettled(registrations.map((registration) => registration.dispose()))
    await listening.catch(() => {})
  }

  try {
    // Identity headers for the agy-bridge provider only. The V2 hook scope
    // replaces the V1 three-way provider heuristic. Sync, no network, and it
    // must never throw.
    registrations.push(
      await ctx.session.hook(
        "model.request",
        (event) => {
          try {
            if (typeof event?.sessionID === "string" && event.sessionID) {
              event.headers["x-agy-session-id"] = event.sessionID
              const parent = parentBySession.get(event.sessionID)
              if (parent) event.headers["x-agy-parent-session-id"] = parent
              // V2 has no message ID on model.request. The prompt hook's
              // messageID is the authoritative user message for the turn; it
              // is cached here so the bridge keeps its record key.
              const messageID = messageBySession.get(event.sessionID)
              if (messageID) event.headers["x-agy-message-id"] = messageID
            }
            if (typeof event?.agent === "string" && event.agent) {
              event.headers["x-agy-agent"] = event.agent
            }
            event.headers["x-agy-client-instance"] = clientInstanceId
            event.headers["x-agy-protocol-version"] = AGY_PROTOCOL_VERSION
            // Only to a listener that proved it is our daemon (watchdog check).
            if (daemonVerified && currentToken) {
              event.headers[TOKEN_HEADER] = currentToken
            }
          } catch {
            // Hook must never throw.
          }
        },
        { providerID: AGY_PROVIDER_ID },
      ),
    )

    // Capture the user message ID at admission. The prompt hook is not
    // provider-scoped because model resolution happens later; it still runs
    // once per admitted prompt for this location.
    registrations.push(
      await ctx.session.hook("prompt", (event) => {
        try {
          if (typeof event?.sessionID === "string" && typeof event?.messageID === "string" && event.messageID) {
            messageBySession.set(event.sessionID, event.messageID)
          }
        } catch {
          // Hook must never throw.
        }
      }),
    )

    if (ctx.provider?.transform) {
      registrations.push(await ctx.provider.transform(registerProvider))
    }

    // The provider transform can only migrate a provider it can see. A
    // config-defined V1 provider may be merged after plugin setup, so also
    // hide the legacy per-effort ids from the active model collection. This
    // is idempotent and leaves every other model untouched.
    if (ctx.model?.transform) {
      registrations.push(
        await ctx.model.transform((editor) => {
          try {
            for (const id of LEGACY_MODEL_IDS) {
              if (editor.get(AGY_PROVIDER_ID, id)) {
                editor.remove(AGY_PROVIDER_ID, id)
              }
            }
          } catch {
            // Transform must never throw.
          }
        }),
      )
    }

    listening = listenSessions(ctx, abort.signal, parentBySession, messageBySession)

    const logPath = bridgeLogPath()
    await ensureBridgeLogDir(logPath)
    // Parity with V1: the token handshake is complete before the first model
    // request can be issued with a token header.
    await ensureDaemon(logPath)
    if (!disposed) {
      timer = setInterval(() => {
        if (!disposed) void ensureDaemon(logPath)
      }, WATCHDOG_INTERVAL_MS)
      timer.unref?.()
    }
  } catch (error) {
    console.error("[agy-bridge] V2 plugin init failed:", error)
  }

  return cleanup
}

export default {
  id: "agy-bridge",
  setup: setupAgyBridgeV2,
}
