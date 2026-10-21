// Minimal Prompt API declarations (the browser's built-in on-device model) —
// only what builtin.ts calls. Read the global through globalThis, never by bare
// name, so a browser without it gets undefined instead of a ReferenceError.

type LanguageModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LanguageModelOptions {
  expectedOutputs?: Array<{ type: 'text'; languages?: string[] }>;
  monitor?: (m: EventTarget) => void;
  signal?: AbortSignal;
  temperature?: number;
  topK?: number;
}

interface LanguageModelSession {
  readonly contextWindow: number;
  readonly contextUsage: number;
  /** Earlier name of contextWindow, on builds that predate the rename. */
  readonly inputQuota?: number;
  prompt(input: string, options?: {
    signal?: AbortSignal;
    responseConstraint?: object;
    omitResponseConstraintInput?: boolean;
  }): Promise<string>;
  /** Missing on early builds — feature-detect. */
  measureContextUsage?(input: string, options?: { signal?: AbortSignal }): Promise<number>;
  /** Earlier name of measureContextUsage. */
  measureInputUsage?(input: string, options?: { signal?: AbortSignal }): Promise<number>;
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  destroy(): void;
}

interface LanguageModelStatic {
  availability(options?: LanguageModelOptions): Promise<LanguageModelAvailability>;
  create(options?: LanguageModelOptions): Promise<LanguageModelSession>;
  params?(): Promise<{
    defaultTopK: number;
    maxTopK: number;
    defaultTemperature: number;
    maxTemperature: number;
  } | null>;
}
