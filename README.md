# agy-bridge

A local OpenAI-compatible bridge that lets **opencode** run its agents on the models
behind **Antigravity (`agy`)** — session-stable, warm-lane accelerated, and with the
official `agy` binary doing all the talking (the bridge never touches OAuth).

## How it fits together

```
opencode ──(plugin: agy-bridge.ts)──> local daemon (fastify, 127.0.0.1:41667) ──> official `agy` CLI
```

- The **plugin** (`plugins/agy-bridge.ts`, auto-discovered from the opencode plugin
  dir) keeps the daemon alive (watchdog every 30s, restarts on stale build), injects
  `x-agy-*` identity headers, and registers the `agy-bridge` provider + its models
  portably via the `config` hook — the user's own config always wins.
- The **daemon** (`src/server.ts`) runs sessions stably with the official `agy`
  binary, serves the OpenAI API surface (`/v1/models`, `/v1/chat/completions`), and
  exposes a model surface of Gemini / Claude / GPT-OSS ids delegated by `agy`.
- **Warm lanes**: the daemon keeps one warm `agy` conversation per active
  session (overall cap `AGY_MAX_WARM_LANES`, default 8 across all sessions);
  subsequent turns with the same session identity re-warm instead of paying a
  full boot (opt-out with `AGY_WARM_LANE=0`).
- **Delegation boundary**: the daemon filters the `task` tool out of agy turns and
  the per-turn protocol reminder forbids subagent spawning — agy does the work
  itself. Imported never imposes: agents/config in opencode remain yours.

## Install

Prerequisites: Node.js 24+ (the daemon's `engines.node` requires it), the
Antigravity desktop app installed and signed in (its plan provides the models; a
new user MUST be authenticated with `agy` once from the app/CLI), and opencode.

1. Clone this repo somewhere stable (canonical spot: `%LOCALAPPDATA%\agy-bridge`)
   and build once: `npm install` then `npm run build` (run the two commands
   separately; PowerShell 5.1 does not support `&&`).
2. Copy `plugins/agy-bridge.ts` into `~/.config/opencode/plugin/` (the plugin
   locates the repo via `AGY_BRIDGE_REPO` env, or falls back to
   `%LOCALAPPDATA%\agy-bridge`).
3. Restart opencode. The watchdog starts the daemon; `GET /healthz` answers
   `{"status":"ok","agy":...,"buildId":...,"pid":...,"inflight":...}` when healthy.

Note: the plugin spawns Node from `C:\Program Files\nodejs\node.exe` by default;
on machines with a different install location set `AGY_BRIDGE_NODE` to that
node.exe path.

## Telemetry & diagnostics (report these when something breaks)

Everything the daemon does per request lands in one append-only file:

| Case | Log location |
| --- | --- |
| Daemon spawned by the opencode plugin | `%USERPROFILE%\.agy-bridge\bridge.log` (the plugin always sets this target) |
| Daemon started manually (no env) | `%USERPROFILE%\.agy-bridge\bridge.log` (same built-in default) |
| Custom override — manual starts only | set `AGY_BRIDGE_LOG=/path/to/bridge.log` before launching the daemon |

Every line is `|`-separated single-line JSON-friendly text: timestamp, method, path,
status, `sessionId=`, `agent=`, `msgId=`, token usage (`prompt=/completion=/
total=/cached=`), and what the underlying `agy` received (`model=`, `tools=N`).
Session records live under `%USERPROFILE%\.agy-bridge\sessions\` and agy workspaces
under `%USERPROFILE%\.agy-bridge\workspace\`.

Extra diagnostics:

- `GET /healthz` — liveness, pid, `buildId`, inflight turns.
- `GET /v1/__debug/stats` — warm-lane state, session-mode details.
- `GET /v1/__debug/echo` — echoes the injected `x-agy-*` headers (handy for the
  plugin header chain).

When filing a bug: attach the last ~20 lines of `bridge.log` around the failing
request plus your opencode version and the agent that issued the request. Redact
session/workspace paths if you prefer; the log contains request identity and
token counts, not message contents.
