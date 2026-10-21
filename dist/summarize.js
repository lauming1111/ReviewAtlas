import { LOCAL_PROVIDERS, SENTIMENTS } from './types.js';
import { AI_DEFAULTS, ANALYSIS_DEPTHS, PROMPT_BUDGET } from './config.js';
/**
 * ─── Review Atlas — shared summarize helpers ─────────────────────────────────
 *
 * Review filtering, prompt building and result parsing for every provider. The
 * background worker imports this for the HTTP providers; the popup imports it
 * for the built-in model, whose API exists only in a window. Nothing here may
 * touch chrome.* or the DOM, so both can load it.
 *
 * content.ts must not import this module — it runs as a classic content script.
 */
/** True for providers running on the user's own machine or network. */
export function isLocalProvider(settings) {
    return LOCAL_PROVIDERS.includes(settings.aiProvider ?? 'ollama');
}
/** Sampling parameters for whichever local provider is active. */
export function localParams(settings) {
    return (settings.aiProvider === 'custom' ? settings.customParams : settings.ollamaParams) ?? {};
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ─── Date filtering ───────────────────────────────────────────────────────────
export function parseReviewDate(dateStr) {
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
export function getCutoffDate(mode) {
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
export function filterReviews(reviews, settings) {
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
export function truncateReview(r) {
    if (r.text.length <= AI_DEFAULTS.MAX_REVIEW_CHARS)
        return r;
    return { ...r, text: `${r.text.slice(0, AI_DEFAULTS.MAX_REVIEW_CHARS)}…` };
}
export function isComplaint(r) {
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
export function resolveCharBudget(settings, depthChars) {
    // Applies to any locally-hosted model. Previously this returned early for
    // everything except Ollama, so an LM Studio / llama.cpp user with a small
    // context window hit exactly the prompt-overflow this clamp exists to stop.
    if (!isLocalProvider(settings))
        return depthChars;
    const numCtx = localParams(settings).numCtx ?? AI_DEFAULTS.OLLAMA_NUM_CTX;
    const budget = charBudgetForContext(numCtx, AI_DEFAULTS.MAX_OUTPUT_TOKENS, depthChars);
    if (budget < depthChars) {
        console.warn(`[Review Atlas] num_ctx ${numCtx} limits the prompt to ~${budget.toLocaleString()} chars ` +
            `(depth preset allows ${depthChars.toLocaleString()}). Raise num_ctx for a fuller analysis.`);
    }
    return budget;
}
/**
 * The depth preset's character budget, clamped to what a context window of
 * `numCtx` tokens can hold once `reserveTokens` are kept free for the answer.
 * Shared by the local providers (num_ctx from Settings) and the built-in model
 * (the window it reports at runtime).
 */
export function charBudgetForContext(numCtx, reserveTokens, depthChars) {
    const promptTokens = numCtx - reserveTokens;
    const fromCtx = promptTokens * PROMPT_BUDGET.CHARS_PER_TOKEN - PROMPT_BUDGET.STATIC_PROMPT_CHARS;
    // A tiny num_ctx can make this zero or negative — keep a floor so we always
    // send at least a handful of reviews rather than an empty prompt.
    const clamped = Math.max(2000, Math.floor(fromCtx));
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
 *
 * `charBudget` defaults to the depth preset's budget; the built-in model passes
 * one sized from the context window it reports, which Settings knows nothing about.
 */
export function selectReviewsForPrompt(reviews, settings, charBudget = resolveCharBudget(settings, ANALYSIS_DEPTHS[settings.analysisDepth ?? AI_DEFAULTS.ANALYSIS_DEPTH].maxChars)) {
    const depth = ANALYSIS_DEPTHS[settings.analysisDepth ?? AI_DEFAULTS.ANALYSIS_DEPTH];
    const cap = depth.maxReviews;
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
export function enforceCharBudget(reviews, budget) {
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
export function languageRule(outputLanguage) {
    const lang = outputLanguage ?? AI_DEFAULTS.OUTPUT_LANGUAGE;
    return lang === 'auto'
        ? '- Write every human-readable string in your response (summary, pros, cons, topThemes) in the dominant language of the reviews above. Keep the JSON keys and the overallSentiment value in English.'
        : `- Write every human-readable string in your response (summary, pros, cons, topThemes) in ${lang}, regardless of the language of the reviews. Keep the JSON keys and the overallSentiment value in English.`;
}
export function buildPrompt(reviews, placeName, totalCollected, settings, 
/** Overrides settings.outputLanguage — the built-in model falls back to English. */
outputLanguage = settings.outputLanguage) {
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
${languageRule(outputLanguage)}
- Be concise but informative`;
}
/** Parses the MODEL's JSON output. A SyntaxError here is retryable. */
export function parseAIResponse(raw) {
    const cleaned = raw
        // Reasoning models served over the OpenAI-compatible API (LM Studio, llama.cpp…)
        // put their thinking inline, ahead of the JSON.
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
}
/**
 * Coerce the model's sentiment string to one the UI can render.
 * Unvalidated, a model answering in another language returned a translated word
 * that reached sentimentLabel[...] in the popup and rendered a blank badge.
 */
export function toSentiment(raw) {
    if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        const hit = SENTIMENTS.find((s) => s === v);
        if (hit)
            return hit;
        console.warn(`[Review Atlas] Unrecognised overallSentiment ${JSON.stringify(raw)} — using 'mixed'.`);
    }
    return 'mixed';
}
export function buildResult(parsed, placeName, avgRating, totalReviews, analyzedCount, collectedCount, dateParseWarning, providerNotice) {
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
        ...(providerNotice && { providerNotice }),
    };
}
/** Shared helper: compute avgRating from a filtered review set (or use Google's value). */
export function computeAvg(selected, googleRating) {
    const rated = selected.filter((r) => r.rating > 0);
    return googleRating ?? (rated.reduce((s, r) => s + r.rating, 0) / (rated.length || 1));
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
export async function withRetry(fn, maxAttempts = AI_DEFAULTS.MAX_RETRIES) {
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
