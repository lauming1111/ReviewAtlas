import type { AnalysisDepth } from './types.js';

/**
 * ─── Review Atlas — Tunable Parameters ────────────────────────────────────────
 *
 * Edit this file to tune the extension's behaviour.
 *
 * SCROLL_CONFIG reaches the content script over the GET_REVIEWS message (the
 * content script cannot import this module — build.js strips ES exports so the
 * script can run as a classic content script). content.ts keeps a matching
 * DEFAULT_SCROLL_CONFIG used only when no config arrives on the message.
 */

// ─── Scroll / data-gathering ─────────────────────────────────────────────────

export const SCROLL_CONFIG = {
  /** ms to wait after clicking the Reviews tab before the first scrape */
  TAB_OPEN_WAIT_MS: 1500,

  /** How often (ms) to poll for new reviews after each scroll */
  POLL_INTERVAL_MS: 300,

  /** Maximum ms to wait per scroll round before giving up and moving on */
  SCROLL_WAIT_MS: 2000,

  /** Maximum ms to wait after clicking a "More reviews" button */
  MORE_REVIEWS_WAIT_MS: 2000,

  /**
   * Stop after this many consecutive scroll rounds that yield nothing new.
   * Each stalled round can cost SCROLL_WAIT_MS + MORE_REVIEWS_WAIT_MS, so this
   * value is the dominant term in the "waiting after the last review" tail.
   */
  MAX_STABLE_ROUNDS: 2,

  /** Scrape ceiling for non-"recent" review modes (content.ts mirrors this). */
  MAX_REVIEWS_ALL: 10000,
} as const;

// ─── Popup ────────────────────────────────────────────────────────────────────

export const POPUP_CONFIG = {
  /** How often (ms) the popup polls the tab for the live review count */
  PROGRESS_POLL_MS: 800,
} as const;

// ─── Cache ────────────────────────────────────────────────────────────────────

export const CACHE_CONFIG = {
  /** How long a cached summary or review set stays valid */
  TTL_MS: 24 * 60 * 60 * 1000,

  /** Maximum entries kept per cache before the oldest are evicted */
  MAX_ENTRIES: 50,
} as const;

// ─── AI defaults ─────────────────────────────────────────────────────────────

export const AI_DEFAULTS = {
  /** Default Ollama model (must be pulled locally via `ollama pull <model>`) */
  OLLAMA_MODEL: 'llama3.2:latest',

  /** Default OpenAI model */
  OPENAI_MODEL: 'gpt-4o-mini',

  /** OpenAI temperature (0 = deterministic, 1 = creative) */
  OPENAI_TEMPERATURE: 0.3,

  /** How many times to retry the AI call when it returns invalid JSON */
  MAX_RETRIES: 3,

  /** Delay (ms) before the first retry; doubles on each subsequent attempt */
  RETRY_BACKOFF_MS: 500,

  /** Abort an AI request that has not responded within this many ms */
  REQUEST_TIMEOUT_MS: 120_000,

  /** Upper bound on generated tokens — must fit the full JSON result object */
  MAX_OUTPUT_TOKENS: 2048,

  /** Per-review character cap inside the prompt */
  MAX_REVIEW_CHARS: 400,

  /** Default depth preset when a profile has not chosen one */
  ANALYSIS_DEPTH: 'balanced' as AnalysisDepth,

  /** Base URL of the local Ollama server (user-overridable per profile) */
  OLLAMA_ENDPOINT: 'http://127.0.0.1:11434',

  /** Default output language — 'auto' follows the reviews' own language */
  OUTPUT_LANGUAGE: 'auto',

  /** Default Anthropic model */
  ANTHROPIC_MODEL: 'claude-3-5-haiku-20241022',

  /** Default Google Gemini model */
  GEMINI_MODEL: 'gemini-2.0-flash',

  /** Default Groq model */
  GROQ_MODEL: 'llama-3.3-70b-versatile',

  /** Default xAI (Grok) model */
  XAI_MODEL: 'grok-3-mini-latest',

  // ─── Ollama local model parameters ──────────────────────────────────────────

  /**
   * Sampling defaults for ANY locally-hosted model (Ollama or an
   * OpenAI-compatible server). The OLLAMA_ prefix is kept for continuity with
   * stored settings, but nothing here is Ollama-specific.
   */
  /** Sampling temperature — lower = more focused, higher = more creative */
  OLLAMA_TEMPERATURE: 0.7,

  /** Top-K sampling — number of tokens to consider at each step */
  OLLAMA_TOP_K: 40,

  /** Top-P (nucleus) sampling */
  OLLAMA_TOP_P: 0.9,

  /** Context window in tokens — must fit the depth budget plus MAX_OUTPUT_TOKENS */
  OLLAMA_NUM_CTX: 16_384,

  /** Repeat penalty — discourages repetition (1.0 = off) */
  OLLAMA_REPEAT_PENALTY: 1.1,
} as const;

// ─── Local server presets ────────────────────────────────────────────────────

/**
 * One-click endpoints for the common OpenAI-compatible local runtimes, so
 * "run a model on my own machine" is not synonymous with "install Ollama".
 * Ports are each project's documented default.
 */
export const LOCAL_PRESETS = [
  { id: 'lmstudio', label: 'LM Studio',            endpoint: 'http://localhost:1234/v1'  },
  { id: 'llamacpp', label: 'llama.cpp server',     endpoint: 'http://localhost:8080/v1'  },
  { id: 'jan',      label: 'Jan',                  endpoint: 'http://localhost:1337/v1'  },
  { id: 'vllm',     label: 'vLLM',                 endpoint: 'http://localhost:8000/v1'  },
  { id: 'kobold',   label: 'KoboldCpp',            endpoint: 'http://localhost:5001/v1'  },
  { id: 'textgen',  label: 'text-generation-webui', endpoint: 'http://localhost:5000/v1' },
  { id: 'localai',  label: 'LocalAI',              endpoint: 'http://localhost:8080/v1'  },
  { id: 'ollama',   label: 'Ollama (OpenAI API)',  endpoint: 'http://localhost:11434/v1' },
] as const;

// ─── Analysis depth ──────────────────────────────────────────────────────────

/**
 * How much of the collected review set reaches the model.
 *
 * A review count alone does NOT bound prompt size — 250 verbose reviews still
 * reach ~25k tokens — so every preset carries a hard character budget too.
 * Both are enforced in background.ts (selectReviewsForPrompt / enforceCharBudget).
 */
export const ANALYSIS_DEPTHS = {
  quick:    { maxReviews: 100, maxChars: 20_000, label: 'Quick',    hint: '~100 reviews · fastest'  },
  balanced: { maxReviews: 250, maxChars: 48_000, label: 'Balanced', hint: '~250 reviews · default'  },
  thorough: { maxReviews: 500, maxChars: 96_000, label: 'Thorough', hint: '~500 reviews · slowest'  },
} as const satisfies Record<AnalysisDepth, { maxReviews: number; maxChars: number; label: string; hint: string }>;

// ─── Prompt budgeting ────────────────────────────────────────────────────────

export const PROMPT_BUDGET = {
  /**
   * Rough characters-per-token for English prose. Deliberately optimistic
   * (real English is ~4) so the derived character budget errs on the small side.
   */
  CHARS_PER_TOKEN: 3.5,

  /** Approximate size of the non-review scaffolding in buildPrompt(). */
  STATIC_PROMPT_CHARS: 1_500,

  /** Serialization overhead per review: "[Review 999] ⭐4/5 — " plus the join. */
  PER_REVIEW_OVERHEAD: 24,
} as const;

// ─── Output languages ────────────────────────────────────────────────────────

/** Offered in the settings picker. 'auto' follows the reviews' own language. */
export const OUTPUT_LANGUAGES = [
  { value: 'auto',  label: 'Auto (match reviews)' },
  { value: 'English',             label: 'English'    },
  { value: 'Traditional Chinese', label: '繁體中文'    },
  { value: 'Simplified Chinese',  label: '简体中文'    },
  { value: 'Japanese',            label: '日本語'      },
  { value: 'Korean',              label: '한국어'      },
  { value: 'Spanish',             label: 'Español'    },
  { value: 'French',              label: 'Français'   },
  { value: 'German',              label: 'Deutsch'    },
  { value: 'Portuguese',          label: 'Português'  },
  { value: 'Italian',             label: 'Italiano'   },
] as const;
