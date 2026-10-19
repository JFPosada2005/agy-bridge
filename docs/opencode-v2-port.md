# Porting the agy-bridge plugin to the OpenCode V2 plugin API

> **Status (2026-10-19): implemented and verified on OpenCode 2.0.32.** The
> shipped implementation is `plugins/agy-bridge-v2.ts` (a separate V2 file, not
> the dual entrypoint of section 5). Verification evidence lives in the committed
> tests (`tests/pluginV2.test.ts`, `tests/reasoningEffort.test.ts`,
> `tests/migrateAgyModels.test.ts`, `tests/migrateAgyModelsPreserve.test.ts`),
> the README, and the live `bridge.log`. One correction to section 4: the known
> gap is closed (see the note there).

OpenCode V2 (2.0.x) will not load `plugins/agy-bridge.ts`. The daemon and the provider still work. What stops working is the plugin's job: no watchdog, no `x-agy-*` identity headers, and no automatic provider registration. This guide explains how to port the plugin to V2 and how to keep one file that loads in both V1 and V2.

Each claim has a label. **[V]** means verified, and the source is given. **[A]** means it is an assumption and still needs testing.

Sources used:

- Docs: <https://opencode.ai/v2/docs/migrate-v1/> and <https://opencode.ai/v2/docs/build/plugins/migrate-v1/>.
- SDK types: `~/.config/opencode/node_modules/@opencode/plugin/dist/promise/*.d.ts` (`@opencode/plugin` 2.0.4).
- Event types: `.../@opencode/plugin/node_modules/@opencode/client/dist/promise/generated/types.d.ts`.
- Local V2 plugins that already work: `~/.config/opencode/plugins/opencode-review-transport.ts` and `engram.ts` (its `setupEngramV2` function).

## 1. Why it fails today

The log at `~/.local/share/opencode/log/opencode.log` shows this on every start **[V]**:

```
failed to load plugin target="...\.config\opencode\plugin\agy-bridge.ts"
PluginModule.LoadError: Plugin must export a default definition with an id and an
effect or setup function. (cause: SchemaError(Expected object at ["default"]))
```

The plugin exports a function as its default export: `export default (async () => {...}) satisfies Plugin`. The V2 loader expects an object instead, shaped as `{ id: string, setup(ctx) }` (`promise/plugin.d.ts`) or `{ id, effect(ctx) }` (`effect/plugin.d.ts`) **[V]**.

The docs are explicit: "V1 plugin implementations do not run in V2. Moving a file or renaming its config entry is not enough" **[V, migrate-v1]**. V2 does not take hooks as keys on a returned object. Each hook is registered on its owning domain (`ctx.session.hook(...)`, `ctx.event.subscribe(...)`, `ctx.provider.transform(...)`). Each registration returns a `Registration` with a `dispose()` method (`promise/registration.d.ts`) **[V]**.

V2 also loads plugins inside the background server (`opencode service`, described as "Manage the background server"). Every plugin-load line in the log carries `role=serve` **[V]**. This has three consequences **[A, inferred]**:

- The watchdog now lives as long as the service, not the TUI.
- `process.pid` and `process.env` are the service's own values.
- `console.error` output goes to the server log, not to your terminal.

## 2. V1 to V2 mapping for this plugin

| V1 construct used by agy-bridge | V2 equivalent | Source |
|---|---|---|
| `import type { Plugin } from "@opencode-ai/plugin"` | `import { Plugin } from "@opencode/plugin"` (`Plugin.define` is an identity helper) | `promise/index.d.ts`, `promise/plugin.d.ts` **[V]** |
| `export default async () => ({...hooks})` | `export default { id: "agy-bridge", setup(ctx) { ...; return cleanup } }` | `promise/plugin.d.ts` (`Plugin`, `Cleanup`) **[V]** |
| Factory body (log dir, initial `ensureDaemon`, `setInterval`) | The body of `setup(ctx)` | migrate-v1 ("`setup` runs when the plugin loads") **[V]** |
| `timer.unref()`, with no disposal | Same `unref()`, plus `clearInterval` in the cleanup function that `setup` returns | migrate-v1 ("Use the cleanup function for timers, subprocesses...") **[V]** |
| `config: (cfg) => { cfg.provider["agy-bridge"] = ... }` | No generic config domain exists: `Context` has no `config` field. Use `ctx.provider.transform(editor => ...)` and `ctx.model.transform(...)` | `promise/plugin.d.ts`, `promise/provider.d.ts`, `promise/model.d.ts` **[V]** |
| `event: async ({ event }) => ...` | `for await (const ev of ctx.event.subscribe({ signal }))` | `promise/event.d.ts`, client `shared-events.d.ts` **[V]** |
| `session.created` / `session.updated` with `event.properties.info.{id,parentID}` | `session.created` with `ev.data.{sessionID,parentID}`. V2 has no `session.updated` event | `generated/types.d.ts` (`SessionCreated`, `V2Event` union) **[V]** |
| `session.deleted` with `properties.info.id` | `session.deleted` with `ev.data.sessionID` | `generated/types.d.ts` (`SessionDeleted`) **[V]** |
| `"chat.headers": (input, output) => output.headers[...]` | `ctx.session.hook("model.request", e => e.headers[...], { providerID: "agy-bridge" })` | migrate-v1 table; `promise/session.d.ts` (`SessionModelRequest`), `registration.d.ts` (`ModelHookOptions.providerID`) **[V]** |
| `input.sessionID`, `input.agent` | `e.sessionID`, `e.agent` (both readonly) | `SessionModelRequest` **[V]** |
| The three-way `isAgy` provider check | Replaced by the hook's `{ providerID }` scope | `ModelHookOptions` **[V]** |
| `input.message.id` (source of `x-agy-message-id`) | **Not available** on `model.request` or `http.request`. See section 4 | `promise/session.d.ts` **[V: absent]** |
| `console.error` logging | `console.*`. The V2 docs show no dedicated log API | migrate-v1 and the plugins guide use `console.log` **[V]** |

## 3. Step-by-step port

**Step 1: Hoist the state.** Move `ensureDaemon` and `logPath` out of the V1 factory so both entrypoints can share them. Add a `disposed` flag so that a watchdog tick firing during unload cannot respawn the daemon. Keep all existing helpers unchanged: `loadOrCreateToken`, `healthInfo`, `spawnDaemon`, `expectedBuildId`, and the HMAC proof.

**Step 2: Declare a structural context type.** Do not import `@opencode/plugin` as a runtime value. A V1 host may not be able to resolve it, which is why `engram.ts` declares its V2 types structurally **[V, engram.ts:1030]**.

```ts
type V2Registration = { dispose: () => Promise<void> }
type V2Context = {
  event: { subscribe(o?: { signal?: AbortSignal }): AsyncIterable<any> }
  session: {
    hook(name: string, cb: (e: any) => void | Promise<void>,
         o?: { providerID?: string }): Promise<V2Registration>
  }
  provider: { transform(cb: (editor: any) => void): Promise<V2Registration> }
}
```

**Step 3: Write `setupAgyBridgeV2`.** Register the hooks first, then start the daemon. This function must never throw, so startup can never fail because of it.

```ts
async function setupAgyBridgeV2(ctx: V2Context): Promise<() => Promise<void>> {
  const clientInstanceId = newClientInstanceId()
  const parentBySession = new Map<string, string>()
  const abort = new AbortController()
  const registrations: V2Registration[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let listening: Promise<void> = Promise.resolve()
  const cleanup = async () => {
    disposed = true
    if (timer) clearInterval(timer)            // watchdog cleanup on dispose
    abort.abort()                              // ends the event subscription
    await Promise.allSettled(registrations.map((r) => r.dispose()))
    await listening.catch(() => {})
  }
  try {
    registrations.push(await ctx.session.hook("model.request", (e) => {
      try {
        e.headers["x-agy-session-id"] = e.sessionID
        const parent = parentBySession.get(e.sessionID)
        if (parent) e.headers["x-agy-parent-session-id"] = parent
        if (e.agent) e.headers["x-agy-agent"] = e.agent
        e.headers["x-agy-client-instance"] = clientInstanceId
        e.headers["x-agy-protocol-version"] = AGY_PROTOCOL_VERSION
        if (daemonVerified && currentToken) e.headers[TOKEN_HEADER] = currentToken
      } catch { /* hook must never throw */ }
    }, { providerID: AGY_PROVIDER_ID }))
    listening = listenSessions(ctx, abort.signal, parentBySession)
    const logPath = bridgeLogPath()
    await ensureBridgeLogDir(logPath)
    await ensureDaemon(logPath)                // parity with V1; use `void` to avoid blocking load
    timer = setInterval(() => { if (!disposed) void ensureDaemon(logPath) }, WATCHDOG_INTERVAL_MS)
    timer.unref?.()
  } catch (error) {
    console.error("[agy-bridge] plugin init failed:", error) // swallow: never fail startup
  }
  return cleanup
}
```

Notes on this step:

- The V1 hook injected headers for every request that went to agy-bridge. `e.kind` now separates `"primary" | "compaction" | "title" | "generate"` requests **[V, `SessionRequestKind`]**. Keep injecting for all kinds to preserve V1 behavior, or filter by `kind` if you want different handling per kind.
- `await ensureDaemon()` can block for up to about 12 s while it spawns and polls the daemon. Whether that delays service readiness is unverified **[A]**.

**Step 4: Replace the `event` hook with a subscription loop.** The subscription stream can end, so reconnect with backoff, as engram does **[V, engram.ts `listening` loop]**.

```ts
async function listenSessions(ctx: V2Context, signal: AbortSignal, parents: Map<string, string>) {
  let retry = 1_000
  while (!signal.aborted) {
    try {
      for await (const ev of ctx.event.subscribe({ signal })) {
        if (ev?.type !== "server.connected") retry = 1_000
        const d = ev?.data
        if (ev?.type === "session.created" && typeof d?.parentID === "string" && d.parentID) {
          parents.set(d.sessionID, d.parentID)
        } else if (ev?.type === "session.deleted" && typeof d?.sessionID === "string") {
          parents.delete(d.sessionID)
          void postTombstone(d.sessionID)      // same fire-and-forget fetch as V1
        }
      }
    } catch { /* disconnected; retry below */ }
    if (signal.aborted) break
    await new Promise((r) => setTimeout(r, retry))
    retry = Math.min(retry * 2, 30_000)
  }
}
```

Two cautions about events:

- `session.forked` also carries a `parentID`, but that is the fork source, not a subagent parent. Do not map it to `x-agy-parent-session-id` **[A, inferred from the event name]**.
- Any session created before the subscription opens is missed. If parent linkage matters for those sessions, look it up lazily with `ctx.session.get({ sessionID })`, whose result type `SessionInfo` has `parentID?` **[V, types.d.ts]**. That breaks the old "no network in the header hook" rule, so wrap it in a short timeout if you add it **[A]**.

**Step 5: Register the provider (shipped).** V2 has no config hook. The plugin calls `ctx.provider.transform` and adds the provider/models when absent; a live run showed `editor.get("agy-bridge")` is **absent during setup**, because a config-defined provider is merged after plugin transforms. The transform therefore also owns the family model list, and `scripts/migrate-agy-models.mjs` removes the V1 per-effort entries from the config file (the source of truth) with a backup.

- `Provider.Info` needs `id`, `name`, `activation`, `package`; the shipped package is `@opencode/ai/providers/openai-compatible` (ESM subpath in 2.0.4), not the `aisdk:` config prefix.
- `Model.Info` needs `id`, `modelID`, `providerID`, `name`, `capabilities`, `variants`, `time`, `cost`, `status`, `enabled`, `limit`; explicit variants use `settings.reasoningEffort` **[V: `tests/pluginV2.test.ts` + live `/api/model`]**. The earlier "defaults undocumented" assumption is resolved by these fields.
- The transform is repeatable: it preserves user models/fields and only fills the variants this release owns; a user-defined variant wins.

**Step 6: Export.** Do not export anything else by name. Older V1 loaders call every named export as a plugin factory **[V, comments in engram.ts:1031 and opencode-warp.js:10; not stated in the docs]**.

```ts
export default { id: "agy-bridge", setup: setupAgyBridgeV2 }          // V2 only
```

## 4. Known gap: `x-agy-message-id`

> **Closed (verified live):** `ctx.session.hook("prompt", ...)` exposes a readonly
> `messageID` (`SessionPrompt` in `promise/session.d.ts`). The V2 plugin caches the
> latest user message id per session and injects it on `model.request`; the bridge
> log shows `msgId=...` on the primary and title requests.

The daemon reads `x-agy-message-id` (`src/server.ts:154`). V2 `model.request` itself
exposes only `sessionID`, `agent`, `model`, `kind`, `baseURL` and `headers`, with no
message ID **[V]**, so the id comes from the prompt hook cache.

## 5. Optional: one file for V1 and V2

The docs support a dual entrypoint: a V2 object that also carries a V1 `server()` function. V1 object entrypoints work in OpenCode 1.18.29 and later **[V, migrate-v1]**, and your previous V1 version was 1.19.1. `engram.ts` uses exactly this shape **[V, engram.ts:1224]**:

```ts
const AgyBridgeV1 = async () => { /* existing V1 factory body, returns the hooks object */ }
export default { id: "agy-bridge", server: AgyBridgeV1, setup: setupAgyBridgeV2 }
```

Each host calls only its own entrypoint: V1 calls `server()` and V2 calls `setup()` **[V, engram.ts comment]**. The module-level state (`currentToken`, `daemonVerified`) is therefore never shared between the two entrypoints within one process.

## 6. Config notes

- **Plugin list.** V2 uses `"plugins"` (plural). Its entries are strings or `{ "package": "./path", "options": {...} }` objects **[V, migrate-v1]**.
  - The installer removes `./plugin/agy-bridge.ts` from the root `plugin`/`plugins` arrays on V2 hosts, so the retired V1 entry does not produce a failed-load warning.
  - V2 discovers local plugins in both `plugin/` and `plugins/`, and `plugins/` is the recommended location **[V, docs for `.opencode/`]**.
  - The global `~/.config/opencode/plugins/` directory is auto-loaded too: `opencode-warp.js` loads from there with no config entry **[V, log]**.
  - Shipped: the copy is deployed to `~/.config/opencode/plugins/agy-bridge.ts`; the V1 copy is retired and the entry removed. Live `opencode plugin list` shows a single `agy-bridge` source.
- **Provider block.** The shipped plugin registers the provider through a transform with `package: "@opencode/ai/providers/openai-compatible"` and `settings.baseURL`. The installer migrates the old `provider.agy-bridge.models` entries; the V1 `provider`/`npm`/`options.baseURL` block is normalized by V2, and the model `limit` shape is accepted live **[V: `/api/model`, `tests/pluginV2.test.ts`]**.
- **Environment.** `AGY_BRIDGE_REPO`, `AGY_BRIDGE_PORT`, `AGY_BRIDGE_NODE` and `AGY_BRIDGE_HOME` must be visible to the background service. After you change any of them, restart the service **[A, follows from `role=serve`]**.

## 7. Verification

1. `opencode service restart`
2. `opencode plugin list`: `agy-bridge` must show its ID (not `-`) and the expected source path **[V: subcommand exists]**.
3. Search `~/.local/share/opencode/log/opencode.log` for `failed to load plugin`. There must be no new line for `agy-bridge.ts`.
4. `curl "http://127.0.0.1:41667/healthz?nonce=abc"` returns 200. Then kill the daemon process and confirm that it comes back within about 30 s (watchdog).
5. `opencode run -m agy-bridge/gemini-3.8-flash-low "Reply PONG"` returns `PONG`. Check `~/.agy-bridge/bridge.log` for the session-ID and token headers.
6. Run a subagent task. The bridge log should show `x-agy-parent-session-id`.
7. Delete a session and confirm that the tombstone POST reaches the daemon.
8. Edit the file to force a reload, or remove the plugin, and confirm that the watchdog stops: no "daemon started" lines after unload. This checks the cleanup path.
9. If you used the dual entrypoint, also load the file in V1 (1.19.x) and repeat steps 3 to 5.

After the port, update the README: it currently says the provider is registered "via the `config` hook".
