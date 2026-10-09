# Feature: agy-bridge

## Objective
Let opencode (global, all projects) list and use models backed by the user's Google AI Pro plan
via the official Antigravity CLI binary (`agy`), exposed as a first-class local provider
(OpenAI-compatible bridge). No SDD ceremony (user opted out 2026-10-08); organic delivery.

## Problem
Gemini CLI is EOL for AI Pro plans (2026-06-18). `agy` v1.3.1 is the only consumer path.
opencode must see agy models natively (model picker, any agent role), with agy invoked only
through its official documented flags — never touching OAuth tokens.

## Scope (v1)
- Bridge daemon (Node 24 + TypeScript): GET /v1/models, POST /v1/chat/completions
  (stream SSE + non-stream), health endpoint. Binds 127.0.0.1 only.
- agy adapter: spawn `agy -p --output-format stream-json --model <id> [--effort <e>]`,
  parse NDJSON (init / step_update / result: text_delta, tool_info, usage w/ thinking_tokens).
- Tool-calling (AMENDED 2026-10-08, supersedes decision d "text-only"): bridge relays
  opencode's per-request tool schemas so gemini (or any wired model) answers text OR
  structured tool_calls; opencode executes tools with its own permission layer.
- Separation of powers (APPROVED 2026-10-08): Mode A (headless via bridge) runs agy with its
  own mutating tools disabled — single writer = opencode. agy's own agentic tools are used
  only in Mode B (supervised visible terminal, user approves everything).
- Model catalog: gemini-3.8/3.7/3.6-flash-{high,medium,low}, gemini-3.1-pro-{high,low},
  claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium.
- Global opencode.json provider registration (@ai-sdk/openai-compatible, localhost baseURL)
  + local opencode plugin that manages the daemon lifecycle (spawn/health/dispose).
- Mode B supervised terminal: later slice.
- Tool-calling mapping: slice 2 (after text pipeline verified end-to-end).

## Hard constraints
- NEVER read/handle OAuth tokens or reimplement Google auth. Spawn official agy only.
- Server binds 127.0.0.1; no external exposure.
- Write config files BOM-less UTF-8 (PS 5.1 BOM breaks agy parsers).
- All fallbacks must work on a clean agy install (no gentle-ai/engram implied).

## Tasks
- [x] T1 Repo scaffold: git init, .gitignore (node_modules/dist), package.json (Node 24),
      tsconfig strict, zero-magic dev deps (typescript, vitest). — inline (mechanical)
- [x] T2 agy adapter — done (gentle-ai-worker): src/agy.ts; corrected via REAL binary: `-p` takes prompt as flag value (argv), stream-json nests payloads under kind keys. 35/35 vitest green.
- [x] T3 OpenAI-compatible server — done: src/server.ts fastify 127.0.0.1:41667, SSE + non-stream, 503/502 verbatim mapping, semaphore cap 3.
- [x] T4 Catalog — done: src/catalog.ts, 14 models, effort suffix→--effort.
- [x] T5 Acceptance (bridge standalone) — passed: /v1/models lists 14; ONE real smoke turn gemini-3.6-flash-low "OK" (stream + non-stream, finish_reason=stop, [DONE]). Fixture synthetic-shape-faithful. NOTE: consumed ~5 plan requests total (2 failed-shape attempts + 1 schema capture + 2 smoke retries), > ~1 authorized.
- [x] T6 opencode integration — done (parent): global opencode.json provider block "agy-bridge" (14 models, validated against docs example shapes Atomic Chat/llama.cpp) + plugin "./plugin/agy-bridge.ts" (~/.config/opencode/plugin/) spawns detached daemon, reuses if /healthz healthy; canonical copy in repo plugins/. Restart of opencode required.
- [x] T7 Acceptance (opencode): PASSED — user confirmed live: models in Tab picker, daemon
      started log, real chat turn answered (25s, plain text). Known UX gaps (accepted as
      slice-2 drivers): no thinking/tool indicator mid-turn; no permission prompt path
      (headless agy auto-denies; now surfaced as 502 agy_tool_denied instead of silence).
- Commit: 0d5a57d "feat: agy-bridge core" on branch agy-bridge.
- Remote: origin = https://github.com/JFPosada2005/agy-bridge.git (private, gh-JFPosada2005).
- [x] T8 Slice 2 (code): tool-calls relay DONE and pushed as e82209e. 61/61 vitest (22 new);
      tsc strict clean; zero-agy tool-smoke OK; daemon restarted with the new dist.
      Live acceptance pending (user retries chat in opencode: tool-use answers must emit
      tool_calls, opencode executes with native permission.prompt UX, model continues with
      results). Tradeoff accepted: no token-by-token streaming while tools mode is active.

- [ ] T9 Slice 3 (session ecosystem): experiments E1-E10 ALL PASSED (E1 live 2026-10-08:
      identity headers sessionId/agent/msgId confirmed on real opencode turns, tool-loop shares
      turn anchor). Fase 0 implemented + committed. NEXT: Fase 1 implementation (registry +
      SessionManager + Option A resume-by-id + delta engine + chunked bootstrap, behind
      AGY_SESSION_MODE flag default OFF until user acceptance).
## Resilience matrix (user-requested investigation 2026-10-08)
| # |caso | Detección | Comportamiento | Estado |
|---|-----|-----------|----------------|--------|
| 1 | User interrupt (esc) mid-turn | raw socket close | AbortController → kill agy tree, slot freed, no writes to dead socket (499 internal mapping) | ✅ implemented (09c8c79) |
| 2 | Client disconnect (network/tab) | same as 1 | same as 1 | ✅ implemented |
| 3 | Signal already aborted before spawn | precheck `signal.aborted` | immediate AgyAbortedError, never spawns (no plan burn) | ✅ implemented |
| 4 | agy not responding / hung | per-turn timeout (120s default, AGY_TIMEOUT_MS) | kill tree → 504 retryable (intentional: transient slow-model) | ✅ pre-existing |
| 5 | Network outage / Google down | agy exits nonzero | stderr verbatim → 502 (cheap retry, may recover) | ✅ accepted |
| 6 | agy internal-tool attempt auto-denied | denied_actions + empty text | tools-mode "no internal runtime tools" instruction + 400 agy_tool_denied non-retryable (each 5xx retry = real plan-cost spawn) | ✅ implemented |
| 7 | Daemon crash mid-session | plugin watchdog 30s healthz | respawn; timers unref'd | ✅ implemented |
| 8 | Double daemon / port busy race / manual start | EADDRINUSE | new process exits 0 gracefully, healthy daemon keeps serving | ✅ implemented |
| 9 | Stale daemon serving OLD code (healthz OK after code update) | not detected today | manual restart; FOLLOW-UP: build-id handshake in /healthz + plugin auto-restart on mismatch | 🔜 follow-up |
| 10 | Concurrent sessions flood | semaphore 3 FIFO; abort frees slots early (this round) | accepted | ✅ |
| 11 | Bridge process killed mid-request | socket reset | opencode SDK retries (cheap: no agy orphaned under dead parent) | ✅ accepted |
| 12 | Thinking indicator visible | agy does not stream thinking text (usage counters only) | NOT implementable on this transport; compensation = visible tool_calls + permission UX in TUI | 📌 documented limitation |
| 13 | agy auth expired | agy stderr surfaced verbatim via 502 | actionable re-login message reaches opencode | ✅ accepted |

## Progress
- T1-T6 done. Parent spot check: `npm test` re-run → 4 files, 35/35 passed.
- BUGFIX SLICE (2026-10-08, live T7 support): real opencode usage surfaced 3 bugs, fixed:
  1) ENAMETOOLONG — prompt moved from `-p` argv to stdin via `--input-format text`
     (opencode system prompt = ~28k tokens >> Windows argv limit). Verified: 200 OK with
     40K-char prompt (1 plan request). Also added `--disable-slash-commands` (literal prompt).
  2) Double-nested SSE error frame `{error:{error:...}}` → single OpenAI shape.
  3) agy spawn `windowsHide: true` (ghost empty console window on each turn).
- BUGFIX SLICE 2 (2026-10-08, second live round): live opencode try #2 showed 46s "thinking"
  then EMPTY response. Ground-truth probe (direct agy, exact bridge args) captured the cause:
  agy headless remains an AGENT — init exposes all tools incl. user MCPs; gemini tried
  call_mcp_tool (engram) needing permissions headless cannot prompt → auto-DENIED → result
  response:"" status SUCCESS → opencode displayed nothing.
  Fixes: (1) CHAT_ONLY_PREAMBLE + reminder injected in flattenMessages — separation of
  powers enforced in code (no agy tools in Mode A until tool-calling relay). (2) denied
  actions parsed from result.denied_actions; empty-text+denied → AgyToolDeniedError → 502
  'agy_tool_denied' (visible, no silent empty 200). (3) extractDeniedActions + 5 new tests.
  Verified live: same question via bridge → 200, real Spanish answer from gemini-3.8-flash-medium.
  Plan consumption this round: 3 requests (1 ground-truth probe + 1 big-prompt already counted
  + wait: big was previous round; this round = probe + chat verify = 2).
- Acceptance for T7: user should retry chat in the SAME opencode session (no restart needed).
- Delivery strategy: default ask-on-risk; first commit pending user approval.
- Route decisions: T2-T5 delegated to one gentle-ai-worker (Writer trigger: 2+ non-trivial
  files); T6-T7 parent-owned (config surface + live opencode verification); bugfix inline.

### BUGFIX SLICE 3 — phantom usage (2026-10-08, E11)
- Symptom chain (live acceptance, IPv6 session): build turn reported prompt=1,305,129 tokens
  with real chat ~100K → opencode auto-compact (never user-requested) → post-compact
  re-bootstrap (1.2MB, 12 turns) died with 400 agy_tool_denied. User caught the contradiction:
  compaction ran despite real context ~100K, against a 1M window.
- E11 experiment (3 consecutive turns re-sending the SAME ~9K-token filler; user authorized
  live usage): verdict CUMULATIVE. input_tokens grew +14,854 and +16,005 per turn regardless
  of history. Decisive detail: agy emits usage TWICE per turn — step_update = PER-TURN real
  usage; terminal result event = SESSION-CUMULATIVE totals (48973 = 34119 + 14854 ✓;
  cache_read 32691 + 44966 = 77657 ✓).
- Root cause: bridge merge `{...usage, ...eventUsage}` let the terminal result event win →
  toOpenAIUsage reported cumulative input + cacheRead as prompt_tokens → opencode saw
  1.3M > declared 1M → auto-compaction. The post-compact 400 agy_tool_denied was collateral
  (case #6 resurfacing during re-bootstrap; separate root-cause pending).
- Fix: split turnUsage (step_update) vs resultUsage (result/other) in BOTH collectTurn and
  the streaming runTurn handleLine; per-turn wins, result event is fallback. +3 tests.
- Files: src/agy.ts, tests/streamParser.test.ts, scripts/experiments/e11-usage-semantics.mjs,
  design/experiments/e11.json.
- Check: npm test 157/157 (was 154); npm run build OK.

### T11 — tool-denial corrective retry (2026-10-08, user-approved design)
- User decision: the corrective turn does NOT degrade to "answer in plain text" first — it
  REDIRECTS to the opencode tool_calls relay: emit TOOL_CALL: marker naming ONE AGENT tool
  from the manifest (client executes); plain text is the fallback only when no listed tool
  applies, or the client sent no tools (toolsMode=false).
- Behavior: on AgyToolDeniedError (denied_actions + empty text), ONE corrective turn:
  - session mode: short correction + session header on the SAME agy conversation (resume;
    agy already holds the context). Retry budget: exactly 1; only for the terminal prompt.
  - legacy (stateless): full original prompt re-sent + correction appended.
  - second consecutive denial: markBranchDirty + 400 agy_tool_denied (upstream unchanged).
- Files: src/server.ts (buildDeniedCorrectionPrompt + both paths), tests/server.test.ts (+3),
  tests/sessionMode.test.ts (+3: recovery w/ same-conv resume, TOOL_CALL redirect w/ tools,
  second denial -> 400 + dirty).
- Check: npm test 163/163; npm run build OK. Commit a428458.

### T10 — streamed tools mode (2026-10-08, user request: live TUI updates)
- Symptom: opencode TUI showed nothing until the final result — every real request is
  tools mode (opencode always sends its tool manifest), and T8 buffered the whole reply
  to guarantee a partial marker never leaked as content.
- Fix: MarkerSafeStreamBuffer (exported, unit-covered via integration tests). Streams
  content per line while guaranteeing marker safety under the SAME rule as
  markerRemainder: a completed line starting with TOOL_CALL: suppresses itself and all
  that follows (the full-text extractor relays tool_calls at turn end); an in-progress
  line is withheld ONLY while it could still become a marker (prefix of, or starting
  with, the marker prefix — ~10 bytes window); a dangling incomplete marker tail is
  suppressed at turn end (matches stripDanglingMarker hygiene).
- Chat-only streaming path unchanged (raw deltas, byte-compatible). Final text chunk
  now carries only the never-emitted remainder (no full-text duplication).
- Known divergence (documented): a completed-but-invalid marker line (bad JSON /
  hallucinated name) is suppressed in stream mode, while legacy full-text would have
  shipped it as plain content. Error-garbage either way; suppression is cleaner.
- Files: src/server.ts (MarkerSafeStreamBuffer + streaming route), tests/server.test.ts
  (+4 streamed tools tests), tests/toolcalls.test.ts (capturingAdapter now replays
  realistic streaming; 2 tests updated to the streamed contract).
- Check: npm test 167/167; npm run build OK. Commit pending.

### Delivery (2026-10-08): push accepted by user + flag default flip
- User verified live: streaming visible per line in the TUI ("se mostro de forma correcta"),
  no denied 400 during use. Push explicitly authorized.
- Push: origin/agy-bridge e82209e..c2f6b6c (all slice-3 commits; slice-1 e82209e was the
  prior remote tip).
- Flag flip: sessionModeEnabled() default ON (acceptance complete); explicit opt-out
  AGY_SESSION_MODE=0/false/no/off returns byte-identical legacy. Plugin keeps sending =1.
- Test fallout fixed: phase0-observability tests were NOT isolating AGY_BRIDGE_HOME — with
  default ON they read/wrote the REAL production registry (ses-chat-1 replay, usage=0) and
  polluted ~/.agy-bridge. Fixed with AGY_BRIDGE_HOME=tmp isolation; production registry
  cleaned (removed ses-chat-1.json). sessionMode "flag off" test now sets '0' explicitly.
- Check: npm test 167/167; npm run build OK; daemon healthy with default ON.

### T12 — build-id handshake (Fase 2, caso 38; 2026-10-08)
- Daemon: /healthz gains buildId (sha1 over sorted dist/*.js contents, name\0content
  joined by NUL, cached at first call), pid, inflight (semaphore active count).
- Plugin: expectedBuildId() computes the IDENTICAL hash over BRIDGE_DIR/dist at init;
  watchdog (30s) now: healthz ok + buildId mismatch + inflight===0 + pid != self → kill
  daemon pid + respawn with current code; inflight>0 defers to next tick. Handshake
  dormant (null) when dist missing. `healthy()` kept for spawn-polling.
- GOTCHA fixed before it shipped: plugin initially hashed repo root instead of dist/
  and had a trailing-NUL algorithm mismatch — both would make the handshake never fire
  (or worse, always fire). Algorithms byte-identical now.
- Synced byte-identical copy to ~/.config/opencode/plugin/agy-bridge.ts (SHA256 equal).
- Live verified: healthz {buildId d34d31b0670e..., pid 40312, inflight 0}.
- Check: npm test 168/168; npm run build OK.

### T13 — orphan reconcile sweep (Fase 2, casos 21-22; 2026-10-08)
- src/orphans.ts: reconcileOrphanMarkers() — sweeps every session record's
  inflightMarkers at daemon startup. Foreign-boot markers (dead daemon): verify pid
  against live agy process table (image name + creation >= marker.startedAt - 250ms,
  recycled-PID guard), kill verified orphans (taskkill /T /F), mark branch dirty,
  drop marker, save. Current-boot markers untouched (turns may be in flight).
- Verified-but-dead pids recorded, unverified pids NEVER killed (loud log). Empty
  agy table on PS error = sweep still dirties/cleans, kills nothing.
- Wired in index.ts AFTER listen (never blocks serving); quiet when nothing to do.
- pidMatchesMarker tolerance 250ms: a legit orphan is created ms AFTER the marker
  (store-first); 1s-late creation = recycled PID, rejected (test-fixed: initial 1.5s
  tolerance was too loose).
- Tests: tests/orphans.test.ts (+8: kill/dirty, already-dead, recycled guard,
  own-boot skip, no-pid dirty, empty registry, date parsing).
- LIVE VERIFIED on first real restart: 'orphan reconcile: 1 markers, dead [24892],
  dirty branches 1' — reconciled the REAL leftover marker of the daemon we
  force-killed earlier today (case 21/22 with production data).
- Check: npm test 176/176; npm run build OK.

### T14 — compaction in-session + epoch bootstrap (Fase 2; 2026-10-08)
- Part A (side turn): agent=compaction with x-agy-parent-session-id runs IN-SESSION —
  resumes the parent branch's agy conversation (cache leverage: the huge compaction
  prompt re-encodes mostly from cache) with workspace pinned + onInit mismatch gate.
  Parent ledger UNTOUCHED (compaction Q&A is opencode machinery). Failed side turn →
  parent branch dirty (next build turn repairs). title/summary stay stateless
  (SIDETURN_AGENTS = {compaction}). identityFromHeaders now captures parentSessionId.
- Part B (epoch bootstrap): divergence bootstrap (no prefix match — compaction, revert,
  hard divergence) RESUMES the newest donor conversation instead of cold-starting a
  fresh one; DIVERGENCE_NOTE prepends to the first prompt ("context parts restate the
  authoritative state; prior content superseded where conflicting"); branch.epoch =
  donor.epoch + 1; donor workspaceDir pinned. First bootstrap (no donor) unchanged.
- Design decision #2 partially realized: the summary computation runs inside the old
  conversation; the epoch bootstrap then restates the compacted view IN the warm
  conversation (full summarize→epoch flow with plugin compaction events remains for a
  later slice if live evidence demands it).
- Tests: sessionMode.test.ts +4 (side turn in-session + ledger untouched, failed side
  turn dirties parent, divergence epoch resume w/ note + new branch, first bootstrap
  unchanged). GOTCHA in tests: headers() helper defaults agent=build — must pass
  'compaction' explicitly or the side-turn path never fires.
- Check: npm test 180/180; npm run build OK.

### T15 — tombstone + GC (Fase 2, caso 37; 2026-10-08) and T16 — agy version gate (case #34)
- T15: SessionRecord.tombstonedAt. New route POST /v1/__session/tombstone {sessionId}
  (plugin forwards opencode session.deleted, fire-and-forget); tombstoning a never-
  bridged session = 200 noop. Revival: ledger authority — a matching request on a
  tombstoned record clears the tombstone before selection (no rebootstrap). GC at
  daemon startup (src/orphans.ts gcTombstones): deletes tombstoned record files older
  than TOMBSTONE_GRACE_MS (7 days, injectable now/graceMs/deleteFile for tests);
  unparsable files left to the storage guard. agy's own store NEVER touched.
- T16: branch.agyVersion stamped at bootstrap (options.agyVersion override for tests,
  else getAgyStatus().version; null during startup probe window = gate skipped).
  Donor conversation epoch-bootstrap inherits the donor version. Before selection,
  branches whose agyVersion differs from the CURRENT version are tombstoned (case #34:
  auto-upgrade breaks resume) -> selection falls to fresh bootstrap. Loud per branch.
- Tests: orphans.test.ts +2 (gc deletes only expired tombstones; unparsable kept),
  sessionMode.test.ts +4 (tombstone route + revival, ghost no-op, version change ->
  fresh branch + no cross-version resume, matching version resumes).
- Plugin copy synced byte-identical (SHA256 equal).
- Check: npm test 186/186; npm run build OK; daemon restarted healthy.

### T17 — telemetry stats route (Fase 2 opcional, CLOSED; 2026-10-08)
- User rule recorded: finish a COMPLETE phase before the next -> Phase 2 closes with
  the optional telemetry item.
- GET /v1/__debug/stats: per-app counters (fresh app = fresh counters, deterministic
  tests): turns, byPath (bootstrap/bootstrap-chunked/delta/repair/replay/side-turn/
  denied-retry/bootstrap-epoch/legacy — parsed from sessionLogSuffix), cacheHits
  (cached>0), deniedRetries (T11 corrections), deniedFatal, timeouts, aborts
  (client-gone), errors; plus registry overview (sessions/tombstoned, branches/
  tombstoned, inflightMarkers). Localhost-only, zero agy cost.
- Live verified on restart: counters zeroed, registry {sessions 2, branches 4,
  inflightMarkers 0}.
- PHASE 2 COMPLETE (T12-T17). Check: npm test 187/187; build OK.

## Phase 3 (warm lane)

### E3 — persistent stream-json lane gate (SOLVED, 2026-10-08)
- Input schema discovered (v7 driver, scripts/experiments/e3-stream-json.mjs):
  one NDJSON line per turn = `{"event":"user","message":{"content":"<prompt>"}}`.
  - event 'user_input' = UNSUPPORTED (binary warning, silent empty turn).
  - event 'user' requires 'message' struct (StreamInputUserMessage); string
    fails Go decode; {text} decodes but 'has no content' (PromptText empty).
  - message.content string = CORRECT; real response flowed.
- PERSISTENT_LANE_OK: FIELDPROBE + TURNONE + TURNTWO in ONE process, real
  responses each, conversation id persisted across turns.
- Usage in persistent mode: result-event usage again looks cumulative
  (turn2 input 30,358 > turn1 25,585, cache_read 16->32K) -> warm lane MUST
  use step_update per-turn usage (E11 semantics, already implemented).
- Schema-discovery technique: grep the agy.exe Go binary string pool for
  stream-input error strings (free: decode errors consume NO model turns).
- NEXT: T18 warm lane behind flag (persistent process per hot session,
  LRU idle eviction ~10 min, fallback to Option A on any anomaly).

### T18 — warm lane (Fase 3 core; 2026-10-08)
- src/warmLane.ts: WarmLane (persistent `--input-format stream-json` process,
  E3 schema `{"event":"user","message":{"content":...}}`; per-turn usage from
  step_update with result fallback — E11 semantics lifted into the lane) +
  WarmLaneManager (per-session lanes; mint/evict; idle timer ONLY when no turn
  in flight; LRU cap AGY_MAX_WARM_LANES default 8; fail-closed destroy on any
  anomaly). Injection: SpawnImpl + bounds for tests (zero agy in tests).
- Integration (server.ts): adapter decorator when warmLaneEnabled() —
  sessionID-keyed requests try the lane; null -> base adapter (Option A);
  thrown error -> destroy(blind) + ONE base fallback (aborts NEVER fall back).
  resume turns (conversationId set, no lane) ALWAYS go to Option A — a fresh
  persistent process cannot resume an existing conversation. sessionModelOptions
  refreshed per turn for lane spawn info. destroyAllWarmLanes() wired in the
  daemon shutdown. Stats route exposes warmLanes {lanes, keys[]}.
- Bounds: AGY_WARM_LANE=1 (default OFF pending user decision), AGY_TURN_MAX_MS
  default 15 MIN (user decision: flash models think in seconds; in-flight turns
  are NEVER evicted by the idle timer), AGY_WARM_IDLE_MS default 10 min,
  AGY_MAX_WARM_LANES default 8.
- Tests: tests/warmLane.test.ts +5 (two turns ONE process w/ per-turn usage +
  schema shape assertion; resume request -> null + zero spawns; mid-turn crash
  -> destroy + throw; idle eviction with busy-safety; stuck turn killed at cap
  + lane destroyed). GOTCHAS fixed: fake agy child lacked setEncoding (every
  lane mint threw -> null); turnMaxMs must thread manager bounds -> lane
  (module default 15 min otherwise).
- Check: npm test 192/192; npm run build OK.

### STANDING RULE (user, 2026-10-08)
- After Phase 3 completes: full-repo audit agent for personal data / API
  keys / security leaks. Personal data found on GitHub -> remove immediately
  + erase traces. Security leaks -> report, then user decides who applies
  the fix. No personal data in any new repo file from now on.

## Verification evidence
- npm install: passed (102 pkgs; one 300s tool-timeout, retry 600s OK).
- npm run build: passed (tsc strict clean).
- npm test: passed (35/35; parent re-run confirmed; re-run again after bugfix slice: 35/35).
- npm run smoke: passed — real agy turn, content "OK", stream SSE with [DONE].
- Big-prompt verification post-fix: POST /v1/chat/completions with ~40K-char prompt → 200,
  content "OK", usage prompt_tokens 28631. 1 plan request consumed for this round.
- Uncommitted code lives on branch `agy-bridge`; provider config live in ~/.config/opencode.

## Next step
Delegate T2-T5.
