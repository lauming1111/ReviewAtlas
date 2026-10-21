export interface Review {
  author: string;
  rating: number;
  text: string;
  date?: string;
}

/** The four sentiment values the UI knows how to render. */
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const;
export type Sentiment = typeof SENTIMENTS[number];

export type AnalysisDepth = 'quick' | 'balanced' | 'thorough';

export interface SummaryResult {
  placeName: string;
  overallSentiment: Sentiment;
  averageRating: number;
  totalReviews: number;
  pros: string[];
  cons: string[];
  summary: string;
  topThemes: string[];
  /** Staff/employee first names mentioned by name in multiple reviews. */
  notableStaff: string[];
  /** How many reviews were actually serialized into the prompt. */
  analyzedCount?: number;
  /** How many reviews were collected and matched the scope before sampling. */
  collectedCount?: number;
  /**
   * Set when a large share of review dates could not be parsed, which makes a
   * time-window scope silently behave like "all". parseReviewDate only handles
   * English relative dates, so this fires on non-English Maps locales.
   */
  dateParseWarning?: string;
  /**
   * Set by a provider that could not honour a setting and fell back — the
   * built-in model writes English when it cannot write the chosen language.
   */
  providerNotice?: string;
}

/**
 * Sampling parameters for a locally-hosted model. Applies to Ollama and to any
 * OpenAI-compatible local server (LM Studio, llama.cpp, Jan, vLLM, …) — these
 * are not Ollama-specific concepts.
 */
export interface ModelParams {
  temperature?: number;   // 0.0–2.0
  topK?: number;          // 1–200
  topP?: number;          // 0.0–1.0
  numCtx?: number;        // context window tokens
  repeatPenalty?: number; // 0.0–2.0
}

/** Providers that run on the user's own machine or network. */
export const LOCAL_PROVIDERS = ['ollama', 'custom'] as const;
export type LocalProvider = typeof LOCAL_PROVIDERS[number];

export interface ReviewSettings {
  reviewMode: 'recent' | 'all' | '1m' | '3m' | '6m' | '1y';
  reviewCount: number;
  /** How many reviews reach the model, and the prompt character budget. */
  analysisDepth?: AnalysisDepth;
  /** BCP-47 tag, or 'auto' to follow the dominant language of the reviews. */
  outputLanguage?: string;
  aiProvider: 'builtin' | 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'groq' | 'xai' | 'custom';
  // Ollama
  /** Base URL of the Ollama server. Defaults to AI_DEFAULTS.OLLAMA_ENDPOINT. */
  ollamaEndpoint?: string;
  ollamaModel?: string;
  ollamaParams?: ModelParams;
  // OpenAI
  openaiApiKey?: string;
  openaiModel?: string;
  // Anthropic
  anthropicApiKey?: string;
  anthropicModel?: string;
  // Google Gemini
  geminiApiKey?: string;
  geminiModel?: string;
  // Groq
  groqApiKey?: string;
  groqModel?: string;
  // xAI (Grok)
  xaiApiKey?: string;
  xaiModel?: string;
  // Custom OpenAI-compatible endpoint (LM Studio, llama.cpp, Jan, vLLM, …)
  customEndpoint?: string;
  customApiKey?: string;
  customModel?: string;
  /** Same sampling controls as Ollama — a local server is a local server. */
  customParams?: ModelParams;
  /**
   * Whether to send non-standard sampling fields (top_k, repeat_penalty) to the
   * custom endpoint. Most local servers accept them; strict ones reject the
   * request outright, so this can be turned off.
   */
  customSendExtraParams?: boolean;
}

/**
 * Google Maps defaults to "Most relevant". Without switching to "Newest" the
 * 'recent' scope was just the first N in relevance order, not the newest N.
 */
export type ReviewSort = 'relevance' | 'newest';

/**
 * Outcome of a provider check — the Test connection button, the pre-scrape
 * check and the model picker all read it. `availability` is set only for the
 * built-in model, whose state also decides whether "Download now" is offered.
 */
export interface ConnectionResult {
  ok: boolean;
  message: string;
  models?: string[];
  availability?: 'unavailable' | 'downloadable' | 'downloading' | 'available';
}

export interface ScrollConfig {
  tabOpenWaitMs: number;
  pollIntervalMs: number;
  scrollWaitMs: number;
  moreReviewsWaitMs: number;
  maxStableRounds: number;
}

export type MessageType =
  | { type: 'GET_BASIC_INFO' }
  | { type: 'BASIC_INFO'; payload: { placeName: string; googleRating?: number; googleReviewCount?: number; category?: string; address?: string; phone?: string } }
  | { type: 'GET_REVIEWS'; maxReviews?: number; scrollConfig?: ScrollConfig; sortBy?: ReviewSort }
  | { type: 'REVIEWS_DATA'; payload: { reviews: Review[]; placeName: string; googleRating?: number; googleReviewCount?: number } }
  | { type: 'SUMMARIZE'; payload: { reviews: Review[]; placeName: string; settings: ReviewSettings; googleRating?: number; googleReviewCount?: number } }
  | { type: 'SUMMARY_RESULT'; payload: SummaryResult }
  | { type: 'GET_PROGRESS' }
  | { type: 'PROGRESS'; payload: { count: number } }
  | { type: 'STOP_REVIEWS' }
  | { type: 'ERROR'; payload: string }
  | { type: 'NO_REVIEWS' }
  /**
   * Validate credentials / reachability for one provider and, where the
   * provider's list endpoint supports it, return its available models.
   * One round-trip serves both the "Test connection" button and the model picker.
   */
  | { type: 'TEST_CONNECTION'; payload: { settings: ReviewSettings } }
  | { type: 'CONNECTION_RESULT'; payload: ConnectionResult };
