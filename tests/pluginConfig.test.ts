import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

// The plugin module boots the daemon on invocation, so instead of importing
// it into vitest these are structural assertions over the canonical source.
// Behavioral verification happens on an opencode restart (config merge).
// Proportionate check: the runtime paths this file guards are the hook
// registration itself, the provider/model surface, the add-only guards, and
// the provider-only scope (no injected agents).

const src = readFileSync(
  join(fileURLToPath(import.meta.url), "..", "..", "plugins", "agy-bridge.ts"),
  "utf8",
)

describe("agy-bridge plugin portable registration", () => {
  it("registers the config hook", () => {
    expect(src).toMatch(/config:\s*\(cfg\)\s*=>/)
  })

  it("only imports plugin types, never a runtime plugin dependency", () => {
    expect(src).toContain('import type { Plugin } from "@opencode-ai/plugin"')
    expect(src).not.toMatch(/^import \{.*\} from "@opencode-ai\/plugin"/m)
  })

  it("declares every provider model id the daemon serves", () => {
    const ids = [
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-low",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]
    for (const id of ids) {
      expect(src, `missing AGY_MODELS entry: ${id}`).toContain(`"${id}"`)
    }
  })

  it("injects the provider as just another provider (no agents, no harness assumptions)", () => {
    expect(src).not.toContain("agy-worker")
    expect(src).not.toContain("agy-general")
    expect(src).not.toContain("agy-explore")
    expect(src).not.toContain("AGY_AGENTS")
    expect(src).not.toContain("permission:")
  })

  it("keeps user overrides intact (add-only guards)", () => {
    expect(src).toContain("options.baseURL === undefined")
    expect(src).toContain("if (!models[id])")
  })
})
