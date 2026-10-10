# Slice 3 Design: agy↔opencode Session Ecosystem

Assembled by the parent architect from a rescued opus-5-5/xhigh design run
(30 reasoning parts, ~70KB, session `ses_ee338b4f9ffeXGzONJF7HryyO6`, terminated by
an output-budget crash; raw material: `design/raw-thinking-opus.txt`). Two relaunch
attempts failed on provider content-filter blocks; nothing was lost thanks to mining.

## §1 Executive Summary

The bridge becomes a **session ecosystem**: opencode sessions map 1:1 onto registry
records keyed by the opencode `sessionID` (delivered via a plugin-injected
`chat.headers` channel), each holding a small set of **branches** — agy
conversations with a **ledger of canonical message digests** marking exactly what
agy already knows. Every opencode request is matched by **longest-prefix ledger
diff**: only the delta (new messages since the ledger head) travels to agy, so
post-bootstrap turns are mostly **cache_read_tokens** (cheap) instead of today's
full re-billing, and single messages stay small (truncation-safe). Compaction,
revert, fork, retries, daemon crashes and dirty agy turns are all handled as
**new branch / epoch / repair** transitions rather than data loss. Subagents are
keyed by their own child sessionID. ToS invariant preserved (spawn official agy,
never touch OAuth), single-writer=opencode preserved, every fallback loud.

## §2 Research Findings (evidence-cited)

### opencode conversation lifecycle
- **Storage**: SQLite `~/.local/share/opencode/opencode.db`. `session(id PK,
  parent_id, slug, title, revert JSON, cost, tokens_input/output/reasoning, …)`;
  `message(id PK, session_id, data JSON: role, agent, modelID, providerID,
  tokens, finish, time_*)`; `part(id PK, message_id, data JSON: type text/tool/
  step-start/step-finish/reasoning/compaction/patch…)`. Event-sourced log:
  `event(aggregate_id, seq, type)` — title generation observed at seq 11 of a
  session; the session/message tables are projections. **New v2 tables
  (`session_context_epoch`, `session_message`, `session_input`) exist but are
  EMPTY in v1.18.35** → do not depend on them; hints of future native
  context-epoch tracking (reinforces hook-only design).
- **Resumption is stateless by construction**: every LLM call rebuilds the full
  message array from the DB since the last compaction boundary and resends it
  (`filterCompacted` walks back to the compaction summary + `tail_start_id`).
  This growing prefix is the bridge's recovery substrate — never strip it
  (`experimental.chat.messages.transform` could shrink it but lacks sessionID and
  breaks rebootstrap; rejected).
- **Subagents**: child sessions with `parent_id`, each with a single task-prompt
  user message; the `task` tool stores child sessionId in its metadata.
  Subagent resume-via-`task_id` exists [VERIFY: doc evidence].
- **Hidden agents**: `compaction`, `title`, `summary` run through the same LLM
  streaming path → they also fire `chat.headers` with the same sessionID; the
  `agent` field disambiguates. `small_model` unset → falls back per provider.
- **Retries visible in DB**: multiple `step-start` parts, zero tokens, inside one
  assistant message (AI SDK maxRetries=2 on 5xx/429).
- **Revert/undo**: `session.revert` JSON `{messageID, partID, snapshot, diff}`;
  revert truncates future history; fork creates a new session copying history.
- **Compaction**: user message carries `compaction` part with `tail_start_id` +
  a dedicated summary assistant message. Optional pruning can replace old tool
  outputs with placeholders (`compaction.prune`).

### agy conversation mechanics (v1.3.1, read-only evidence + probes)
- Per-conversation SQLite under `~/.gemini/antigravity-cli/brain/<uuid>/…`
  (`transcript.jsonl`, `transcript_full.jsonl`, per-conversation DB) + global
  `conversation_summaries` index (titles, status flags like
  `not_fully_idle`/`killed`, `parent_conversation_id`, `nesting_depth`,
  **`workspace_uris` bound to the spawn cwd**).
- All 20 of today's bridge conversations contain exactly ONE `USER_INPUT` step
  → confirmed stateless pattern.
- **Cache is conversation-scoped**: identical prompt in a different conversation
  → zero cache hits; repeated calls within one conversation → large cache hits
  (~97% cache-read on steady state). `usage.cache_read_tokens` is output in
  stream-json; the bridge today drops it (`toOpenAIUsage` ignores it) — opencode
  shows zero cached tokens while caching actually happens.
- **Silent truncation** of oversized stdin prompts (accepts ~30–50K tokens of the
  sent payload in measurements, TAIL lost → model answers to nothing; numbers
  don't fit a fixed cap — treat as opaque, design defensively).
- `--input-format stream-json`: one NDJSON message per line, one turn per
  message, single persistent process. `--conversation <id>` resume-by-id;
  **`--continue` is FORBIDDEN** (resumes globally most recent conversation —
  could hijack the user's own interactive agy session).
- agy's model tried `run_command("dir")` mid-chat → its internal tools remain a
  risk in headless (Mode A single-writer discipline still needed).

## §3 Core Architecture

### Identity channel (dual: explicit identity + content diff)
Plugin (`agy-bridge.ts`) injects headers ONLY for provider `agy-bridge`:
`x-agy-session-id`, `x-agy-agent` (agent name; distinguishes title/summary/
compaction ephemeral calls), `x-agy-message-id` (turn anchor; idempotency),
`x-agy-parent-session-id`, `x-agy-client-instance`, `x-agy-protocol-version`.
`chat.headers` must stay fast (no network calls; plugin caches parent ids from
`session.created/updated` events). Bridge-side optional shared-secret token as
hardening (localhost spoofing is out-of-trust-scope but reduceable).
**Safety invariant**: no headers OR ephemeral agent ⇒ stateless fallback path
(today's behavior). Only headered + conversational turns enter session mode.
Pure fingerprint matching is rejected (colliding prefixes across sessions/forks/
subagents, daily-changing system prompt dates).

### Session state model
```
SessionRecord {
  sessionID, parentSessionID?, createdAt/updatedAt, activeBranchID,
  branches[≤4, LRU-tombstoned]: {
    branchID, agyConversationID, agyVersion, modelFamily, effort, epoch,
    origin: (initial|compaction|revert|fork|dirty-repair|family-switch),
    ledger: [ordered canonical message digests — confirmed delivered to agy],
    provisional?: {deltaDigest, responseSketch}  // in-flight turn not yet confirmed
    lastResponse?: string   // for replay-on-retry idempotency
  }, inflightMarkers: [{bootId, branchID, deltaDigest, pid, startedAt}]
}
```
- **Storage**: bridge-owned `~/.agy-bridge/sessions/<sessionID>.json`, atomic
  rename writes, per-session mutex. (Bridge-internal state ≠ workspace; the
  single-writer invariant covers the repo.) Corrupted file → quarantine + fresh
  bootstrap, loud log. Disk full → stateless fallback, loud.
- **Canonical digests**: strip `<system-reminder>…</system-reminder>` blocks and
  volatile date/env lines; normalize whitespace/trim; pruned tool outputs match
  wildcard (`compaction.prune` tolerance); tool_calls digest = name+canonical
  args JSON; assistant echoes tolerated via normalization. Divergence telemetry:
  mismatch index + structural diff (roles/lengths, no content), logged on every
  rebootstrap to discover new wrapper patterns over time.
- **Delta rule**: incoming message canon = longest branch whose ledger is a
  strict prefix → send ONLY messages after the ledger head (+ system-prompt
  semantic diff since last turn as a `[context refresh]` block when material:
  build↔plan agent switch, AGENTS.md edits — no full re-billing). No prefix fit
  → bootstrap a fresh branch (full history, one bootstrap turn), tombstone old.
- **Bootstrap payload**: identical to today's flattened transcript (protocol +
  system + manifest + history). Persist `conversation_id` captured from the
  `init` event into the registry BEFORE the turn completes (crash mid-bootstrap
  must not orphan the mapping).
- **Oversized bootstrap**: **chunked bootstrap default-ON** — history fed as
  sequential inputs "context part i/n — reply only ACK" each under the verified
  safe per-message budget, then the real turn. Correctness over a few extra
  plan requests; middle-drop trim stays as the last-resort guard.
- **Process model — Option A (primary)**: spawn-per-turn with
  `--conversation <id>` resume-by-id; reuses today's proven spawn/kill/timeout/
  abort machinery; crash-safe; per-turn model/effort variation possible
  [VERIFY]. Known cost: cold spawn re-inits MCP configs (~25s measured).
  **Option B (phase 3 accelerator)**: persistent `--input-format stream-json`
  process per hot session (warm lane, low latency); gated on experiment E2
  result (does cache survive process restarts?); falls back to A on anomaly.
- **init mismatch detection**: `--conversation` resumes but the `init` event's
  `conversation_id` don't match the registry → KILL before any model output,
  bootstrap fallback. An undetected mismatch = contextless wrong answer.
- **Dirty states** (user_input accepted by agy but turn aborted/killed/timed
  out): next request on that branch gets a repair note ("disregard any partial
  prior attempt") + delta resend; catastrophic corruption → fork a fresh branch.
- **Retries**: ledger advances only on confirmed success; provisional tail holds
  the finished-but-unconfirmed response; retry with same delta → replay stored
  response (no second agy spawn); modified retry → dirty path.
- **Quota failures**: 429 + explicit code (non-retryable — today's 502 lets the
  SDK burn 2 extra spawns), loud message.
- **Concurrency**: per-session mutex (two windows on one session queue up);
  global semaphore caps concurrent agy processes; subagents = separate child
  sessions ⇒ separate conversations, no interleaving; agy's own nesting/
  subagents stay disabled in Mode A.
- **usage accounting**: `prompt_tokens = input_tokens + cache_read_tokens` for
  opencode context-overflow math; expose cached tokens as chat chunk usage so
  providers display cache reality [VERIFY].

### Plugin event surface
- `session.created/updated`: cache parent linkage + titles (fast, in-memory).
- `session.deleted`: tombstone bridge mapping (grace period; ledger authority
  revives on next prefix match; mark agy conversation GC-eligible — never touch
  agy's own store directly).
- compaction/revert events: epoch/branch hints (hints only; the request diff
  remains the source of truth).
- Daemon lifecycle + watchdog unchanged; `/healthz` gains build-id +
  registry-version for stale-daemon detection (plugin restarts on mismatch
  [known risk: kills other instances' in-flight turns]).

### Workspace isolation
Bridge conversations get a dedicated neutral workspace directory for agy spawns
(persisted per conversation at creation; resume reuses it) instead of polluting
the repo directory — also reduces agy's temptation to invoke its internal tools
on bridge cwd [open decision ③-adjacent].

## §4 Use-Case Matrix (numbered; trigger → behavior → mechanism)

| # | Trigger | Required behavior | Mechanism |
|---|---------|-------------------|-----------|
| 1 | New session, first agy turn | Bootstrap = today's flatten; registry + conv-id persisted atomically | Option A spawn, init capture |
| 2 | Normal follow-up turn | Delta-only (new user msg) + cached prefix | ledger longest-prefix |
| 3 | Tool-call follow-up | Same branch; result as named TOOL_RESULT + protocol reminder; provisional digest confirmed on echo | provisional tail |
| 4 | User rejected a tool permission | Turn continues; result rendered as denial note in delta | same as 3 with denial content |
| 5 | Hallucinated/unlisted tool call | Streams as plain text (v1 rule) — appears in history; digest normal | marker allowlist |
| 6 | max-steps/no-tools turn (system prompt sans tools) | Context-refresh block notes tools unavailable | system semantic diff |
| 7 | Title/summary/compaction hidden agents | Ephemeral, stateless, never touch branch ledger | agent header routing |
| 8 | Title-gen quota | Recommended non-bridge `small_model`; if bridged, stateless | config guidance |
| 9 | Auto-compaction (overflow) | Summary computed INSIDE old conversation (cache leverage); new epoch bootstrapped compacted | compaction path |
| 10 | Manual compaction | Same as 9 (explicit shrink intent) | epoch bump |
| 11 | Pruned tool outputs (compaction.prune) | Wildcard digest tolerance → NO rebootstrap | canonicalizer |
| 12 | Revert/undo | New branch from truncated prefix bootstrap; old branch kept for unververt lineage | branch selection |
| 13 | Fork | New opencode session ⇒ own registry record; rebootstrap (agy cannot fork conversations) | per-session isolation |
| 14 | Message rewind/edit (prefix shortened) | Same as 12 | branch selection |
| 15 | `<system-reminder>` transient injections | Stripped from digests — no false divergence | canonicalizer |
| 16 | System date/env rollover, AGENTS.md edit | `[context refresh]` block in next delta, no rebootstrap | system diff |
| 17 | Agent switch build↔plan in-session | Context-refresh block (material change) | system diff |
| 18 | Model family switch gemini→claude-via-agy (=non-branch) → back | New branch per family; foreign turns flow as delta when returning | branch filter |
| 19 | Same-family model/effort switch | Per-turn param (model id same base; effort-only change safe) | option A spawn args [VERIFY] |
| 20 | Session closed days, reopened | Registry reloaded lazily; `--conversation id` resume; cache cold per TTL (like any provider), flow identical | resume-by-id |
| 21 | Daemon crash mid-turn | bootId-tagged inflight marker; orphan pid killed (image-name+start-time verification); branch dirty | recovery sweep |
| 22 | Daemon killed between turns | Registry survives (disk); orphan agy processes killed | same |
| 23 | agy process dies mid-response | Dirty branch → repair note or fork | dirty classifier |
| 24 | Network outage mid-turn | ibid 23; 502 verbatim | AgyExitError |
| 25 | User Esc mid-turn | Socket close → agy killed (existing); branch dirty if submitted | existing + dirty |
| 26 | Socket dropped after bridge completed response | Retry replays stored response (idempotency), no spawn | provisional replay |
| 27 | SDK retry storm on dirty 5xx | 429 for quota; toasted status code discipline elsewhere | status mapping |
| 28 | Two windows, same session concurrently | Per-session mutex serializes; stale-prefix requester re-diffs → branch if needed | mutex |
| 29 | N parallel subagents (non-agy orchestrator) | Each sessionID separate; FIFO semaphore; no deadlock (1 tool call per turn limits agy parent parallelism) | isolation + semaphore |
| 30 | Subagent re-invoked with task_id | Same child sessionID ⇒ same branch, cache warm | identity + registry |
| 31 | User navigates INTO child session and chats | Continues child conversation directly | sessionID routing (> caller identity) |
| 32 | agy internal tool attempt in headless | Denied by agy; denied_actions → repair note in next delta (no empty reply) | denied pipeline |
| 33 | Budget: oversized single message (e.g. huge file read delta) | Chunked bootstrap/inputs default-ON; middle-drop last resort | chunking |
| 34 | agy binary auto-upgrade breaks resume | Fresh branch + loud warning (agy version stored per branch) | version gate |
| 35 | Registry file corrupted | Quarantine + fresh bootstrap, loud | storage guard |
| 36 | Export/share (disabled globally) | No bridge impact | no-op |
| 37 | Session import (same sessionID cross-machine) | Registry absent → bootstrap fresh; tombstone grace revives via ledger authority | lazy load |
| 38 | Stale daemon serving old code | `/healthz` build-id handshake → plugin restarts daemon | existing+buildid |
| 39 | Images/files in messages | Out of scope v1 (flatten text-only) — digests include, rendering skips | scope note |
| 40 | Expired agy auth mid-session | Clean if unsubmitted; verbatim 502 re-login guidance | existing + ledger rules |

## §5 Migration Path

- **Phase 0 (zero behavior change)**: plugin header injection (aggy-bridge provider
  only) + cache_read_tokens in usage mapping + bridge logging/echo checks
  (headers arrival, digest echo fidelity via passive logs). up to date: no risk.
- **Phase 1 (session mode behind env flag, default OFF)**: registry + SessionManager
  + Option A resume-by-id + delta detection + chunked bootstrap; bootstrap cost
  identical to today for first turns. In-flight legacy sessions: no registry
  record → bootstrap once on next turn → enter session mode. Rollback = flag off
  (stale daemons ignore headers; opencode unaffected).
- **Phase 2 (hardening)**: orphan-pid reconcile sweep, GC of tombstoned agy
  conversations, telemetry dashboards? (log files), daemon restart UX (toast via
  plugin polling), compaction-in-session summary.
- **Phase 3 (accelerator)**: warm persistent stream-json lane behind flag,
  LRU idle eviction (~10 min), only after E2 confirms cross-process/within-process
  cache semantics. Fallback to A on anomaly.
- **GA gate**: live verification experiments pass + user acceptance.

## §6 Risks and [VERIFY EXPERIMENTS] (~10 plan requests total)

| ID | Experiment | Decides | Cost |
|----|-----------|---------|------|
| E1 | Header arrival + agent field at bridge (debug echo route or log) | identity channel viability | ≤1 |
| E2 | `--conversation <id>` + text stdin resume: cache continuity ACROSS process restarts | Option A vs B priority | 2 |
| E3 | stream-json NDJSON input schema for persistent session | Option B lane | 2 (skip if no B) |
| E4 | Model/effort switch on resume same branch | family/effort rules | 1 |
| E5 | Killed-conversation resume (`not_fully_idle`/`killed` flags) | dirty recovery | 1 |
| E6 | Per-message truncation limit INSIDE an existing conversation | chunk sizing | 2 |
| E7 | Workspace-scope: resume from different cwd (dedicated workspace dir) | spawn cwd policy | 1 |
| E8 | Unknown/deleted conversation id error shape | loud fallback path | 1 (free-ish) |
| E9 | Echo fidelity via passive logs (free) | canonicalizer tuning | 0 |
| E10 | git: SSE ping keeps opencode chunkTimeout alive during queued turns | queue UX | 0-1 |

## §7 Open decisions (for user)

1. **Process model default**: Option A (resume-by-id spawn per turn; ~25s cold
   spawn cost per turn until Phase 3) vs Option B now (persistent processes,
   memory-heavy). **Recommendation: A first, B as phase-3 accelerator gated on
   E2/E3.**
2. **Compaction strategy**: summarize-inside-old-session (cache leverage) vs
   plugin re-sends stateless. **Recommendation: inside-session summary then new
   epoch bootstrap.**
3. **Workspace isolation for bridge conversations**: dedicated neutral dir (clean
   agy history + less tool temptation) vs repo cwd (today, treats agy cwd as
   context surface). **Recommendation: dedicated dir per conversation.**
4. **Persistence substrate**: per-session atomic JSON (recommended) vs single
   SQLite — settled by research; only re-open if atomicity proves brittle.

## Appendix: materials
- Experiment drivers live in `scripts/experiments/`; their raw captures and the
  internal work notes are kept out of the public repo (local machine paths,
  conversation ids and tool inventories).
