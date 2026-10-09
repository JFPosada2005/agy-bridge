// Model catalog for the agy bridge.
//
// The table mirrors the output of `agy models` (agy v1.3.1). Context and output
// limits are best-effort declared values for OpenAI-compatible clients; they are
// not enforced by the bridge. Reasoning effort is encoded in the model slug
// suffix (-high/-medium/-low) and translated to the agy `--effort` flag.

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
  /** Effort parsed from the slug suffix, or null when the slug carries none. */
  effort: Effort | null;
  /** Model id without the effort suffix (what agy `--model` receives). */
  baseModel: string;
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
}

const GEMINI_CONTEXT = 1_000_000;
const GEMINI_OUTPUT = 65_536;
// Conservative declared values for non-Gemini families.
const OTHER_CONTEXT = 200_000;
const OTHER_OUTPUT = 32_768;

const SPECS: ModelSpec[] = [
  { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash (Medium)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.7-flash-high', displayName: 'Gemini 3.7 Flash (High)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.7-flash-medium', displayName: 'Gemini 3.7 Flash (Medium)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.7-flash-low', displayName: 'Gemini 3.7 Flash (Low)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.6-flash-medium', displayName: 'Gemini 3.6 Flash (Medium)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.6-flash-low', displayName: 'Gemini 3.6 Flash (Low)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'gemini-3.1-pro-low', displayName: 'Gemini 3.1 Pro (Low)', contextWindow: GEMINI_CONTEXT, maxOutputTokens: GEMINI_OUTPUT },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)', contextWindow: OTHER_CONTEXT, maxOutputTokens: OTHER_OUTPUT },
  { id: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)', contextWindow: OTHER_CONTEXT, maxOutputTokens: OTHER_OUTPUT },
  { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)', contextWindow: OTHER_CONTEXT, maxOutputTokens: OTHER_OUTPUT },
];

function toEntry(spec: ModelSpec): ModelEntry {
  const { baseModel, effort } = parseEffort(spec.id);
  return {
    id: spec.id,
    displayName: spec.displayName,
    family: detectFamily(spec.id),
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
    reasoning: effort !== null || /thinking/i.test(spec.id),
    effort,
    baseModel,
  };
}

export const MODELS: ModelEntry[] = SPECS.map(toEntry);

/** Find a catalog entry by full id, falling back to the effort-stripped base id. */
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
