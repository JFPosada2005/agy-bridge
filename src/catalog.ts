// Model catalog for the agy bridge.
//
// One entry per model family. Reasoning effort is selected per request (the
// OpenAI `reasoning_effort` field, which OpenCode V2 lowers from a model
// variant) and translated to the agy `--effort` flag.
//
// Backward compatibility: legacy suffixed ids (-high/-medium/-low) are still
// accepted as aliases, so V1 configs keep working, but they are no longer
// listed by GET /v1/models.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelFamily = 'gemini' | 'claude' | 'gpt' | 'unknown';

export interface ModelEntry {
  id: string;
  displayName: string;
  family: ModelFamily;
  /** Best-effort declared context window (input tokens). */
  contextWindow: number;
  /** Best-effort declared max output tokens. */
  maxOutputTokens: number;
  /** Whether the model uses reasoning effort scaling. */
  reasoning: boolean;
  /** Effort parsed from a legacy slug suffix, or null for a base id. */
  effort: Effort | null;
  /** Model id without the legacy effort suffix (what agy `--model` receives). */
  baseModel: string;
  /** Efforts this model accepts. Empty means no effort control. */
  efforts: Effort[];
  /** Effort used when the request names none. */
  defaultEffort: Effort | null;
}

const EFFORT_SUFFIX = /-(high|medium|low)$/;

export function parseEffort(modelId: string): { baseModel: string; effort: Effort | null } {
  const match = modelId.match(EFFORT_SUFFIX);
  if (!match) {
    return { baseModel: modelId, effort: null };
  }
  return { baseModel: modelId.slice(0, -match[0].length), effort: match[1] as Effort };
}

export function detectFamily(modelId: string): ModelFamily {
  if (modelId.startsWith('gemini')) {
    return 'gemini';
  }
  if (modelId.startsWith('claude')) {
    return 'claude';
  }
  if (modelId.startsWith('gpt')) {
    return 'gpt';
  }
  return 'unknown';
}

interface ModelSpec {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Efforts offered by the model's variants; omitted means none. */
  efforts?: Effort[];
  /** Effort sent when neither a variant nor reasoning_effort is provided. */
  defaultEffort?: Effort;
}

const GEMINI_CONTEXT = 1_000_000;
const GEMINI_OUTPUT = 65_536;
// Conservative declared values for non-Gemini families.
const OTHER_CONTEXT = 200_000;
const OTHER_OUTPUT = 32_768;

const SPECS: ModelSpec[] = [
  {
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    contextWindow: GEMINI_CONTEXT,
    maxOutputTokens: GEMINI_OUTPUT,
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash',
    contextWindow: GEMINI_CONTEXT,
    maxOutputTokens: GEMINI_OUTPUT,
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    contextWindow: GEMINI_CONTEXT,
    maxOutputTokens: GEMINI_OUTPUT,
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-3.1-pro',
    displayName: 'Gemini 3.1 Pro',
    contextWindow: GEMINI_CONTEXT,
    maxOutputTokens: GEMINI_OUTPUT,
    efforts: ['low', 'high'],
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6 (Thinking)',
    contextWindow: OTHER_CONTEXT,
    maxOutputTokens: OTHER_OUTPUT,
  },
  {
    id: 'claude-opus-4-6-thinking',
    displayName: 'Claude Opus 4.6 (Thinking)',
    contextWindow: OTHER_CONTEXT,
    maxOutputTokens: OTHER_OUTPUT,
  },
  {
    id: 'gpt-oss-120b',
    displayName: 'GPT-OSS 120B',
    contextWindow: OTHER_CONTEXT,
    maxOutputTokens: OTHER_OUTPUT,
    efforts: ['medium'],
    defaultEffort: 'medium',
  },
];

function toEntry(spec: ModelSpec): ModelEntry {
  const efforts = spec.efforts ?? [];
  return {
    id: spec.id,
    displayName: spec.displayName,
    family: detectFamily(spec.id),
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
    reasoning: efforts.length > 0 || /thinking/i.test(spec.id),
    effort: null,
    baseModel: spec.id,
    efforts,
    defaultEffort: spec.defaultEffort ?? null,
  };
}

export const MODELS: ModelEntry[] = SPECS.map(toEntry);

/** Find a catalog entry by base id, falling back through a legacy effort suffix. */
export function findModel(id: string): ModelEntry | undefined {
  const direct = MODELS.find((entry) => entry.id === id);
  if (direct) {
    return direct;
  }
  const { baseModel } = parseEffort(id);
  return MODELS.find((entry) => entry.baseModel === baseModel);
}

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OpenAIModelList {
  object: 'list';
  data: OpenAIModel[];
}

/** Exact listing served by GET /v1/models (OpenAI shape). */
export function toOpenAIModelList(): OpenAIModelList {
  return {
    object: 'list',
    data: MODELS.map((entry) => ({
      id: entry.id,
      object: 'model' as const,
      created: 0,
      owned_by: entry.family,
    })),
  };
}
