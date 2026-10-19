// Migrate an OpenCode config from the V1 agy-bridge surface (one model per
// reasoning effort) to the V2 surface (one model per family with variants).
//
// V2 merges config-defined provider models after plugin transforms, so the
// legacy entries cannot be removed reliably from a plugin; the config file is
// the source of truth. jsonc-parser edits only the target properties and
// preserves comments, formatting, duplicate keys and unrelated settings.
//
// Usage: node scripts/migrate-agy-models.mjs [--config <path> ...]

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser"

export const LEGACY_MODEL_IDS = [
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

const ROOTS = ["provider", "providers"]

/** Remove legacy agy-bridge models from config text, preserving everything else. */
export function migrateConfigText(text) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : ""
  let updated = bom ? text.slice(1) : text
  const eol = updated.includes("\r\n") ? "\r\n" : "\n"
  let removed = 0
  for (const root of ROOTS) {
    for (const modelID of LEGACY_MODEL_IDS) {
      const target = [root, "agy-bridge", "models", modelID]
      const tree = parseTree(updated)
      // modify() throws when the path does not exist; only edit real entries.
      if (!tree || !findNodeAtLocation(tree, target)) continue
      const edits = modify(updated, target, undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol },
      })
      if (edits.length > 0) {
        updated = applyEdits(updated, edits)
        removed += 1
      }
    }
  }
  return { text: bom + updated, removed }
}

function defaultConfigPaths() {
  const home = os.homedir()
  return [
    path.join(home, ".config", "opencode", "opencode.json"),
    path.join(home, ".config", "opencode", "opencode.jsonc"),
  ]
}

function parseArgs(argv) {
  const configs = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1]) {
      configs.push(argv[index + 1])
      index += 1
    }
  }
  return configs.length > 0 ? configs : defaultConfigPaths()
}

function migrateFile(file) {
  if (!fs.existsSync(file)) {
    return { file, removed: 0, skipped: true }
  }
  const original = fs.readFileSync(file, "utf8")
  const { text, removed } = migrateConfigText(original)
  if (removed === 0 || text === original) {
    return { file, removed: 0, skipped: false }
  }
  // Keep a recovery copy next to the config; never rewrite without one.
  fs.copyFileSync(file, `${file}.agy-bridge.bak`)
  fs.writeFileSync(file, text, "utf8")
  return { file, removed, skipped: false }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  let total = 0
  for (const file of parseArgs(process.argv.slice(2))) {
    try {
      const result = migrateFile(file)
      if (result.skipped) continue
      if (result.removed > 0) {
        total += result.removed
        console.log(`Removed ${result.removed} legacy agy-bridge model entries from ${file}`)
      } else {
        console.log(`No legacy agy-bridge model entries in ${file}`)
      }
    } catch (error) {
      console.log(`Could not migrate ${file} (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (total === 0) {
    console.log("agy-bridge model surface already migrated.")
  }
}
