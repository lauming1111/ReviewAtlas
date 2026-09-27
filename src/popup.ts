import type { MessageType, ModelParams, Review, ReviewSettings, ReviewSort, SummaryResult } from './types.js';
import { SCROLL_CONFIG, POPUP_CONFIG, AI_DEFAULTS, CACHE_CONFIG, ANALYSIS_DEPTHS, LOCAL_PRESETS } from './config.js';
import { encryptApiKey, decryptApiKey } from './crypto.js';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

type ScreenName = 'info' | 'history' | 'settings' | 'loading' | 'result' | 'error' | 'no-reviews' | 'wrong-page';

let currentScreen: ScreenName = 'info';

function setScreen(name: ScreenName): void {
  currentScreen = name;
  document.querySelectorAll<HTMLElement>('.screen').forEach((el) => {
    el.hidden = el.dataset.screen !== name;
  });
}

// ─── Navigation ───────────────────────────────────────────────────────────────
//
// History and Settings open over whatever the popup was showing, and Back or
// Cancel restores exactly that screen. Both used to re-run showInfoScreen,
// whose GET_BASIC_INFO can make the content script switch the Maps page to its
// Overview tab and back — so the page visibly reacted to a button in the popup.

/** Screen to restore when the open overlay closes; null while none is open. */
let overlayReturn: ScreenName | null = null;

/** The current tab's summary — re-rendered when a history entry reused the result screen. */
let homeResult: CacheEntry | null = null;

function openOverlay(name: 'history' | 'settings'): void {
  if (overlayReturn === null) overlayReturn = currentScreen;
  setScreen(name);
}

function closeOverlay(): void {
  const target = overlayReturn ?? 'info';
  overlayReturn = null;
  if (target === 'result' && homeResult) renderResult(homeResult.result, homeResult.timestamp);
  setScreen(target);
}

/**
 * Show a screen the popup reached on its own (initial load, a finished or
 * failed analysis). While an overlay is open it becomes the screen Back returns
 * to, rather than pulling the user out of History or Settings mid-edit.
 */
function showHomeScreen(name: ScreenName): void {
  if (overlayReturn !== null) overlayReturn = name;
  else setScreen(name);
}

function showHomeResult(entry: CacheEntry): void {
  homeResult = entry;
  stopAllStepTimers();
  if (overlayReturn !== null) { overlayReturn = 'result'; return; }
  renderResult(entry.result, entry.timestamp);
  setScreen('result');
}

// ─── Settings ─────────────────────────────────────────────────────────────────

// Every model default comes from AI_DEFAULTS — previously ollamaModel and
// openaiModel were string literals duplicating config values.
const DEFAULT_SETTINGS: ReviewSettings = {
  reviewMode: 'all',
  reviewCount: 1000,
  aiProvider: 'ollama',
  analysisDepth: AI_DEFAULTS.ANALYSIS_DEPTH,
  outputLanguage: AI_DEFAULTS.OUTPUT_LANGUAGE,
  ollamaEndpoint: AI_DEFAULTS.OLLAMA_ENDPOINT,
  ollamaModel: AI_DEFAULTS.OLLAMA_MODEL,
  ollamaParams: {},
  customParams: {},
  customSendExtraParams: true,
  openaiModel: AI_DEFAULTS.OPENAI_MODEL,
  anthropicModel: AI_DEFAULTS.ANTHROPIC_MODEL,
  geminiModel: AI_DEFAULTS.GEMINI_MODEL,
  groqModel: AI_DEFAULTS.GROQ_MODEL,
  xaiModel: AI_DEFAULTS.XAI_MODEL,
};

const ALL_PROVIDERS = ['ollama', 'openai', 'anthropic', 'gemini', 'groq', 'xai', 'custom'] as const;

/** What each provider is called on its button in Settings. */
const PROVIDER_LABELS: Record<string, string> = {
  ollama:    'Ollama',
  openai:    'OpenAI',
  anthropic: 'Claude',
  gemini:    'Gemini',
  groq:      'Groq',
  xai:       'Grok',
  custom:    'Local server',
};

function providerLabel(s: ReviewSettings): string {
  const provider = s.aiProvider ?? 'ollama';
  return PROVIDER_LABELS[provider] ?? provider;
}

// Default placeholder text for each provider's key input
const KEY_PLACEHOLDERS: Record<string, string> = {
  openai:    'sk-…',
  anthropic: 'sk-ant-…',
  gemini:    'AIza…',
  groq:      'gsk_…',
  xai:       'xai-…',
  custom:    'Leave blank if not required',
};

/** Fields in ReviewSettings that contain API keys and must be encrypted at rest. */
const API_KEY_FIELDS = [
  'openaiApiKey', 'anthropicApiKey', 'geminiApiKey',
  'groqApiKey', 'xaiApiKey', 'customApiKey',
] as const satisfies ReadonlyArray<keyof ReviewSettings>;

async function getSettings(): Promise<ReviewSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['gReviewSummSettings'], async (result) => {
      const stored = (result.gReviewSummSettings ?? DEFAULT_SETTINGS) as ReviewSettings;
      const settings: ReviewSettings = { ...stored };

      for (const field of API_KEY_FIELDS) {
        const val = stored[field];
        if (typeof val === 'string' && val.length > 0) {
          try {
            (settings as unknown as Record<string, unknown>)[field] = await decryptApiKey(val);
          } catch {
            // Salt was reset or blob is corrupt — clear this key so the user re-enters it
            console.warn(`[GReviewSumm] Could not decrypt ${field} — clearing it.`);
            (settings as unknown as Record<string, unknown>)[field] = undefined;
          }
        }
      }

      resolve(settings);
    });
  });
}

async function saveSettings(settings: ReviewSettings): Promise<void> {
  const stored: ReviewSettings = { ...settings };

  for (const field of API_KEY_FIELDS) {
    const val = settings[field];
    if (typeof val === 'string' && val.length > 0) {
      (stored as unknown as Record<string, unknown>)[field] = await encryptApiKey(val);
    }
  }

  return new Promise((resolve) => {
    chrome.storage.local.set({ gReviewSummSettings: stored }, resolve);
  });
}

// ─── Key protection ───────────────────────────────────────────────────────────
//
// API keys are NEVER loaded into input.value — they stay in chrome.storage only.
// The UI shows a "✓ Saved" badge and a "✕" clear button when a key is stored.
// Leaving the input blank on save preserves the existing key; clicking "✕" removes it.

/** Providers whose keys the user explicitly cleared in this settings session. */
const _clearKeys = new Set<string>();

/** The settings that were loaded when the settings panel was last opened. */
let _loadedSettings: ReviewSettings = { ...DEFAULT_SETTINGS };

/** Render key-field status for one provider. Never populates the input value. */
function applyKeyStatus(provider: string, hasKey: boolean): void {
  const statusEl  = document.getElementById(`${provider}-key-status`);
  const clearBtn  = document.getElementById(`${provider}-clear-key`) as HTMLButtonElement | null;
  const inputEl   = document.querySelector<HTMLInputElement>(`#${provider}-key-input`);
  const placeholder = KEY_PLACEHOLDERS[provider] ?? 'API key';

  if (statusEl) {
    statusEl.textContent = hasKey ? '✓ Saved' : '';
    statusEl.className   = `key-status${hasKey ? ' saved' : ''}`;
  }
  if (clearBtn)  clearBtn.hidden = !hasKey;
  if (inputEl) {
    inputEl.value       = '';                                                    // never expose the key
    inputEl.placeholder = hasKey ? 'Leave blank to keep · or enter a new key' : placeholder;
  }
}

/**
 * Read a provider's key from the UI.
 * - If the user typed something → use it.
 * - If the user explicitly clicked "✕ Clear" → return undefined (removes the key).
 * - Otherwise (input left empty) → preserve the key from storage.
 */
function readKeyFromUI(inputId: string, provider: string, existingKey?: string): string | undefined {
  if (_clearKeys.has(provider)) return undefined;
  const el    = document.querySelector<HTMLInputElement>(`#${inputId}`);
  const typed = el?.value.trim();
  return typed || existingKey || undefined;
}

// ─── Provider / count field visibility ───────────────────────────────────────

/**
 * The count field applies in every mode, so it is always visible. Only its
 * caption changes: in 'recent' it is the primary control (the newest N), in
 * every other mode it is a safety ceiling on how much is collected.
 */
function updateCountFieldCaption(mode: ReviewSettings['reviewMode']): void {
  const hint = document.getElementById('review-count-hint');
  if (!hint) return;
  hint.textContent = mode === 'recent'
    ? 'How many of the newest reviews to analyze.'
    : 'Upper limit on how many reviews to collect.';
}

function updateProviderVisibility(provider: ReviewSettings['aiProvider']): void {
  ALL_PROVIDERS.forEach((p) => {
    const el = document.getElementById(`${p}-config`);
    if (el) el.hidden = p !== provider;
  });
}

// ─── Slider helper ────────────────────────────────────────────────────────────

function setSlider(inputId: string, valId: string, value: number): void {
  const input = document.querySelector<HTMLInputElement>(`#${inputId}`);
  const label = document.getElementById(valId);
  if (input) input.value = String(value);
  if (label) label.textContent = String(value);
}

// ─── Model parameters (shared by every local provider) ───────────────────────
//
// Ollama and any OpenAI-compatible local server expose the same knobs, so the
// same markup and the same code drive both — only the element-id prefix differs.

function applyParamsToUI(prefix: string, params: ModelParams | undefined): void {
  const p = params ?? {};
  setSlider(`${prefix}-temp`, `${prefix}-temp-val`, p.temperature   ?? AI_DEFAULTS.OLLAMA_TEMPERATURE);
  setSlider(`${prefix}-topp`, `${prefix}-topp-val`, p.topP          ?? AI_DEFAULTS.OLLAMA_TOP_P);
  setSlider(`${prefix}-rp`,   `${prefix}-rp-val`,   p.repeatPenalty ?? AI_DEFAULTS.OLLAMA_REPEAT_PENALTY);
  const topkEl   = document.querySelector<HTMLInputElement>(`#${prefix}-topk`);
  const numctxEl = document.querySelector<HTMLInputElement>(`#${prefix}-numctx`);
  if (topkEl)   topkEl.value   = String(p.topK   ?? AI_DEFAULTS.OLLAMA_TOP_K);
  if (numctxEl) numctxEl.value = String(p.numCtx ?? AI_DEFAULTS.OLLAMA_NUM_CTX);
}

function readParamsFromUI(prefix: string): ModelParams {
  const num = (id: string, fallback: number, int = false): number => {
    const el = document.querySelector<HTMLInputElement>(`#${id}`);
    if (!el) return fallback;
    const v = int ? parseInt(el.value, 10) : parseFloat(el.value);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    temperature:   num(`${prefix}-temp`,   AI_DEFAULTS.OLLAMA_TEMPERATURE),
    topP:          num(`${prefix}-topp`,   AI_DEFAULTS.OLLAMA_TOP_P),
    repeatPenalty: num(`${prefix}-rp`,     AI_DEFAULTS.OLLAMA_REPEAT_PENALTY),
    topK:          num(`${prefix}-topk`,   AI_DEFAULTS.OLLAMA_TOP_K,   true),
    numCtx:        num(`${prefix}-numctx`, AI_DEFAULTS.OLLAMA_NUM_CTX, true),
  };
}

// ─── Apply / read settings ────────────────────────────────────────────────────

/**
 * Select a stored model, adding it as an option first when the curated list
 * lacks it (one picked from a refreshed model list). A <select> otherwise
 * blanks the value, and the next save would quietly fall back to the default.
 */
function setModelSelect(id: string, model: string): void {
  const select = document.querySelector<HTMLSelectElement>(`#${id}`);
  if (!select) return;
  if (!Array.from(select.options).some((o) => o.value === model)) select.add(new Option(model, model));
  select.value = model;
}

function applySettingsToUI(settings: ReviewSettings): void {
  _loadedSettings = { ...settings };

  // Review scope buttons
  document.querySelectorAll<HTMLElement>('#review-mode-group .scope-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === settings.reviewMode);
  });
  const countInput = document.querySelector<HTMLInputElement>('#review-count-input');
  if (countInput) countInput.value = String(settings.reviewCount);
  updateCountFieldCaption(settings.reviewMode);

  // Analysis depth + output language
  document.querySelectorAll<HTMLElement>('#analysis-depth-group .scope-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === (settings.analysisDepth ?? AI_DEFAULTS.ANALYSIS_DEPTH));
  });
  const langEl = document.querySelector<HTMLSelectElement>('#output-language-select');
  if (langEl) langEl.value = settings.outputLanguage ?? AI_DEFAULTS.OUTPUT_LANGUAGE;

  const ollamaEndpointEl = document.querySelector<HTMLInputElement>('#ollama-endpoint-input');
  if (ollamaEndpointEl) ollamaEndpointEl.value = settings.ollamaEndpoint ?? AI_DEFAULTS.OLLAMA_ENDPOINT;

  // Provider buttons
  document.querySelectorAll<HTMLElement>('#ai-provider-group .scope-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === (settings.aiProvider ?? 'ollama'));
  });
  updateProviderVisibility(settings.aiProvider ?? 'ollama');

  // ── Ollama ──────────────────────────────────────────────────────────────────
  setModelSelect('ollama-model-select', settings.ollamaModel ?? DEFAULT_SETTINGS.ollamaModel ?? AI_DEFAULTS.OLLAMA_MODEL);

  applyParamsToUI('ollama', settings.ollamaParams);
  applyParamsToUI('custom', settings.customParams);

  const extraEl = document.querySelector<HTMLInputElement>('#custom-extra-params');
  if (extraEl) extraEl.checked = settings.customSendExtraParams !== false;

  // ── Model selects / inputs (non-key) ────────────────────────────────────────
  setModelSelect('openai-model-select', settings.openaiModel ?? DEFAULT_SETTINGS.openaiModel ?? 'gpt-4o-mini');

  const anthropicModelEl = document.querySelector<HTMLInputElement>('#anthropic-model-input');
  if (anthropicModelEl) anthropicModelEl.value = settings.anthropicModel ?? DEFAULT_SETTINGS.anthropicModel ?? '';

  setModelSelect('gemini-model-select', settings.geminiModel ?? DEFAULT_SETTINGS.geminiModel ?? 'gemini-2.0-flash');
  setModelSelect('groq-model-select',   settings.groqModel   ?? DEFAULT_SETTINGS.groqModel   ?? 'llama-3.3-70b-versatile');
  setModelSelect('xai-model-select',    settings.xaiModel    ?? DEFAULT_SETTINGS.xaiModel    ?? 'grok-3-mini-latest');

  const customEndpointEl = document.querySelector<HTMLInputElement>('#custom-endpoint-input');
  if (customEndpointEl) customEndpointEl.value = settings.customEndpoint ?? '';
  const customModelEl = document.querySelector<HTMLInputElement>('#custom-model-input');
  if (customModelEl) customModelEl.value = settings.customModel ?? '';

  // ── API key status (never expose the key itself) ─────────────────────────────
  applyKeyStatus('openai',    !!settings.openaiApiKey);
  applyKeyStatus('anthropic', !!settings.anthropicApiKey);
  applyKeyStatus('gemini',    !!settings.geminiApiKey);
  applyKeyStatus('groq',      !!settings.groqApiKey);
  applyKeyStatus('xai',       !!settings.xaiApiKey);
  applyKeyStatus('custom',    !!settings.customApiKey);
}

function readSettingsFromUI(): ReviewSettings {
  const activeScope    = document.querySelector<HTMLElement>('#review-mode-group .scope-btn.active');
  const activeProvider = document.querySelector<HTMLElement>('#ai-provider-group .scope-btn.active');
  const countInput     = document.querySelector<HTMLInputElement>('#review-count-input');

  const ollamaModelEl  = document.querySelector<HTMLSelectElement>('#ollama-model-select');

  const openaiModelEl    = document.querySelector<HTMLSelectElement>('#openai-model-select');
  const anthropicModelEl = document.querySelector<HTMLInputElement>('#anthropic-model-input');
  const geminiModelEl    = document.querySelector<HTMLSelectElement>('#gemini-model-select');
  const groqModelEl      = document.querySelector<HTMLSelectElement>('#groq-model-select');
  const xaiModelEl       = document.querySelector<HTMLSelectElement>('#xai-model-select');
  const customEndpointEl = document.querySelector<HTMLInputElement>('#custom-endpoint-input');
  const customModelEl    = document.querySelector<HTMLInputElement>('#custom-model-input');

  const activeDepth   = document.querySelector<HTMLElement>('#analysis-depth-group .scope-btn.active');
  const langEl        = document.querySelector<HTMLSelectElement>('#output-language-select');
  const ollamaEndEl   = document.querySelector<HTMLInputElement>('#ollama-endpoint-input');

  return {
    reviewMode:  (activeScope?.dataset.value    as ReviewSettings['reviewMode'])   ?? DEFAULT_SETTINGS.reviewMode,
    // Clamped at BOTH ends — the markup's max was previously unenforced on read.
    reviewCount: Math.min(
      SCROLL_CONFIG.MAX_REVIEWS_ALL,
      Math.max(10, Number(countInput?.value) || DEFAULT_SETTINGS.reviewCount)
    ),
    aiProvider:  (activeProvider?.dataset.value as ReviewSettings['aiProvider'])   ?? 'ollama',

    analysisDepth:  (activeDepth?.dataset.value as ReviewSettings['analysisDepth']) ?? AI_DEFAULTS.ANALYSIS_DEPTH,
    outputLanguage: langEl?.value || AI_DEFAULTS.OUTPUT_LANGUAGE,

    ollamaEndpoint: ollamaEndEl?.value.trim() || AI_DEFAULTS.OLLAMA_ENDPOINT,
    ollamaModel: ollamaModelEl?.value.trim() || DEFAULT_SETTINGS.ollamaModel,
    ollamaParams: readParamsFromUI('ollama'),

    // API keys: blank = keep existing, explicit clear = remove
    openaiApiKey:    readKeyFromUI('openai-key-input',    'openai',    _loadedSettings.openaiApiKey),
    openaiModel:     openaiModelEl?.value    || DEFAULT_SETTINGS.openaiModel,

    anthropicApiKey: readKeyFromUI('anthropic-key-input', 'anthropic', _loadedSettings.anthropicApiKey),
    anthropicModel:  anthropicModelEl?.value.trim() || DEFAULT_SETTINGS.anthropicModel,

    geminiApiKey:    readKeyFromUI('gemini-key-input',    'gemini',    _loadedSettings.geminiApiKey),
    geminiModel:     geminiModelEl?.value    || DEFAULT_SETTINGS.geminiModel,

    groqApiKey:      readKeyFromUI('groq-key-input',      'groq',      _loadedSettings.groqApiKey),
    groqModel:       groqModelEl?.value      || DEFAULT_SETTINGS.groqModel,

    xaiApiKey:       readKeyFromUI('xai-key-input',       'xai',       _loadedSettings.xaiApiKey),
    xaiModel:        xaiModelEl?.value       || DEFAULT_SETTINGS.xaiModel,

    customEndpoint:  customEndpointEl?.value.trim() || undefined,
    customApiKey:    readKeyFromUI('custom-key-input', 'custom', _loadedSettings.customApiKey),
    customModel:     customModelEl?.value.trim() || undefined,
    customParams:    readParamsFromUI('custom'),
    customSendExtraParams:
      document.querySelector<HTMLInputElement>('#custom-extra-params')?.checked !== false,
  };
}

/**
 * A user-supplied endpoint (custom provider, or a remote Ollama) can live on any
 * host, which the narrow install-time host_permissions do not cover. Request it
 * at save time instead.
 *
 * Must be the FIRST await in a click handler — chrome.permissions.request needs
 * the user gesture still to be active. It resolves true without prompting when
 * the permission is already granted, so no contains() pre-check.
 */
async function ensureEndpointPermission(rawUrl?: string): Promise<void> {
  if (!rawUrl) return;
  try {
    const { origin, hostname } = new URL(rawUrl);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return;
    await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    // Malformed URL, or the user declined — the call itself surfaces a clear error.
  }
}

/** Request host permission for whichever endpoints these settings will contact. */
async function ensureSettingsPermissions(settings: ReviewSettings): Promise<void> {
  if (settings.aiProvider === 'custom') await ensureEndpointPermission(settings.customEndpoint);
  if (settings.aiProvider === 'ollama') await ensureEndpointPermission(settings.ollamaEndpoint);
}

// ─── Connection test / model picker ──────────────────────────────────────────

function setTestStatus(provider: string, text: string, state: 'idle' | 'busy' | 'ok' | 'fail'): void {
  const el = document.getElementById(`${provider}-test-status`);
  if (!el) return;
  el.textContent = text;
  el.className = `test-status${state === 'idle' ? '' : ` test-${state}`}`;
}

/**
 * Fill a provider's model picker from the models it actually reports. A text
 * field gets them as datalist suggestions; a curated <select> is rebuilt from
 * the live list, so models released after this build become selectable.
 */
function renderModelOptions(provider: string, models: string[]): void {
  const select = document.querySelector<HTMLSelectElement>(`select#${provider}-model-select`);
  if (select) {
    // Curated labels survive for models the list already had, and the current
    // choice is kept even if the provider no longer lists it — a <select>
    // silently blanks a value it has no option for. That leftover is labelled,
    // so it is not mistaken for a model the provider offers.
    const labels = new Map(
      Array.from(select.options).filter((o) => !o.dataset.unlisted).map((o) => [o.value, o.text])
    );
    const current = select.value;
    const options = models.map((m) => new Option(labels.get(m) ?? m, m));
    if (current && !models.includes(current)) {
      const leftover = new Option(`${current} (${provider === 'ollama' ? 'not installed' : 'not listed'})`, current);
      leftover.dataset.unlisted = 'true';
      options.unshift(leftover);
    }
    select.replaceChildren(...options);
    select.value = current;
    return;
  }

  const list = document.getElementById(`${provider}-model-list`);
  if (!list) return;
  list.innerHTML = models
    .map((m) => `<option value="${m.replace(/"/g, '&quot;')}"></option>`)
    .join('');
}

type ConnectionResult = Extract<MessageType, { type: 'CONNECTION_RESULT' }>['payload'];

/** One TEST_CONNECTION round-trip, with messaging failures folded into the result. */
async function requestConnectionTest(settings: ReviewSettings): Promise<ConnectionResult> {
  try {
    const response = await sendRuntimeMessage({
      type: 'TEST_CONNECTION',
      payload: { settings },
    } satisfies MessageType);
    return response.type === 'CONNECTION_RESULT'
      ? response.payload
      : { ok: false, message: 'Unexpected response' };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/**
 * Point the Ollama picker at an installed model when the chosen one is not. It
 * could only fail with "model not found", and the default is rarely installed.
 * A bare name matches its :latest tag. Returns the name switched away from.
 */
function selectInstalledOllamaModel(models: string[]): string | undefined {
  const select = document.querySelector<HTMLSelectElement>('#ollama-model-select');
  const current = select?.value ?? '';
  if (!select || models.length === 0 || models.includes(current)) return undefined;

  const tagged = models.find((m) => m === `${current}:latest`);
  // Same model under its full name — drop the "not installed" leftover for it.
  if (tagged) select.querySelector('option[data-unlisted]')?.remove();
  select.value = tagged ?? models[0];
  return tagged || !current ? undefined : current;
}

/**
 * Validate the current provider's credentials/endpoint without running a scrape.
 * The same round-trip returns the provider's model list, which populates its
 * model picker. 'refresh' re-runs it just to reload that list; 'auto' loads it
 * quietly when Settings opens — no "Testing…" flash, and a server that is not
 * running is only reported once the user asks.
 */
async function runConnectionTest(provider: string, mode: 'test' | 'refresh' | 'auto' = 'test'): Promise<void> {
  const settings = readSettingsFromUI();
  const refreshBtn = document.querySelector<HTMLButtonElement>(`.refresh-models-btn[data-provider="${provider}"]`);
  if (mode !== 'auto') setTestStatus(provider, mode === 'refresh' ? 'Refreshing model list…' : 'Testing…', 'busy');
  if (refreshBtn) refreshBtn.disabled = true;

  const { ok, message, models } = await requestConnectionTest(settings);

  if (refreshBtn) refreshBtn.disabled = false;
  if (!ok && mode === 'auto') return;
  // The list can only be reloaded from a server that just answered.
  if (refreshBtn) refreshBtn.hidden = !ok;

  let status = ok && mode === 'refresh'
    ? (models?.length ? `Model list updated · ${models.length} models` : 'Connected · no models reported')
    : message;
  if (ok && models?.length) {
    renderModelOptions(provider, models);
    const missing = provider === 'ollama' ? selectInstalledOllamaModel(models) : undefined;
    if (missing) {
      const chosen = document.querySelector<HTMLSelectElement>('#ollama-model-select')?.value;
      status = `${status}. ${missing} isn't installed — switched to ${chosen}; Save to keep it.`;
    }
  }
  setTestStatus(provider, status, ok ? 'ok' : 'fail');
}

/**
 * Restore every default EXCEPT the stored API keys. Keys are encrypted at rest
 * and never re-displayed, so wiping them would be unrecoverable for the user —
 * the per-key ✕ button remains the way to remove one deliberately.
 */
async function resetSettingsToDefaults(): Promise<void> {
  const current = await getSettings();
  const preserved: ReviewSettings = { ...DEFAULT_SETTINGS };
  for (const field of API_KEY_FIELDS) {
    const val = current[field];
    if (typeof val === 'string' && val.length > 0) {
      (preserved as unknown as Record<string, unknown>)[field] = val;
    }
  }
  // Endpoints are not secrets, but they are laborious to retype — keep them.
  preserved.customEndpoint = current.customEndpoint;

  await saveSettings(preserved);
  _clearKeys.clear();
  applySettingsToUI(preserved);
}

// ─── Open settings ────────────────────────────────────────────────────────────

async function openSettings(): Promise<void> {
  _clearKeys.clear();                          // reset any pending clears from last session
  const settings = await getSettings();
  applySettingsToUI(settings);
  openOverlay('settings');
  // A local Ollama answers instantly and for free, so show its installed models
  // straight away instead of the stored name alone.
  if ((settings.aiProvider ?? 'ollama') === 'ollama') void runConnectionTest('ollama', 'auto');
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: SummaryResult;
  timestamp: number;
}

interface ReviewCacheEntry {
  reviews: Review[];
  placeName: string;
  googleRating?: number;
  googleReviewCount?: number;
  /** Ceiling this set was scraped under — a larger request must re-scrape. */
  maxReviews: number;
  timestamp: number;
}

const SUMMARY_CACHE_KEY = 'gReviewSummCache';
const REVIEW_CACHE_KEY  = 'gReviewSummReviewCache';

/**
 * Stable identifier for the place shown in the current tab.
 *
 * Using only origin + pathname collapsed EVERY google.com/search knowledge
 * panel onto the single key "https://www.google.com/search", so the second
 * business analyzed was served the first business's summary.
 */
function placeKey(url: string, placeName?: string): string {
  try {
    const u = new URL(url);
    // Maps URLs carry the place in the pathname (/maps/place/<name>/@lat,lng…).
    if (u.pathname.startsWith('/maps')) return `${u.origin}${u.pathname}`;
    const q = u.searchParams.get('q');
    if (q) return `${u.origin}${u.pathname}?q=${q}`;
    return placeName ? `${u.origin}${u.pathname}#${placeName}` : `${u.origin}${u.pathname}`;
  } catch {
    return placeName ? `${url}#${placeName}` : url;
  }
}

/** The model actually in use for the selected provider. */
function activeModel(s: ReviewSettings): string {
  switch (s.aiProvider) {
    case 'openai':    return s.openaiModel    ?? AI_DEFAULTS.OPENAI_MODEL;
    case 'anthropic': return s.anthropicModel ?? AI_DEFAULTS.ANTHROPIC_MODEL;
    case 'gemini':    return s.geminiModel    ?? AI_DEFAULTS.GEMINI_MODEL;
    case 'groq':      return s.groqModel      ?? AI_DEFAULTS.GROQ_MODEL;
    case 'xai':       return s.xaiModel       ?? AI_DEFAULTS.XAI_MODEL;
    case 'custom':    return s.customModel    ?? 'local-model';
    default:          return s.ollamaModel    ?? AI_DEFAULTS.OLLAMA_MODEL;
  }
}

/**
 * Summary cache key.
 *
 * Must include EVERY setting that changes the produced summary, otherwise
 * showInfoScreen renders a stale result after the user changes that setting.
 * That covers provider, model, scope — and also output language and analysis
 * depth, both of which feed the prompt (languageRule / ANALYSIS_DEPTHS), and
 * the Ollama endpoint, since the same model name on a different server is a
 * different model.
 */
function summaryKey(url: string, s: ReviewSettings, placeName?: string): string {
  const endpoint = s.aiProvider === 'ollama' ? (s.ollamaEndpoint ?? AI_DEFAULTS.OLLAMA_ENDPOINT)
                 : s.aiProvider === 'custom' ? (s.customEndpoint ?? '')
                 : '';
  return [
    placeKey(url, placeName),
    s.aiProvider ?? 'ollama',
    activeModel(s),
    endpoint,
    s.reviewMode,
    s.analysisDepth  ?? AI_DEFAULTS.ANALYSIS_DEPTH,
    s.outputLanguage ?? AI_DEFAULTS.OUTPUT_LANGUAGE,
  ].join('::');
}

function readStore<T>(storeKey: string): Promise<Record<string, T>> {
  return new Promise((resolve) => {
    chrome.storage.local.get([storeKey], (data) => {
      resolve(((data as Record<string, unknown>)[storeKey] ?? {}) as Record<string, T>);
    });
  });
}

function writeStore<T>(storeKey: string, map: Record<string, T>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [storeKey]: map }, resolve);
  });
}

/** Drop expired entries and cap the map, newest first. */
function prune<T extends { timestamp: number }>(map: Record<string, T>): Record<string, T> {
  const now = Date.now();
  const live = Object.entries(map)
    .filter(([, e]) => now - e.timestamp <= CACHE_CONFIG.TTL_MS)
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, CACHE_CONFIG.MAX_ENTRIES);
  return Object.fromEntries(live) as Record<string, T>;
}

async function getCachedResult(url: string, settings: ReviewSettings, placeName?: string): Promise<CacheEntry | null> {
  const cache = await readStore<CacheEntry>(SUMMARY_CACHE_KEY);
  const pruned = prune(cache);
  // Evict expired entries on read — they used to linger forever.
  if (Object.keys(pruned).length !== Object.keys(cache).length) {
    await writeStore(SUMMARY_CACHE_KEY, pruned);
  }
  return pruned[summaryKey(url, settings, placeName)] ?? null;
}

async function setCachedResult(url: string, settings: ReviewSettings, result: SummaryResult): Promise<void> {
  const cache = await readStore<CacheEntry>(SUMMARY_CACHE_KEY);
  cache[summaryKey(url, settings, result.placeName)] = { result, timestamp: Date.now() };
  await writeStore(SUMMARY_CACHE_KEY, prune(cache));
}

/**
 * Review-cache key. Includes the sort order: a set collected in Maps' relevance
 * order is NOT interchangeable with one collected newest-first, and reusing the
 * wrong one would make 'recent' slice the most-relevant N instead of the newest.
 */
function reviewKey(url: string, sortBy: ReviewSort, placeName?: string): string {
  return `${placeKey(url, placeName)}::${sortBy}`;
}

async function getCachedReviews(
  url: string,
  maxReviews: number,
  sortBy: ReviewSort,
  placeName?: string
): Promise<ReviewCacheEntry | null> {
  const cache = await readStore<ReviewCacheEntry>(REVIEW_CACHE_KEY);
  const entry = prune(cache)[reviewKey(url, sortBy, placeName)];
  if (!entry) return null;
  // A larger request than the cached set was scraped under must re-scrape.
  if (entry.maxReviews < maxReviews && entry.reviews.length >= entry.maxReviews) return null;
  return entry;
}

async function setCachedReviews(url: string, sortBy: ReviewSort, entry: ReviewCacheEntry): Promise<void> {
  const cache = await readStore<ReviewCacheEntry>(REVIEW_CACHE_KEY);
  cache[reviewKey(url, sortBy, entry.placeName)] = entry;
  await writeStore(REVIEW_CACHE_KEY, prune(cache));
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function getAllCacheEntries(): Promise<Array<{ key: string; entry: CacheEntry }>> {
  const cache = await readStore<CacheEntry>(SUMMARY_CACHE_KEY);
  return Object.entries(prune(cache))
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => b.entry.timestamp - a.entry.timestamp);
}

async function deleteHistoryEntry(key: string): Promise<void> {
  const cache = await readStore<CacheEntry>(SUMMARY_CACHE_KEY);
  delete cache[key];
  await writeStore(SUMMARY_CACHE_KEY, cache);
}

async function clearAllHistory(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove([SUMMARY_CACHE_KEY, REVIEW_CACHE_KEY], () => resolve());
  });
}

async function showHistory(): Promise<void> {
  const entries = await getAllCacheEntries();
  const list = document.getElementById('history-list');
  if (!list) return;

  if (entries.length === 0) {
    list.innerHTML = '<p class="history-empty">No analyzed places yet.</p>';
    openOverlay('history');
    return;
  }

  const sentimentColors: Record<SummaryResult['overallSentiment'], string> = {
    positive: 'sentiment-positive',
    negative: 'sentiment-negative',
    neutral:  'sentiment-neutral',
    mixed:    'sentiment-mixed',
  };

  list.innerHTML = entries.map(({ key, entry }) => {
    const r = entry.result;
    const stars = '★'.repeat(Math.floor(r.averageRating)) + (r.averageRating % 1 >= 0.5 ? '½' : '');
    const cls = sentimentColors[r.overallSentiment] ?? '';
    return `
      <div class="history-item ${cls}" data-key="${encodeURIComponent(key)}">
        <div style="min-width:0">
          <div class="history-item-name">${r.placeName}</div>
          <div class="history-item-meta">
            <span class="history-stars">${stars}</span>
            <span>${r.averageRating}</span>
            <span>·</span>
            <span>${r.totalReviews.toLocaleString()} reviews</span>
            <span>·</span>
            <span>${timeAgo(entry.timestamp)}</span>
          </div>
        </div>
        <button class="history-delete" data-key="${encodeURIComponent(key)}" title="Remove">✕</button>
      </div>`;
  }).join('');

  openOverlay('history');
}

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendTabMessage(tabId: number, message: MessageType): Promise<MessageType> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message ?? 'Unknown error');
        return;
      }
      if (!response) { reject('No response from content script'); return; }
      resolve(response as MessageType);
    });
  });
}

async function sendToTab(tabId: number, message: MessageType): Promise<MessageType> {
  try {
    return await sendTabMessage(tabId, message);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection')) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise<void>((r) => setTimeout(r, 300));
      return sendTabMessage(tabId, message);
    }
    throw err;
  }
}

function sendRuntimeMessage(message: MessageType): Promise<MessageType> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: MessageType | undefined) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message ?? 'Background error');
        return;
      }
      if (!response) { reject('No response from background'); return; }
      resolve(response);
    });
  });
}

// ─── Render result ────────────────────────────────────────────────────────────

const sentimentLabel: Record<SummaryResult['overallSentiment'], string> = {
  positive: '😊 Mostly Positive',
  negative: '😞 Mostly Negative',
  neutral:  '😐 Neutral',
  mixed:    '🤔 Mixed Reviews',
};

const sentimentClass: Record<SummaryResult['overallSentiment'], string> = {
  positive: 'sentiment-positive',
  negative: 'sentiment-negative',
  neutral:  'sentiment-neutral',
  mixed:    'sentiment-mixed',
};

function renderStars(rating: number): string {
  const full  = Math.floor(rating);
  const half  = rating % 1 >= 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

function renderResult(data: SummaryResult, timestamp?: number): void {
  const placeName  = $('[data-field="place-name"]');
  const sentiment  = $('[data-field="sentiment"]');
  const starsEl    = $('[data-field="stars"]');
  const ratingEl   = $('[data-field="rating"]');
  const reviewCount = $('[data-field="review-count"]');
  const summaryEl  = $('[data-field="summary"]');
  const prosList   = $('[data-field="pros"]');
  const consList   = $('[data-field="cons"]');
  const themesList = $('[data-field="themes"]');
  const analyzedAt = document.getElementById('analyzed-at');

  if (placeName) placeName.textContent = data.placeName;

  if (sentiment) {
    sentiment.textContent = sentimentLabel[data.overallSentiment];
    sentiment.className   = `sentiment-badge ${sentimentClass[data.overallSentiment]}`;
  }

  if (starsEl)    starsEl.textContent    = renderStars(data.averageRating);
  if (ratingEl)   ratingEl.textContent   = `${data.averageRating} / 5`;
  if (reviewCount) {
    const { analyzedCount: a, collectedCount: c } = data;
    reviewCount.textContent =
      a !== undefined && c !== undefined && a < c
        ? `${a.toLocaleString()} of ${c.toLocaleString()} reviews analyzed`
        : `${(c ?? data.totalReviews).toLocaleString()} reviews analyzed`;
  }
  if (summaryEl)  summaryEl.textContent  = data.summary;

  if (prosList) {
    prosList.innerHTML = data.pros
      .map((p) => `<li><span class="bullet pro-bullet">✓</span>${p}</li>`)
      .join('');
  }

  if (consList) {
    consList.innerHTML = data.cons
      .map((c) => `<li><span class="bullet con-bullet">✗</span>${c}</li>`)
      .join('');
  }

  if (themesList) {
    themesList.innerHTML = data.topThemes
      .map((t) => `<span class="theme-chip">${t}</span>`)
      .join('');
  }

  const staffSection = document.getElementById('staff-section');
  const staffList    = $('[data-field="staff"]');
  const staff        = data.notableStaff ?? [];
  if (staffSection) staffSection.hidden = staff.length === 0;
  if (staffList) {
    staffList.innerHTML = staff
      .map((name) => `<span class="staff-chip">★ ${name}</span>`)
      .join('');
  }

  if (analyzedAt) {
    analyzedAt.textContent = timestamp ? `Analyzed ${timeAgo(timestamp)}` : '';
  }

  // parseReviewDate only understands English relative dates, so on a non-English
  // Maps locale a time-window scope quietly behaves like "all". Say so.
  const warnEl = document.getElementById('result-warning');
  if (warnEl) {
    warnEl.textContent = data.dateParseWarning ?? '';
    warnEl.hidden = !data.dateParseWarning;
  }
}

// ─── Cancellation ────────────────────────────────────────────────────────────

let analysisCancelled = false;

/** Set by "Analyze anyway", so the provider check asks only once per popup. */
let providerCheckOverridden = false;

async function cancelAnalysis(): Promise<void> {
  analysisCancelled = true;
  stopProgressPoll();
  stopAllStepTimers();
  try {
    if (currentTabId) {
      await sendToTab(currentTabId, { type: 'STOP_REVIEWS' } satisfies MessageType);
    }
  } catch { /* tab may have closed */ }
  await showHome();
}

async function stopGathering(): Promise<void> {
  stopProgressPoll();
  try {
    if (currentTabId) {
      await sendToTab(currentTabId, { type: 'STOP_REVIEWS' } satisfies MessageType);
    }
  } catch { /* tab may have closed */ }
}

// ─── Progress polling ─────────────────────────────────────────────────────────

let progressPollInterval: ReturnType<typeof setInterval> | null = null;

function startProgressPoll(tabId: number): void {
  progressPollInterval = setInterval(async () => {
    try {
      const response = await sendTabMessage(tabId, { type: 'GET_PROGRESS' } satisfies MessageType);
      if (response.type === 'PROGRESS') {
        const d1 = document.getElementById('step-1-detail');
        if (d1) d1.textContent = `${response.payload.count.toLocaleString()} reviews found`;
      }
    } catch { /* tab not ready yet */ }
  }, POPUP_CONFIG.PROGRESS_POLL_MS);
}

function stopProgressPoll(): void {
  if (progressPollInterval !== null) {
    clearInterval(progressPollInterval);
    progressPollInterval = null;
  }
}

// ─── Loading steps ────────────────────────────────────────────────────────────

const stepStartTimes: Partial<Record<1 | 2, number>> = {};
const stepIntervals:  Partial<Record<1 | 2, ReturnType<typeof setInterval>>> = {};

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function startStepTimer(step: 1 | 2): void {
  stepStartTimes[step] = Date.now();
  const el = document.getElementById(`step-${step}-time`);
  if (el) el.textContent = '0s';
  stepIntervals[step] = setInterval(() => {
    const elapsed = Date.now() - (stepStartTimes[step] ?? Date.now());
    if (el) el.textContent = formatElapsed(elapsed);
  }, 1000);
}

function stopStepTimer(step: 1 | 2): void {
  clearInterval(stepIntervals[step]);
  delete stepIntervals[step];
  const elapsed = Date.now() - (stepStartTimes[step] ?? Date.now());
  const el = document.getElementById(`step-${step}-time`);
  if (el) el.textContent = formatElapsed(elapsed);
}

function stopAllStepTimers(): void {
  ([1, 2] as const).forEach((s) => { if (stepIntervals[s]) stopStepTimer(s); });
}

/** Step 1's sub-label once the scroll is actually running. */
const SCROLL_STEP_DETAIL = 'Scrolling through reviews…';

/** Change a step's sub-label without restarting its timer. */
function setStepDetail(step: 1 | 2, detail: string): void {
  const el = document.getElementById(`step-${step}-detail`);
  if (el) el.textContent = detail;
}

function setLoadingStep(step: 1 | 2, detail?: string): void {
  const s1 = document.getElementById('step-1');
  const s2 = document.getElementById('step-2');
  const d1 = document.getElementById('step-1-detail');
  const d2 = document.getElementById('step-2-detail');
  const summarizeNowBtn = document.getElementById('summarize-now-btn') as HTMLButtonElement | null;

  if (step === 1) {
    s1?.classList.replace('step-pending', 'step-active') || s1?.classList.add('step-active');
    s2?.classList.add('step-pending');
    if (d1) d1.textContent = detail ?? SCROLL_STEP_DETAIL;
    if (summarizeNowBtn) summarizeNowBtn.hidden = false;
    startStepTimer(1);
  } else {
    stopStepTimer(1);
    s1?.classList.remove('step-active');
    s1?.classList.add('step-done');
    const dot1 = s1?.querySelector('.step-dot');
    if (dot1) dot1.textContent = '✓';
    if (d1 && detail) d1.textContent = detail;
    s2?.classList.replace('step-pending', 'step-active') || s2?.classList.add('step-active');
    if (d2) d2.textContent = 'Summarizing with AI…';
    if (summarizeNowBtn) summarizeNowBtn.hidden = true;
    startStepTimer(2);
  }
}

// ─── Info screen ──────────────────────────────────────────────────────────────

let currentTabUrl = '';
let currentTabId  = 0;
let currentPlaceName: string | undefined;

/** Returns true when the active tab is a supported Google Maps / Search page. */
function isSupportedPage(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      hostname === 'maps.google.com' ||
      (hostname === 'www.google.com' && (
        pathname.startsWith('/maps') ||
        pathname.startsWith('/search')
      ))
    );
  } catch {
    return false;
  }
}

/**
 * Load the current tab's place into the info screen, then show the home screen.
 * Runs once per popup open: GET_BASIC_INFO can switch the page's tabs, so later
 * navigation goes through showHome, which never messages the tab.
 */
async function showInfoScreen(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab.url ?? '';
  currentTabId  = tab.id ?? 0;

  if (!isSupportedPage(currentTabUrl)) { showHomeScreen('wrong-page'); return; }

  if (!currentTabId) { showError('Cannot access current tab.'); return; }

  try {
    const response = await sendToTab(currentTabId, { type: 'GET_BASIC_INFO' } satisfies MessageType);
    if (response.type === 'BASIC_INFO') {
      const { placeName, googleRating, googleReviewCount, category, address, phone } = response.payload;

      const nameEl  = $('[data-field="info-place-name"]');
      const starsEl = $('[data-field="info-stars"]');
      const ratingEl = $('[data-field="info-rating"]');
      const countEl = $('[data-field="info-review-count"]');
      currentPlaceName = placeName;
      if (nameEl)   nameEl.textContent   = placeName;
      if (starsEl)  starsEl.textContent  = googleRating ? renderStars(googleRating) : '';
      if (ratingEl) ratingEl.textContent = googleRating ? `${googleRating} / 5` : '';
      if (countEl)  countEl.textContent  = googleReviewCount ? `${googleReviewCount.toLocaleString()} reviews` : '';

      const catEl = $('[data-field="info-category"]');
      if (catEl) { catEl.textContent = category ?? ''; catEl.hidden = !category; }

      const addrRow = $('[data-field="info-address"]');
      if (addrRow) {
        const t = addrRow.querySelector<HTMLElement>('.info-text');
        if (t) t.textContent = address ?? '';
        addrRow.hidden = !address;
      }

      const phoneRow = $('[data-field="info-phone"]');
      if (phoneRow) {
        const t = phoneRow.querySelector<HTMLElement>('.info-text');
        if (t) t.textContent = phone ?? '';
        phoneRow.hidden = !phone;
      }
    }
  } catch {
    const nameEl = $('[data-field="info-place-name"]');
    if (nameEl) nameEl.textContent = 'Open a business on Google Maps';
  }

  await showHome();
}

/** The current tab's cached summary if the settings have one, else the info screen. */
async function showHome(): Promise<void> {
  if (!isSupportedPage(currentTabUrl)) { showHomeScreen('wrong-page'); return; }

  const settings = await getSettings();
  const cached = await getCachedResult(currentTabUrl, settings, currentPlaceName);
  if (cached) { showHomeResult(cached); return; }

  showHomeScreen('info');
}

// ─── Analyze ──────────────────────────────────────────────────────────────────

async function runAnalyze(forceFresh = false): Promise<void> {
  analysisCancelled = false;
  // Always started by the user — including from Settings or a history entry.
  overlayReturn = null;
  setScreen('loading');
  setLoadingStep(1);
  const settings = await getSettings();

  if (!currentTabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tab.url ?? '';
    currentTabId  = tab.id ?? 0;
  }

  if (!currentTabId) { showError('Cannot access current tab.'); return; }

  // reviewCount is now the scrape ceiling in every mode, capped by MAX_REVIEWS_ALL.
  const maxReviews = Math.min(settings.reviewCount, SCROLL_CONFIG.MAX_REVIEWS_ALL);

  // 'all' keeps Maps' relevance order; every other scope is time-based and
  // needs the list sorted newest-first to mean what it says.
  const sortBy: ReviewSort = settings.reviewMode === 'all' ? 'relevance' : 'newest';

  let reviews: Review[];
  let placeName: string;
  let googleRating: number | undefined;
  let googleReviewCount: number | undefined;

  // Scrolling is the expensive half. Reuse a cached review set when one exists
  // so re-analyze and provider switches only pay for the AI call.
  const cachedReviews = forceFresh
    ? null
    : await getCachedReviews(currentTabUrl, maxReviews, sortBy, currentPlaceName);

  if (cachedReviews) {
    console.log(`[GReviewSumm] Reusing ${cachedReviews.reviews.length} cached reviews — skipping scrape`);
    ({ reviews, googleRating, googleReviewCount } = cachedReviews);
    // The page was read again when this popup opened; prefer that over the name
    // stored with the cached review set, which may predate a scraper fix.
    placeName = currentPlaceName || cachedReviews.placeName;
    setLoadingStep(2, `${reviews.length.toLocaleString()} reviews (cached)`);
  } else {
    // Scraping is the minute-long half, and it is wasted if the provider is
    // down or the key is wrong — that used to surface only after the scroll.
    // Every provider's model-list endpoint is free, so this costs one request.
    if (!providerCheckOverridden) {
      const label = providerLabel(settings);
      const summarizeNow = document.getElementById('summarize-now-btn') as HTMLButtonElement | null;
      if (summarizeNow) summarizeNow.hidden = true; // no scrape to cut short yet
      setStepDetail(1, `Checking ${label}…`);

      const connection = await requestConnectionTest(settings);
      if (analysisCancelled) return;

      if (!connection.ok) {
        // Offer to go ahead anyway: the test only proves the model list works,
        // and a local server can serve chat without exposing /models.
        const detail = connection.message.trim();
        showError(
          `${label} is not ready — no reviews were scraped. ` +
          `${/[.!?]$/.test(detail) ? detail : `${detail}.`} ` +
          'Fix it in ⚙ Settings, or analyze anyway.',
          { allowAnyway: true },
        );
        return;
      }

      setStepDetail(1, SCROLL_STEP_DETAIL);
      if (summarizeNow) summarizeNow.hidden = false;
    }

    startProgressPoll(currentTabId);

    let reviewsResponse: MessageType;
    try {
      reviewsResponse = await sendToTab(currentTabId, {
        type: 'GET_REVIEWS',
        maxReviews,
        sortBy,
        scrollConfig: {
          tabOpenWaitMs:     SCROLL_CONFIG.TAB_OPEN_WAIT_MS,
          pollIntervalMs:    SCROLL_CONFIG.POLL_INTERVAL_MS,
          scrollWaitMs:      SCROLL_CONFIG.SCROLL_WAIT_MS,
          moreReviewsWaitMs: SCROLL_CONFIG.MORE_REVIEWS_WAIT_MS,
          maxStableRounds:   SCROLL_CONFIG.MAX_STABLE_ROUNDS,
        },
      } satisfies MessageType);
    } catch (err) {
      stopProgressPoll();
      console.error('[GReviewSumm] Message error:', err);
      showError(`Extension error: ${err}. Make sure you're on Google Maps (google.com/maps) and the page has fully loaded.`);
      return;
    }

    stopProgressPoll();

    if (analysisCancelled) return;
    if (reviewsResponse.type === 'NO_REVIEWS') { showHomeScreen('no-reviews'); return; }
    if (reviewsResponse.type === 'ERROR')      { showError(reviewsResponse.payload); return; }
    if (reviewsResponse.type !== 'REVIEWS_DATA') {
      showError('Unexpected response while gathering reviews.');
      return;
    }

    ({ reviews, placeName, googleRating, googleReviewCount } = reviewsResponse.payload);
    console.log(`[GReviewSumm] Got ${reviews.length} reviews, Google rating: ${googleRating ?? 'n/a'}`);
    setLoadingStep(2, `${reviews.length.toLocaleString()} reviews collected`);

    await setCachedReviews(currentTabUrl, sortBy, {
      reviews, placeName, googleRating, googleReviewCount, maxReviews, timestamp: Date.now(),
    });
  }

  currentPlaceName = placeName;

  // Only rating and text ever reach the model. author is used solely for
  // scrape-time dedup and date only by the time-window scopes, so both are
  // dropped before crossing the message boundary.
  const needsDate = settings.reviewMode !== 'all' && settings.reviewMode !== 'recent';
  const payloadReviews: Review[] = reviews.map((r) => ({
    author: '',
    rating: r.rating,
    text: r.text,
    ...(needsDate && r.date !== undefined ? { date: r.date } : {}),
  }));

  let summaryResponse: MessageType;
  try {
    summaryResponse = await sendRuntimeMessage({
      type: 'SUMMARIZE',
      payload: { reviews: payloadReviews, placeName, settings, googleRating, googleReviewCount },
    } satisfies MessageType);
  } catch (err) {
    console.error('[GReviewSumm] Background error:', err);
    showError(`Failed to summarize: ${err}`);
    return;
  }

  if (analysisCancelled) return;
  if (summaryResponse.type === 'SUMMARY_RESULT') {
    const timestamp = Date.now();
    await setCachedResult(currentTabUrl, settings, summaryResponse.payload);
    showHomeResult({ result: summaryResponse.payload, timestamp });
  } else if (summaryResponse.type === 'ERROR') {
    showError(summaryResponse.payload);
  }
}

function showError(message: string, opts?: { allowAnyway?: boolean }): void {
  // Leaving them running kept an interval alive behind the error screen, and
  // the next analysis would overwrite its handle without clearing it.
  stopAllStepTimers();
  const errEl = $('[data-field="error-message"]');
  if (errEl) errEl.textContent = message;
  const anywayBtn = $('[data-action="analyze-anyway"]');
  if (anywayBtn) anywayBtn.hidden = !opts?.allowAnyway;
  showHomeScreen('error');
}

// ─── Event listeners ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();
  applySettingsToUI(settings);

  // Review scope buttons
  document.querySelectorAll<HTMLElement>('#review-mode-group .scope-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#review-mode-group .scope-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateCountFieldCaption(btn.dataset.value as ReviewSettings['reviewMode']);
    });
  });

  // AI provider buttons
  document.querySelectorAll<HTMLElement>('#ai-provider-group .scope-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ai-provider-group .scope-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateProviderVisibility(btn.dataset.value as ReviewSettings['aiProvider']);
      if (btn.dataset.value === 'ollama') void runConnectionTest('ollama', 'auto');
    });
  });

  // Analysis depth buttons — labels/hints sourced from ANALYSIS_DEPTHS so the
  // config stays the single source of truth for the presets.
  document.querySelectorAll<HTMLElement>('#analysis-depth-group .scope-btn').forEach((btn) => {
    const preset = ANALYSIS_DEPTHS[btn.dataset.value as keyof typeof ANALYSIS_DEPTHS];
    if (preset) {
      const label = btn.querySelector('.scope-label');
      const sub   = btn.querySelector('.scope-sub');
      if (label) label.textContent = preset.label;
      if (sub)   sub.textContent   = preset.hint;
    }
    btn.addEventListener('click', () => {
      document.querySelectorAll('#analysis-depth-group .scope-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Test connection — one button per provider panel — and the model-list
  // refresh that appears once a test succeeds. Both are the same round-trip.
  document.querySelectorAll<HTMLElement>('.test-conn-btn, .refresh-models-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.provider ?? '';
      if (provider === 'ollama' || provider === 'custom') {
        const settings = readSettingsFromUI();
        await ensureEndpointPermission(
          provider === 'ollama' ? settings.ollamaEndpoint : settings.customEndpoint
        );
      }
      await runConnectionTest(provider, btn.classList.contains('refresh-models-btn') ? 'refresh' : 'test');
    });
  });

  // Re-probe Ollama for its model list when the endpoint changes
  document.querySelector<HTMLInputElement>('#ollama-endpoint-input')
    ?.addEventListener('change', () => { void runConnectionTest('ollama'); });

  // Reset to defaults — two-click confirm, no window.confirm (blocked in popups)
  const resetBtn = document.getElementById('reset-settings-btn');
  let resetArmed = false;
  resetBtn?.addEventListener('click', async () => {
    if (!resetArmed) {
      resetArmed = true;
      resetBtn.textContent = 'Click again to confirm';
      resetBtn.classList.add('danger');
      setTimeout(() => {
        resetArmed = false;
        resetBtn.textContent = 'Reset to defaults';
        resetBtn.classList.remove('danger');
      }, 4000);
      return;
    }
    resetArmed = false;
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.classList.remove('danger');
    await resetSettingsToDefaults();
  });

  // Live slider labels for BOTH local providers — same knobs, same code.
  (['ollama', 'custom'] as const).forEach((prefix) => {
    (['temp', 'topp', 'rp'] as const).forEach((param) => {
      const slider = document.querySelector<HTMLInputElement>(`#${prefix}-${param}`);
      const valEl  = document.getElementById(`${prefix}-${param}-val`);
      slider?.addEventListener('input', () => { if (valEl) valEl.textContent = slider.value; });
    });
  });

  // Local-runtime presets — fill the endpoint so "use my own model" does not
  // require knowing each project's default port.
  const presetSelect = document.querySelector<HTMLSelectElement>('#custom-preset-select');
  presetSelect?.addEventListener('change', () => {
    const preset = LOCAL_PRESETS.find((x) => x.id === presetSelect.value);
    if (!preset) return;
    const endpointEl = document.querySelector<HTMLInputElement>('#custom-endpoint-input');
    if (endpointEl) endpointEl.value = preset.endpoint;
    setTestStatus('custom', `${preset.label} endpoint filled in — test it to load its models.`, 'idle');
    presetSelect.value = ''; // back to the "choose a preset" placeholder
  });

  // Re-probe the custom server for its model list when the endpoint changes
  document.querySelector<HTMLInputElement>('#custom-endpoint-input')
    ?.addEventListener('change', () => { void runConnectionTest('custom'); });

  // API key clear buttons — mark key for removal on next save
  document.querySelectorAll<HTMLElement>('.clear-key-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider ?? '';
      _clearKeys.add(provider);
      applyKeyStatus(provider, false);
    });
  });

  // History screen
  $('[data-action="open-history"]')?.addEventListener('click', () => showHistory());
  $('[data-action="back-from-history"]')?.addEventListener('click', () => closeOverlay());

  document.getElementById('clear-history-btn')?.addEventListener('click', async () => {
    await clearAllHistory();
    showHistory();
  });

  document.getElementById('history-list')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const deleteBtn = target.closest<HTMLElement>('.history-delete');
    if (deleteBtn) {
      e.stopPropagation();
      await deleteHistoryEntry(decodeURIComponent(deleteBtn.dataset.key ?? ''));
      showHistory();
      return;
    }
    const item = target.closest<HTMLElement>('.history-item');
    if (item) {
      const key = decodeURIComponent(item.dataset.key ?? '');
      const entries = await getAllCacheEntries();
      const found = entries.find((e) => e.key === key);
      // Still inside the History overlay: leaving it restores the current
      // tab's own screen, re-rendering its result over this entry.
      if (found) {
        renderResult(found.entry.result, found.entry.timestamp);
        setScreen('result');
      }
    }
  });

  // Info screen
  $('[data-action="analyze"]')?.addEventListener('click', () => runAnalyze());

  // Result screen
  $('[data-action="re-analyze"]')?.addEventListener('click', () => runAnalyze());
  $('[data-action="fresh-scrape"]')?.addEventListener('click', () => runAnalyze(true));
  $('[data-action="open-settings"]')?.addEventListener('click', () => openSettings());

  // Settings
  $('[data-action="save-settings"]')?.addEventListener('click', async () => {
    const newSettings = readSettingsFromUI();
    await ensureSettingsPermissions(newSettings);
    await saveSettings(newSettings);
    await runAnalyze();
  });
  // Persist without kicking off a full scrape — changing a model or pasting a
  // key should not force a 30-60s analysis.
  $('[data-action="save-settings-only"]')?.addEventListener('click', async () => {
    const newSettings = readSettingsFromUI();
    await ensureSettingsPermissions(newSettings);
    await saveSettings(newSettings);
    // A running analysis carries on. Otherwise the new settings may select a
    // different cached summary, so re-pick the home screen — without the tab.
    if (overlayReturn === 'loading') { closeOverlay(); return; }
    overlayReturn = null;
    await showHome();
  });
  // Back and Cancel both discard unsaved edits and return where the user was.
  document.querySelectorAll<HTMLElement>('[data-action="cancel-settings"], [data-action="back-from-settings"]')
    .forEach((btn) => btn.addEventListener('click', () => closeOverlay()));

  // Loading controls
  document.getElementById('summarize-now-btn')?.addEventListener('click', () => stopGathering());
  document.getElementById('cancel-btn')?.addEventListener('click', () => cancelAnalysis());

  // Wrong-page screen
  $('[data-action="open-maps"]')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://maps.google.com' });
  });

  // Error / no-reviews
  document.querySelectorAll<HTMLElement>('[data-action="retry"]').forEach((btn) => {
    btn.addEventListener('click', () => runAnalyze());
  });

  $('[data-action="analyze-anyway"]')?.addEventListener('click', () => {
    providerCheckOverridden = true;
    runAnalyze();
  });

  await showInfoScreen();
});
