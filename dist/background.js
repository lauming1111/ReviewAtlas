import { LOCAL_PROVIDERS, SENTIMENTS } from './types.js';
import { AI_DEFAULTS, ANALYSIS_DEPTHS, PROMPT_BUDGET } from './config.js';
/** Ollama base URL for this request — user-configurable, trailing slashes stripped. */
function ollamaBase(settings) {
    return (settings.ollamaEndpoint || AI_DEFAULTS.OLLAMA_ENDPOINT).replace(/\/+$/, '');
}
/** True for providers running on the user's own machine or network. */
function isLocalProvider(settings) {
    return LOCAL_PROVIDERS.includes(settings.aiProvider ?? 'ollama');
}
/** Sampling parameters for whichever local provider is active. */
function localParams(settings) {
    return (settings.aiProvider === 'custom' ? settings.customParams : settings.ollamaParams) ?? {};
}
/** One session rule per local provider, so switching providers never strands a stale one. */
const ORIGIN_RULE_IDS = { ollama: 1, custom: 2 };
/**
 * Chrome stamps `Origin: chrome-extension://<id>` on this extension's POSTs, and
 * Ollama answers an origin it does not recognise with a bare 403 — so every
 * Ollama analysis failed, while Test connection (a GET, which carries no Origin)
 * reported success. Strip the header from this extension's own requests to the
 * local server. The rule matches only requests this extension initiates: a web
 * page calling the same server keeps its Origin and is still refused.
 */
async function allowLocalServer(settings) {
    const provider = (settings.aiProvider ?? 'ollama');
    const endpoint = provider === 'custom' ? settings.customEndpoint : ollamaBase(settings);
    if (!endpoint)
        return;
    const id = ORIGIN_RULE_IDS[provider];
    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [id],
            addRules: [{
                    id,
                    priority: 1,
                    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
                    condition: {
                        urlFilter: `|${new URL(endpoint).origin}/`,
                        initiatorDomains: [chrome.runtime.id],
                        resourceTypes: ['xmlhttprequest', 'other'],
                    },
                }],
        });
    }
    catch (err) {
        // Not fatal — the request still goes out, and a refusal surfaces as its own error.
        console.warn('[Review Atlas] Could not install the local-server Origin rule:', err);
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ─── Date filtering ───────────────────────────────────────────────────────────
function parseReviewDate(dateStr) {
    if (!dateStr)
        return null;
    const trimmed = dateStr.trim().toLowerCase();
    const agoMatch = trimmed.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/);
    if (agoMatch) {
        const amount = Number(agoMatch[1]);
        const unit = agoMatch[2];
        const d = new Date();
        switch (unit) {
            case 'minute':
                d.setMinutes(d.getMinutes() - amount);
                break;
            case 'hour':
                d.setHours(d.getHours() - amount);
                break;
            case 'day':
                d.setDate(d.getDate() - amount);
                break;
            case 'week':
                d.setDate(d.getDate() - amount * 7);
                break;
            case 'month':
                d.setMonth(d.getMonth() - amount);
                break;
            case 'year':
                d.setFullYear(d.getFullYear() - amount);
                break;
        }
        return d;
    }
    if (trimmed === 'yesterday') {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return d;
    }
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed;
}
function getCutoffDate(mode) {
    const now = new Date();
    if (mode === 'recent' || mode === 'all')
        return null;
    const cutoff = new Date(now);
    switch (mode) {
        case '1m':
            cutoff.setMonth(cutoff.getMonth() - 1);
            break;
        case '3m':
            cutoff.setMonth(cutoff.getMonth() - 3);
            break;
        case '6m':
            cutoff.setMonth(cutoff.getMonth() - 6);
            break;
        case '1y':
            cutoff.setFullYear(cutoff.getFullYear() - 1);
            break;
    }
    return cutoff;
}
function filterReviews(reviews, settings) {
    // 'all' analyses everything that was collected — the scrape ceiling already
    // bounded it. 'recent' takes strictly the newest N, and the content script
    // sorted the page by newest first so "newest" really is newest, not most-relevant.
    if (settings.reviewMode === 'all')
        return { reviews };
    if (settings.reviewMode === 'recent')
        return { reviews: reviews.slice(0, settings.reviewCount) };
    const cutoff = getCutoffDate(settings.reviewMode);
    if (!cutoff)
        return { reviews: reviews.slice(0, settings.reviewCount) };
    // Reviews whose date string cannot be parsed are KEPT, not dropped. Dropping
    // them meant a single Google layout or locale change silently emptied every
    // time-window result set.
    let unparseable = 0;
    const kept = reviews.filter((r) => {
        const d = parseReviewDate(r.date);
        if (!d) {
            unparseable++;
            return true;
        }
        return d >= cutoff;
    });
    let dateParseWarning;
    if (unparseable > 0) {
        console.warn(`[Review Atlas] ${unparseable}/${reviews.length} review(s) had an unparseable date — kept rather than dropped.`);
        // parseReviewDate only understands English relative dates, so on a
        // non-English Maps locale every date fails and the time window silently
        // degrades to "all". Tell the user instead of only the console.
        if (unparseable > reviews.length / 2) {
            dateParseWarning =
                `${unparseable} of ${reviews.length} review dates could not be read, so the time filter ` +
                    'could not be applied to them. This usually means Google Maps is in a non-English language.';
        }
    }
    return { reviews: kept.slice(0, settings.reviewCount), dateParseWarning };
}
// ─── Prompt sampling ──────────────────────────────────────────────────────────
function truncateReview(r) {
    if (r.text.length <= AI_DEFAULTS.MAX_REVIEW_CHARS)
        return r;
    return { ...r, text: `${r.text.slice(0, AI_DEFAULTS.MAX_REVIEW_CHARS)}…` };
}
function isComplaint(r) {
    return r.rating > 0 && r.rating <= 2;
}
/**
 * Characters of review text this request may spend.
 *
 * Starts from the depth preset, then — for any LOCAL model — clamps to what the
 * user's context window can actually hold. The context size is editable down to
 * 512, and nothing previously revalidated the budget against it, so a small
 * context window silently overflowed the prompt.
 */
function resolveCharBudget(settings, depthChars) {
    // Applies to any locally-hosted model. Previously this returned early for
    // everything except Ollama, so an LM Studio / llama.cpp user with a small
    // context window hit exactly the prompt-overflow this clamp exists to stop.
    if (!isLocalProvider(settings))
        return depthChars;
    const numCtx = localParams(settings).numCtx ?? AI_DEFAULTS.OLLAMA_NUM_CTX;
    const promptTokens = numCtx - AI_DEFAULTS.MAX_OUTPUT_TOKENS;
    const fromCtx = promptTokens * PROMPT_BUDGET.CHARS_PER_TOKEN - PROMPT_BUDGET.STATIC_PROMPT_CHARS;
    // A tiny num_ctx can make this zero or negative — keep a floor so we always
    // send at least a handful of reviews rather than an empty prompt.
    const clamped = Math.max(2000, Math.floor(fromCtx));
    if (clamped < depthChars) {
        console.warn(`[Review Atlas] num_ctx ${numCtx} limits the prompt to ~${clamped.toLocaleString()} chars ` +
            `(depth preset allows ${depthChars.toLocaleString()}). Raise num_ctx for a fuller analysis.`);
    }
    return Math.min(depthChars, clamped);
}
/**
 * Pick the reviews to serialize into the prompt, bounded by BOTH a count cap
 * and a character budget.
 *
 * Sending everything produced a ~68k-token prompt for a 1000-review place —
 * far beyond any local model's context, so the model silently read a fraction
 * of it while the user paid full prompt-processing latency.
 *
 * Strategy: keep every 1–2★ review (complaints are the scarcest, highest-signal
 * input and are what "cons" is built from), then stride-sample the remainder so
 * the selection spans the full time range rather than only the newest reviews.
 */
function selectReviewsForPrompt(reviews, settings) {
    const depth = ANALYSIS_DEPTHS[settings.analysisDepth ?? AI_DEFAULTS.ANALYSIS_DEPTH];
    const cap = depth.maxReviews;
    const charBudget = resolveCharBudget(settings, depth.maxChars);
    if (reviews.length <= cap) {
        return enforceCharBudget(reviews.map(truncateReview), charBudget);
    }
    const complaints = reviews.filter(isComplaint);
    const rest = reviews.filter((r) => !isComplaint(r));
    const kept = complaints.slice(0, cap);
    const chosen = new Set(kept);
    if (kept.length < cap && rest.length > 0) {
        const budget = cap - kept.length;
        const stride = Math.max(1, Math.floor(rest.length / budget));
        for (let i = 0; i < rest.length && kept.length < cap; i += stride) {
            kept.push(rest[i]);
            chosen.add(rest[i]);
        }
        // Stride rounding can leave room — top up with anything not yet chosen.
        for (let i = 0; i < rest.length && kept.length < cap; i++) {
            if (!chosen.has(rest[i])) {
                kept.push(rest[i]);
                chosen.add(rest[i]);
            }
        }
    }
    return enforceCharBudget(kept.map(truncateReview), charBudget);
}
/**
 * Trim the selection so the serialized review text fits the character budget.
 * The count cap alone is not enough: 250 reviews at MAX_REVIEW_CHARS each
 * would still overflow the context window. Complaints sort first in `kept`,
 * so they survive trimming.
 */
function enforceCharBudget(reviews, budget) {
    let used = 0;
    const out = [];
    for (const r of reviews) {
        const cost = r.text.length + PROMPT_BUDGET.PER_REVIEW_OVERHEAD;
        if (used + cost > budget)
            break;
        out.push(r);
        used += cost;
    }
    return out;
}
// ─── Shared prompt + result builder ──────────────────────────────────────────
/**
 * Language directive. Without one the output language was undefined behaviour —
 * it depended on the provider's default and on the language of the reviews, and
 * could differ between runs for the same place.
 */
function languageRule(outputLanguage) {
    const lang = outputLanguage ?? AI_DEFAULTS.OUTPUT_LANGUAGE;
    return lang === 'auto'
        ? '- Write every human-readable string in your response (summary, pros, cons, topThemes) in the dominant language of the reviews above. Keep the JSON keys and the overallSentiment value in English.'
        : `- Write every human-readable string in your response (summary, pros, cons, topThemes) in ${lang}, regardless of the language of the reviews. Keep the JSON keys and the overallSentiment value in English.`;
}
function buildPrompt(reviews, placeName, totalCollected, settings) {
    const reviewsText = reviews
        .map((r, i) => `[Review ${i + 1}] ⭐${r.rating}/5 — ${r.text}`)
        .join('\n\n');
    return `You are analyzing customer reviews for "${placeName}".

Here are ${reviews.length} reviews (out of ${totalCollected} total):

${reviewsText}

Respond ONLY with a valid JSON object (no markdown, no preamble) in this exact shape:
{
  "summary": "2–3 sentence overall summary",
  "pros": ["specific positive point 1", "specific positive point 2", "...up to 6"],
  "cons": ["specific negative point 1", "specific negative point 2", "...up to 6"],
  "topThemes": ["theme1", "theme2", "theme3"],
  "overallSentiment": "positive" | "neutral" | "negative" | "mixed",
  "notableStaff": ["FirstName", "..."]
}

Rules:
- pros and cons must be specific, actionable insights drawn from actual review content
- topThemes are 1–3 word topics that appear most often (e.g. "parking", "wait times", "staff")
- overallSentiment reflects the general tone across all reviews
- notableStaff: list only the first names (or full names) of EMPLOYEES or STAFF of "${placeName}" who are praised or mentioned by name in at least 2 different reviews; DO NOT include the names of customers or reviewers (i.e. the people who wrote the reviews), DO NOT include business names, brand names, platforms, or services; if no staff members can be clearly identified return []
- overallSentiment MUST be exactly one of: positive, neutral, negative, mixed
${languageRule(settings.outputLanguage)}
- Be concise but informative`;
}
/** Parses the MODEL's JSON output. A SyntaxError here is retryable. */
function parseAIResponse(raw) {
    const cleaned = raw
        // Reasoning models served over the OpenAI-compatible API (LM Studio, llama.cpp…)
        // put their thinking inline, ahead of the JSON.
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
}
/**
 * Parses an HTTP response body. A non-JSON body here means the provider is
 * misbehaving, not the model — so this throws a plain Error rather than a
 * SyntaxError, keeping it out of the retry path.
 */
async function readJsonBody(response, provider) {
    const body = await response.text();
    try {
        return JSON.parse(body);
    }
    catch {
        throw new Error(`${provider} returned a non-JSON response: ${body.slice(0, 200)}`);
    }
}
/**
 * Coerce the model's sentiment string to one the UI can render.
 * Unvalidated, a model answering in another language returned a translated word
 * that reached sentimentLabel[...] in the popup and rendered a blank badge.
 */
function toSentiment(raw) {
    if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        const hit = SENTIMENTS.find((s) => s === v);
        if (hit)
            return hit;
        console.warn(`[Review Atlas] Unrecognised overallSentiment ${JSON.stringify(raw)} — using 'mixed'.`);
    }
    return 'mixed';
}
function buildResult(parsed, placeName, avgRating, totalReviews, analyzedCount, collectedCount, dateParseWarning) {
    return {
        placeName,
        overallSentiment: toSentiment(parsed.overallSentiment),
        averageRating: Math.round(avgRating * 10) / 10,
        totalReviews,
        pros: parsed.pros ?? [],
        cons: parsed.cons ?? [],
        summary: parsed.summary ?? '',
        topThemes: parsed.topThemes ?? [],
        notableStaff: parsed.notableStaff ?? [],
        analyzedCount,
        collectedCount,
        ...(dateParseWarning && { dateParseWarning }),
    };
}
/** Shared helper: compute avgRating from a filtered review set (or use Google's value). */
function computeAvg(selected, googleRating) {
    const rated = selected.filter((r) => r.rating > 0);
    return googleRating ?? (rated.reduce((s, r) => s + r.rating, 0) / (rated.length || 1));
}
// ─── fetch with timeout ───────────────────────────────────────────────────────
async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_DEFAULTS.REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw new Error(`Request timed out after ${Math.round(AI_DEFAULTS.REQUEST_TIMEOUT_MS / 1000)}s. ` +
                'The model may be too slow for this many reviews — try a smaller review scope or a faster model.');
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
}
function buildCompatBody(model, prompt, opts, withExtras) {
    const p = opts.params ?? {};
    const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: p.temperature ?? AI_DEFAULTS.OPENAI_TEMPERATURE,
        max_tokens: AI_DEFAULTS.MAX_OUTPUT_TOKENS,
    };
    if (p.topP !== undefined)
        body.top_p = p.topP;
    if (withExtras) {
        if (p.topK !== undefined)
            body.top_k = p.topK;
        if (p.repeatPenalty !== undefined)
            body.repetition_penalty = p.repeatPenalty;
    }
    return body;
}
async function callOpenAICompatible(label, url, apiKey, model, prompt, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey)
        headers['Authorization'] = `Bearer ${apiKey}`;
    const wantExtras = opts.sendExtraParams === true;
    const send = (withExtras) => fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildCompatBody(model, prompt, opts, withExtras)),
    });
    let response = await send(wantExtras);
    // A strict server rejects unknown fields with 400. Rather than surfacing a
    // confusing error, drop the non-standard params and try once more.
    if (!response.ok && response.status === 400 && wantExtras) {
        console.warn(`[Review Atlas] ${label} rejected top_k/repetition_penalty — retrying without them.`);
        response = await send(false);
    }
    if (!response.ok) {
        throw new Error(`${label} API error ${response.status}: ${await response.text()}`);
    }
    const data = await readJsonBody(response, label);
    return data.choices?.[0]?.message?.content ?? '';
}
async function checkOllama(settings) {
    const base = ollamaBase(settings);
    try {
        // Goes through fetchWithTimeout like every other call — a hung server here
        // previously blocked the whole analysis with no timeout at all.
        const res = await fetchWithTimeout(`${base}/api/tags`, { method: 'GET' });
        if (!res.ok)
            throw new Error(`status ${res.status}`);
    }
    catch {
        throw new Error(`Cannot reach Ollama at ${base}. Make sure it is running (\`ollama serve\`), ` +
            'or change the server endpoint in ⚙ Settings → AI Provider → Ollama.');
    }
}
const callOllama = async (prompt, settings) => {
    const model = settings.ollamaModel ?? AI_DEFAULTS.OLLAMA_MODEL;
    const p = localParams(settings);
    const options = { num_predict: AI_DEFAULTS.MAX_OUTPUT_TOKENS };
    if (p.temperature !== undefined)
        options.temperature = p.temperature;
    if (p.topK !== undefined)
        options.top_k = p.topK;
    if (p.topP !== undefined)
        options.top_p = p.topP;
    if (p.numCtx !== undefined)
        options.num_ctx = p.numCtx;
    if (p.repeatPenalty !== undefined)
        options.repeat_penalty = p.repeatPenalty;
    const response = await fetchWithTimeout(`${ollamaBase(settings)}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // think: false. Ollama switches thinking ON by default for reasoning models
        // (deepseek-r1, qwen3, …), and the reasoning comes out of the same output
        // budget: measured on deepseek-r1:8b, all 2048 tokens and 100 s went to
        // thinking, the response came back empty, and every retry did the same.
        // Only think: true is an error for a model without thinking.
        body: JSON.stringify({ model, prompt, stream: false, think: false, options }),
    });
    if (!response.ok) {
        // allowLocalServer should make this impossible; when it happens the rule is
        // missing, and the bare 403 Ollama sends explains nothing.
        if (response.status === 403) {
            throw new Error('Ollama refused the request (HTTP 403). Reload the extension at chrome://extensions, ' +
                'or add chrome-extension://* to the OLLAMA_ORIGINS setting of your Ollama server.');
        }
        throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
    }
    const data = await readJsonBody(response, 'Ollama');
    return data.response ?? '';
};
const callOpenAI = (prompt, settings) => {
    if (!settings.openaiApiKey) {
        throw new Error('OpenAI API key is not set. Go to ⚙ Settings and add your key.');
    }
    return callOpenAICompatible('OpenAI', 'https://api.openai.com/v1/chat/completions', settings.openaiApiKey, settings.openaiModel ?? AI_DEFAULTS.OPENAI_MODEL, prompt);
};
const callGroq = (prompt, settings) => {
    if (!settings.groqApiKey) {
        throw new Error('Groq API key is not set. Go to ⚙ Settings and add your key.');
    }
    return callOpenAICompatible('Groq', 'https://api.groq.com/openai/v1/chat/completions', settings.groqApiKey, settings.groqModel ?? AI_DEFAULTS.GROQ_MODEL, prompt);
};
const callXAI = (prompt, settings) => {
    if (!settings.xaiApiKey) {
        throw new Error('xAI API key is not set. Go to ⚙ Settings and add your key.');
    }
    return callOpenAICompatible('xAI', 'https://api.x.ai/v1/chat/completions', settings.xaiApiKey, settings.xaiModel ?? AI_DEFAULTS.XAI_MODEL, prompt);
};
const callAnthropic = async (prompt, settings) => {
    if (!settings.anthropicApiKey) {
        throw new Error('Anthropic API key is not set. Go to ⚙ Settings and add your key.');
    }
    const model = settings.anthropicModel ?? AI_DEFAULTS.ANTHROPIC_MODEL;
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': settings.anthropicApiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: AI_DEFAULTS.MAX_OUTPUT_TOKENS,
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    if (!response.ok) {
        throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
    }
    const data = await readJsonBody(response, 'Anthropic');
    return data.content?.[0]?.text ?? '';
};
const callGemini = async (prompt, settings) => {
    if (!settings.geminiApiKey) {
        throw new Error('Google Gemini API key is not set. Go to ⚙ Settings and add your key.');
    }
    const model = settings.geminiModel ?? AI_DEFAULTS.GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiApiKey}`;
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: AI_DEFAULTS.OPENAI_TEMPERATURE,
                maxOutputTokens: AI_DEFAULTS.MAX_OUTPUT_TOKENS,
            },
        }),
    });
    if (!response.ok) {
        throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);
    }
    const data = await readJsonBody(response, 'Gemini');
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
};
const callCustom = async (prompt, settings) => {
    if (!settings.customEndpoint) {
        throw new Error('Custom endpoint URL is not set. Go to ⚙ Settings and add your endpoint URL.');
    }
    const baseUrl = settings.customEndpoint.replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
    try {
        return await callOpenAICompatible('Custom endpoint', url, settings.customApiKey, settings.customModel || 'local-model', prompt, {
            params: settings.customParams,
            // Local servers generally accept these; the call falls back automatically
            // if this particular one does not.
            sendExtraParams: settings.customSendExtraParams !== false,
        });
    }
    catch (err) {
        // A bare TypeError from fetch on a non-localhost host almost always means
        // the extension lacks host permission for it.
        if (err instanceof TypeError) {
            throw new Error(`Could not reach ${baseUrl}. If this is not a localhost address, the extension needs ` +
                'permission for that host — re-save the endpoint in ⚙ Settings and accept the permission prompt.');
        }
        throw err;
    }
};
const PROVIDER_CALL = {
    ollama: callOllama,
    openai: callOpenAI,
    anthropic: callAnthropic,
    gemini: callGemini,
    groq: callGroq,
    xai: callXAI,
    custom: callCustom,
};
/**
 * Validate credentials and reachability using each provider's model-list
 * endpoint. These are free — no tokens are generated — so this is safe to run
 * on demand, and it returns the model list the picker needs from the same call.
 */
async function testConnection(settings) {
    const provider = settings.aiProvider ?? 'ollama';
    let url;
    const headers = {};
    switch (provider) {
        case 'ollama':
            url = `${ollamaBase(settings)}/api/tags`;
            break;
        case 'openai':
            if (!settings.openaiApiKey)
                return { ok: false, message: 'No API key set.' };
            url = 'https://api.openai.com/v1/models';
            headers['Authorization'] = `Bearer ${settings.openaiApiKey}`;
            break;
        case 'groq':
            if (!settings.groqApiKey)
                return { ok: false, message: 'No API key set.' };
            url = 'https://api.groq.com/openai/v1/models';
            headers['Authorization'] = `Bearer ${settings.groqApiKey}`;
            break;
        case 'xai':
            if (!settings.xaiApiKey)
                return { ok: false, message: 'No API key set.' };
            url = 'https://api.x.ai/v1/models';
            headers['Authorization'] = `Bearer ${settings.xaiApiKey}`;
            break;
        case 'anthropic':
            if (!settings.anthropicApiKey)
                return { ok: false, message: 'No API key set.' };
            // Paginated at 20 per page by default, which would truncate the picker.
            url = 'https://api.anthropic.com/v1/models?limit=1000';
            headers['x-api-key'] = settings.anthropicApiKey;
            headers['anthropic-version'] = '2023-06-01';
            break;
        case 'gemini':
            if (!settings.geminiApiKey)
                return { ok: false, message: 'No API key set.' };
            // 50 per page by default — fewer than Google lists.
            url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${settings.geminiApiKey}`;
            break;
        case 'custom':
            if (!settings.customEndpoint)
                return { ok: false, message: 'No endpoint URL set.' };
            url = `${settings.customEndpoint.replace(/\/+$/, '')}/models`;
            if (settings.customApiKey)
                headers['Authorization'] = `Bearer ${settings.customApiKey}`;
            break;
        default:
            return { ok: false, message: `Unknown provider: ${provider}` };
    }
    let response;
    try {
        response = await fetchWithTimeout(url, { method: 'GET', headers });
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            message: provider === 'ollama'
                ? `Cannot reach ${ollamaBase(settings)} — is Ollama running?`
                : `Could not reach the provider: ${detail}`,
        };
    }
    if (!response.ok) {
        const body = (await response.text()).slice(0, 160);
        const hint = response.status === 401 || response.status === 403 ? ' — the API key looks wrong.' :
            response.status === 404 ? ' — check the endpoint URL.' : '';
        return { ok: false, message: `HTTP ${response.status}${hint} ${body}`.trim() };
    }
    let data;
    try {
        data = await readJsonBody(response, provider);
    }
    catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    const models = extractModelNames(provider, data);
    return {
        ok: true,
        message: models.length > 0 ? `Connected · ${models.length} models available` : 'Connected',
        models,
    };
}
/**
 * Model families that cannot answer a chat request. The list now feeds every
 * provider's picker, and choosing one of these would only fail at analysis time.
 */
const NON_CHAT_MODEL = /(?:^|[-_./:])(?:embed|whisper|tts|transcribe|dall-e|moderation|image|audio|realtime|rerank|guard|davinci|babbage)/i;
/** Each provider reports its model list under a different shape. */
function extractModelNames(provider, data) {
    const names = provider === 'ollama' ? (data?.models ?? []).map((m) => m?.name) :
        provider === 'gemini' ? (data?.models ?? [])
            // Gemini states what each model supports — embedding models lack generateContent.
            .filter((m) => !m?.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
            .map((m) => m?.name?.replace(/^models\//, '')) :
            (data?.data ?? []).map((m) => m?.id);
    return names
        .filter((n) => typeof n === 'string' && n.length > 0 && !NON_CHAT_MODEL.test(n))
        .sort();
}
// ─── Retry helper ─────────────────────────────────────────────────────────────
/**
 * Re-runs fn() only when the MODEL returned malformed JSON (SyntaxError from
 * parseAIResponse). HTTP errors, timeouts, missing keys, and non-JSON provider
 * responses all propagate immediately — retrying those just burns time.
 *
 * The caller passes a closure containing only the network call and the parse;
 * prompt construction stays outside so it is not repeated on every attempt.
 */
async function withRetry(fn, maxAttempts = AI_DEFAULTS.MAX_RETRIES) {
    for (let attempt = 1;; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            if (!(err instanceof SyntaxError) || attempt >= maxAttempts)
                throw err;
            const delay = AI_DEFAULTS.RETRY_BACKOFF_MS * 2 ** (attempt - 1);
            console.warn(`[Review Atlas] Invalid JSON on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms…`);
            await sleep(delay);
        }
    }
}
// ─── Orchestration ────────────────────────────────────────────────────────────
async function summarize(reviews, placeName, settings, googleRating, googleReviewCount) {
    const provider = settings.aiProvider ?? 'ollama';
    const call = PROVIDER_CALL[provider] ?? callOllama;
    const { reviews: filtered, dateParseWarning } = filterReviews(reviews, settings);
    if (filtered.length === 0) {
        throw new Error('No reviews matched the selected time range. Try widening the review scope in ⚙ Settings.');
    }
    // Everything below is computed ONCE — the retry closure covers only the
    // model call and the parse of its output.
    const selected = selectReviewsForPrompt(filtered, settings);
    const avgRating = computeAvg(filtered, googleRating);
    const prompt = buildPrompt(selected, placeName, filtered.length, settings);
    if (isLocalProvider(settings))
        await allowLocalServer(settings);
    if (provider === 'ollama')
        await checkOllama(settings);
    console.log(`[Review Atlas] ${provider} · depth=${settings.analysisDepth ?? AI_DEFAULTS.ANALYSIS_DEPTH} · ` +
        `${selected.length} of ${filtered.length} reviews in prompt ` +
        `(~${Math.round(prompt.length / PROMPT_BUDGET.CHARS_PER_TOKEN).toLocaleString()} tokens)`);
    const parsed = await withRetry(async () => parseAIResponse(await call(prompt, settings)));
    return buildResult(parsed, placeName, avgRating, googleReviewCount ?? reviews.length, selected.length, filtered.length, dateParseWarning);
}
// ─── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SUMMARIZE') {
        const { reviews, placeName, settings, googleRating, googleReviewCount } = message.payload;
        console.log(`[Review Atlas] SUMMARIZE via ${settings.aiProvider ?? 'ollama'} for "${placeName}"`);
        summarize(reviews, placeName, settings, googleRating, googleReviewCount)
            .then((result) => sendResponse({ type: 'SUMMARY_RESULT', payload: result }))
            .catch((err) => sendResponse({
            type: 'ERROR',
            payload: err instanceof Error ? err.message : String(err),
        }));
        return true;
    }
    if (message.type === 'TEST_CONNECTION') {
        testConnection(message.payload.settings)
            .then((result) => sendResponse({ type: 'CONNECTION_RESULT', payload: result }))
            .catch((err) => sendResponse({
            type: 'CONNECTION_RESULT',
            payload: { ok: false, message: err instanceof Error ? err.message : String(err) },
        }));
        return true;
    }
});
