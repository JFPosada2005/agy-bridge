// Migrate an OpenCode config from the V1 agy-bridge surface to the V2 one:
//
//   1. Remove the retired `./plugin/agy-bridge.ts` entry from the root
//      `plugin`/`plugins` arrays (V1 plugin code cannot run in V2).
//   2. Remove the per-effort model ids under
//      `provider|providers.agy-bridge.models`; V2 exposes one model per family
//      with reasoning variants.
//
// The edit is range-based on the jsonc-parser AST: comments, inline entries,
// indentation, duplicate keys and unrelated settings are preserved. A malformed
// config is never rewritten. A single `.agy-bridge.bak` copy is written before
// the first change.
//
// Usage: node scripts/migrate-agy-models.mjs [--config <path> ...]

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse, parseTree } from "jsonc-parser"

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

export const V1_PLUGIN_ENTRY = "./plugin/agy-bridge.ts"

const PROVIDER_ROOTS = ["provider", "providers"]
const PLUGIN_KEYS = ["plugin", "plugins"]
const WHITESPACE = /\s/

function keyOf(property) {
  return property?.children?.[0]?.value
}

function valueOf(property) {
  return property?.children?.[1]
}

function forEachProperty(node, key, callback) {
  if (!node || node.type !== "object") return
  for (const child of node.children ?? []) {
    if (child.type === "property" && keyOf(child) === key) callback(child)
  }
}

/**
 * Range to delete for an object property or array element. Includes the
 * adjacent comma and, when the member starts a line, its indentation. Never
 * consumes a comment.
 */
function memberRange(text, node) {
  let start = node.offset
  let end = node.offset + node.length

  let after = end
  while (after < text.length && WHITESPACE.test(text[after])) after += 1
  if (text[after] === ",") {
    let commaEnd = after + 1
    while (commaEnd < text.length && (text[commaEnd] === " " || text[commaEnd] === "\t")) {
      commaEnd += 1
    }
    end = commaEnd
  } else {
    let before = start - 1
    while (before >= 0 && WHITESPACE.test(text[before])) before -= 1
    if (text[before] === ",") {
      start = before
      end = node.offset + node.length
    }
  }

  let lineStart = start
  while (lineStart > 0 && text[lineStart - 1] !== "\n" && text[lineStart - 1] !== "\r") {
    lineStart -= 1
  }
  if (/^[ \t]*$/.test(text.slice(lineStart, start))) start = lineStart

  return { start, end }
}

function applyRanges(text, ranges) {
  if (ranges.length === 0) return text
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const range of sorted) {
    if (range.end <= range.start) continue
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  let output = text
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const { start, end } = merged[index]
    output = output.slice(0, start) + output.slice(end)
  }
  return output
}

/** Remove the V1 plugin entry and legacy agy-bridge models, preserving JSONC. */
export function migrateConfigText(text) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : ""
  const body = bom ? text.slice(1) : text
  const errors = []
  parse(body, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return {
      text,
      removed: 0,
      removedPluginEntries: 0,
      errors: errors.map((error) => error.error),
    }
  }
  const tree = parseTree(body)
  if (!tree) {
    return { text, removed: 0, removedPluginEntries: 0, errors: [] }
  }

  const ranges = []
  let removed = 0
  let removedPluginEntries = 0

  for (const key of PLUGIN_KEYS) {
    forEachProperty(tree, key, (property) => {
      const array = valueOf(property)
      if (!array || array.type !== "array") return
      for (const element of array.children ?? []) {
        if (element.type === "string" && element.value === V1_PLUGIN_ENTRY) {
          ranges.push(memberRange(body, element))
          removedPluginEntries += 1
        }
      }
    })
  }

  for (const key of PROVIDER_ROOTS) {
    forEachProperty(tree, key, (property) => {
      const providers = valueOf(property)
      if (!providers || providers.type !== "object") return
      for (const provider of providers.children ?? []) {
        if (provider.type !== "property" || keyOf(provider) !== "agy-bridge") continue
        const providerBody = valueOf(provider)
        if (!providerBody || providerBody.type !== "object") continue
        for (const modelsProperty of providerBody.children ?? []) {
          if (modelsProperty.type !== "property" || keyOf(modelsProperty) !== "models") continue
          const models = valueOf(modelsProperty)
          if (!models || models.type !== "object") continue
          for (const model of models.children ?? []) {
            if (model.type === "property" && LEGACY_MODEL_IDS.includes(keyOf(model))) {
              ranges.push(memberRange(body, model))
              removed += 1
            }
          }
        }
      }
    })
  }

  return {
    text: bom + applyRanges(body, ranges),
    removed,
    removedPluginEntries,
    errors: [],
  }
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
    return { file, removed: 0, removedPluginEntries: 0, skipped: true }
  }
  const original = fs.readFileSync(file, "utf8")
  const result = migrateConfigText(original)
  if (result.errors.length > 0) {
    return { file, ...result, skipped: false, invalid: true }
  }
  if (result.removed === 0 && result.removedPluginEntries === 0) {
    return { file, ...result, skipped: false, invalid: false }
  }
  // Recovery copy of the true pre-migration file, before any change.
  fs.copyFileSync(file, `${file}.agy-bridge.bak`)
  fs.writeFileSync(file, result.text, "utf8")
  return { file, ...result, skipped: false, invalid: false }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])

if (isMain) {
  let removed = 0
  let removedPluginEntries = 0
  for (const file of parseArgs(process.argv.slice(2))) {
    try {
      const result = migrateFile(file)
      if (result.skipped) continue
      if (result.invalid) {
        console.log(`Skipped ${file}: not valid JSONC (no changes written).`)
        continue
      }
      if (result.removed > 0 || result.removedPluginEntries > 0) {
        removed += result.removed
        removedPluginEntries += result.removedPluginEntries
        const parts = []
        if (result.removed > 0) parts.push(`${result.removed} legacy model entries`)
        if (result.removedPluginEntries > 0) parts.push(`${result.removedPluginEntries} V1 plugin entries`)
        console.log(`Removed ${parts.join(" and ")} from ${file}`)
      } else {
        console.log(`No agy-bridge V1 entries in ${file}`)
      }
    } catch (error) {
      console.log(`Could not migrate ${file} (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (removed === 0 && removedPluginEntries === 0) {
    console.log("agy-bridge config surface already migrated.")
  }
}
