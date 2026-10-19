# agy-bridge

A local OpenAI-compatible bridge that lets **opencode** run its agents on the models
behind **Antigravity (`agy`)** — session-stable, warm-lane accelerated, and with the
official `agy` binary doing all the talking (the bridge never touches OAuth).

## How it fits together

```
opencode ──(plugin: agy-bridge.ts)──> local daemon (fastify, 127.0.0.1:41667) ──> official `agy` CLI
```

- The **plugin** keeps the daemon alive (watchdog every 30s, restarts on stale
  build) and injects `x-agy-*` identity headers. V1 hosts load
  `plugins/agy-bridge.ts`; V2 hosts load `plugins/agy-bridge-v2.ts` (deployed as
  `~/.config/opencode/plugins/agy-bridge.ts`). V2 has no `config` hook: the V2
  plugin registers the `agy-bridge` provider and its models through
  `ctx.provider.transform`, migrates the V1 per-effort ids, and preserves
  user-defined models/fields. The installer also removes the retired V1 plugin
  entry and legacy model entries from the config (with a backup).
- The **daemon** (`src/server.ts`) runs sessions stably with the official `agy`
  binary, serves the OpenAI API surface (`/v1/models`, `/v1/chat/completions`), and
  exposes one model per family (Gemini / Claude / GPT-OSS) with the reasoning level
  selected per request (`reasoning_effort`, or a legacy `-high/-medium/-low` alias).
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
new user MUST be authenticated with `agy` once from the app/CLI), opencode,
and Git — or a repo ZIP from the GitHub Releases page instead of Git.

1. **Recommended (pinned release, verified)** — needs Git installed and Node 24+.
   1. Download `install.ps1` from the latest release on the
      [Releases](https://github.com/JFPosada2005/agy-bridge/releases) page and compare
      its hash with the SHA256 published in the release notes:
      `Get-FileHash .\install.ps1 -Algorithm SHA256`
   2. Read it, then run:
      `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Ref v0.2.0`
   The script clones that tag to `%LOCALAPPDATA%\agy-bridge`, builds it (`npm ci`),
   detects the OpenCode major version, deploys the right plugin, registers
   `AGY_BRIDGE_REPO` and `AGY_BRIDGE_NODE`, checks for the Antigravity (`agy`) CLI,
   and prints next steps. On OpenCode V2 it also retires the V1 plugin copy and
   migrates the config's legacy per-effort model entries (backup:
   `opencode.json.agy-bridge.bak`).
   One-liner alternative (runs remote code you have not read; keep the tag pinned
   in the URL):
   `powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/JFPosada2005/agy-bridge/v0.2.0/scripts/install.ps1 | iex"`
2. **ZIP (no Git needed)** — download the repo ZIP from the Releases page
   (or Code > Download ZIP), extract it anywhere, then from inside the folder
   run: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`
   The script detects the in-repo mode and uses the local folder directly
   (no git operations).
3. **Manual (experts)**:
   1. Clone this repo somewhere stable (canonical spot:
      `%LOCALAPPDATA%\agy-bridge`).
   2. Build once: run `npm ci`, then `npm run build` (two separate
      commands; PowerShell 5.1 does not support `&&`).
   3. Copy the plugin for your OpenCode major version:
      - **opencode 2.x**: `plugins/agy-bridge-v2.ts` ->
        `~/.config/opencode/plugins/agy-bridge.ts`, and remove the old
        `~/.config/opencode/plugin/agy-bridge.ts` if present.
      - **opencode 1.x**: `plugins/agy-bridge.ts` ->
        `~/.config/opencode/plugin/agy-bridge.ts`.
      The plugin locates the repo via `AGY_BRIDGE_REPO` env, or falls back to
      `%LOCALAPPDATA%\agy-bridge`.
   4. Restart opencode. The watchdog starts the daemon; `GET /healthz`
      answers `{"status":"ok","buildId":...,"pid":...,"inflight":...}` when
      healthy (the `agy` status block is only returned with the token).

Note: the plugin spawns Node from `C:\Program Files\nodejs\node.exe` by default;
on machines with a different install location set `AGY_BRIDGE_NODE` to that
node.exe path (the installer does this for you).

## Models and reasoning variants (OpenCode V2)

V2 exposes **one model per family**; the reasoning level is selected as a model
variant (`provider/model#variant`), not as a separate model id:

| Model id | Variants |
| --- | --- |
| `agy-bridge/gemini-3.8-flash` (also `3.7`, `3.6`) | `low`, `medium`, `high` |
| `agy-bridge/gemini-3.1-pro` | `low`, `high` |
| `agy-bridge/claude-sonnet-4-6`, `claude-opus-4-6-thinking` | none (thinking is inherent) |
| `agy-bridge/gpt-oss-120b` | default `medium` |

```powershell
opencode run -m agy-bridge/gemini-3.8-flash#high "Review this migration"
opencode run -m agy-bridge/gemini-3.1-pro#low "Summarize the diff"
```

The selected level travels as the OpenAI `reasoning_effort` field and is
translated to `agy --effort`. An unsupported level is rejected with 400
`invalid_reasoning_effort`. Changing the variant mid-session recycles the warm
`agy` process with the same conversation, so the new level actually takes effect.

V1's per-effort ids (`gemini-3.8-flash-low`, ...) remain accepted by the daemon
as aliases so existing V1 configs keep working, but they are hidden from the V2
catalog. The installer migrates old config entries to the family surface and
keeps a backup next to the config.

## Security model

The daemon only listens on 127.0.0.1, but loopback is reachable by every local
program and, through DNS rebinding, by web pages. So:

- **Install token**: `%USERPROFILE%\.agy-bridge\token` (created on first run and
  shared with the plugin). Every route except `GET /healthz` requires it in the
  `x-agy-token` header (or `Authorization: Bearer`). The plugin adds it
  automatically; your own scripts read it from that file (see `scripts/smoke.mjs`).
  Never share or commit this file.
- **Host/Origin checks**: requests must target `127.0.0.1` or `localhost`; browser
  requests from any other origin get 403.
- **Daemon identity**: before trusting the pid in `/healthz` or sending the token,
  the plugin asks for an HMAC proof over a fresh nonce, so another program holding
  the port is never killed nor handed your token.
- **Session ids** must be opaque (`[A-Za-z0-9_-]{1,128}`); anything path-like is
  rejected before touching the session store.
- **Debug routes** (`/v1/__debug/*`) are off unless `AGY_BRIDGE_DEBUG=1`.
- **agy environment**: variables whose name contains `API_KEY`, `TOKEN`, `SECRET`,
  `PASSWORD`, `CREDENTIALS`, `ACCESS_KEY` or `PRIVATE_KEY` as an `_`-separated word
  (e.g. `OPENAI_API_KEY`, `GITHUB_TOKEN`) are not passed to agy; keep specific ones
  with `AGY_ENV_PASSTHROUGH=NAME1,NAME2`.
- Request bodies up to 32 MiB (`AGY_BRIDGE_BODY_LIMIT_MB` overrides).

Upgrading from a version without the token: the installer stops the old daemon
for you (after checking it is your own `node dist/index.js` process), then restart
opencode. If it reports that it could not, stop it once yourself (the new plugin
refuses to kill a daemon that cannot prove its identity):
`Stop-Process -Id (Invoke-RestMethod http://127.0.0.1:41667/healthz).pid`

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Disclaimer

Not affiliated with or endorsed by Google. "Antigravity" and "Gemini" are
trademarks of Google LLC. The bridge drives the official `agy` CLI with your own
plan; automated or third-party use may conflict with the Antigravity terms of
service. Review them and use at your own risk.

## Telemetry & diagnostics (report these when something breaks)

Everything the daemon does per request lands in one append-only file:

| Case | Log location |
| --- | --- |
| Daemon spawned by the opencode plugin | `%USERPROFILE%\.agy-bridge\bridge.log` (the plugin always sets this target) |
| Daemon started manually (no env) | `%USERPROFILE%\.agy-bridge\bridge.log` (same built-in default) |
| Custom override — manual starts only | set `AGY_BRIDGE_LOG=/path/to/bridge.log` before launching the daemon |

Every line is `|`-separated single-line JSON-friendly text: timestamp, method, path,
status, `sessionId=`, `agent=`, `msgId=`, the selected `effort=`, token usage
(`prompt=/completion=/total=/cached=`), and what the underlying `agy` received
(`model=`, `tools=N`).
Session records live under `%USERPROFILE%\.agy-bridge\sessions\` and agy workspaces
under `%USERPROFILE%\.agy-bridge\workspace\`.

Extra diagnostics:

- `GET /healthz` — liveness, pid, `buildId`, inflight turns (agy status with the token).
- `GET /v1/__debug/stats` — warm-lane state, session-mode details
  (needs `AGY_BRIDGE_DEBUG=1` and the token).
- `GET /v1/__debug/echo` — echoes the injected `x-agy-*` headers (handy for the
  plugin header chain; same requirements, never echoes the token).

When filing a bug: attach the last ~20 lines of `bridge.log` around the failing
request plus your opencode version and the agent that issued the request. Redact
session/workspace paths if you prefer; the log contains request identity and
token counts, not message contents. Do not attach session records
(`sessions\*.json` keep the last assistant reply for retry idempotency) and never
attach the `token` file.
