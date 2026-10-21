import { SENTIMENTS } from './types.js';
import { AI_DEFAULTS, ANALYSIS_DEPTHS, BUILTIN, BUILTIN_LANGUAGE_TAGS, OUTPUT_LANGUAGES, PROMPT_BUDGET } from './config.js';
import { buildPrompt, buildResult, charBudgetForContext, computeAvg, enforceCharBudget, filterReviews, parseAIResponse, selectReviewsForPrompt, withRetry, } from './summarize.js';
/**
 * ─── Review Atlas — built-in on-device model ─────────────────────────────────
 *
 * The browser's own model, through its Prompt API (the `LanguageModel` global).
 * That API is exposed to windows only — not to the service worker — so unlike
 * every other provider this one runs in the popup, which is also the only place
 * with the user activation the one-time model download needs. Popup-only.
 *
 * Nothing leaves the device: no request is made by this extension, and the
 * browser itself fetches the model once.
 */
function api() {
    return globalThis.LanguageModel;
}
/** True when this browser exposes the Prompt API at all. */
export function builtinSupported() {
    return api() !== undefined;
}
/** Step-2 sub-label once the model is loaded and the prompt is running. */
export const ON_DEVICE_DETAIL = 'Summarizing on this device…';
const UNAVAILABLE_MESSAGE = 'Not available on this computer — needs a recent Chrome on Windows, macOS or Linux, about 22 GB ' +
    'free disk and either a GPU with more than 4 GB VRAM or 16 GB RAM. Choose another provider.';
// ─── Output language ──────────────────────────────────────────────────────────
/**
 * The language the built-in model will actually write, and the notice shown on
 * the result when that differs from the user's choice. It writes only the
 * languages in BUILTIN_LANGUAGE_TAGS; anything else falls back to English.
 * 'auto' declares nothing and follows the reviews.
 */
function outputLanguageFor(settings) {
    const lang = settings.outputLanguage ?? AI_DEFAULTS.OUTPUT_LANGUAGE;
    if (lang === 'auto' || BUILTIN_LANGUAGE_TAGS[lang])
        return { language: lang };
    const label = OUTPUT_LANGUAGES.find((o) => o.value === lang)?.label ?? lang;
    return {
        language: 'English',
        notice: `The built-in model can't write ${label} yet, so this summary is in English. ` +
            'Pick another provider in ⚙ Settings for that language.',
    };
}
/**
 * Options for both availability() and create() — the API asks for the same
 * ones, since availability depends on the languages requested. expectedInputs
 * is never declared: reviews arrive in any language.
 */
export function builtinOptions(settings) {
    const { language } = outputLanguageFor(settings);
    if (language === 'auto')
        return {};
    return { expectedOutputs: [{ type: 'text', languages: [BUILTIN_LANGUAGE_TAGS[language]] }] };
}
// ─── Availability ─────────────────────────────────────────────────────────────
/** The Test connection equivalent: no request, just the browser's own answer. */
export async function checkBuiltin(settings) {
    const lm = api();
    if (!lm)
        return { ok: false, availability: 'unavailable', message: UNAVAILABLE_MESSAGE };
    let availability;
    try {
        availability = await lm.availability(builtinOptions(settings));
    }
    catch (err) {
        return { ok: false, availability: 'unavailable', message: describeBuiltinError(err) };
    }
    switch (availability) {
        case 'available':
            return { ok: true, availability, message: 'Ready · on-device model installed' };
        case 'downloadable':
            return { ok: true, availability, message: 'Ready · the model downloads once on first use' };
        case 'downloading':
            return { ok: true, availability, message: 'Downloading the on-device model…' };
        default:
            return { ok: false, availability: 'unavailable', message: UNAVAILABLE_MESSAGE };
    }
}
let pending = null;
/** temperature and topK go together or not at all; params() may be missing. */
async function samplingOptions(lm) {
    try {
        const p = await lm.params?.();
        if (!p || !Number.isFinite(p.maxTemperature) || !Number.isFinite(p.defaultTopK))
            return {};
        return { temperature: Math.min(BUILTIN.TEMPERATURE, p.maxTemperature), topK: p.defaultTopK };
    }
    catch {
        return {};
    }
}
/**
 * Start creating a session — downloading the model first if it is not on disk.
 * Aborts any previous one. `onProgress` gets the download percentage, then a
 * ready line. The returned promise settles when the session is ready; it is
 * safe to ignore.
 */
export function startBuiltinSession(settings, onProgress) {
    abortBuiltin();
    const controller = new AbortController();
    const lm = api();
    const promise = (async () => {
        if (!lm)
            throw new Error(UNAVAILABLE_MESSAGE);
        const session = await lm.create({
            ...builtinOptions(settings),
            ...(await samplingOptions(lm)),
            signal: controller.signal,
            monitor(m) {
                m.addEventListener('downloadprogress', (e) => {
                    if (controller.signal.aborted)
                        return;
                    const pct = Math.round((e.loaded ?? 0) * 100);
                    onProgress(`Downloading on-device model · ${pct}% (one time)`);
                });
            },
        });
        // Aborted while create() was finishing — nobody will use this one.
        if (controller.signal.aborted) {
            session.destroy();
            throw new DOMException('The built-in model session was cancelled.', 'AbortError');
        }
        if (pending?.controller === controller)
            pending.session = session;
        onProgress('On-device model ready');
        return session;
    })();
    pending = { controller, promise };
    // Handled even if nobody awaits it — a cancelled or abandoned analysis must
    // not surface as an unhandled rejection. Awaiting callers still see the error.
    promise.catch(() => { });
    return promise;
}
/** Abort whatever is running and destroy the session, if one was created. */
export function abortBuiltin() {
    if (!pending)
        return;
    pending.controller.abort();
    pending.session?.destroy();
    pending = null;
}
/** Release `controller`'s session — only if a newer one has not replaced it. */
function releaseSession(controller) {
    if (pending?.controller === controller)
        abortBuiltin();
}
// ─── Summarize ────────────────────────────────────────────────────────────────
/** The result shape, enforced by the model's constrained decoding. */
const stringList = { type: 'array', items: { type: 'string' } };
export const SUMMARY_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        pros: stringList,
        cons: stringList,
        topThemes: stringList,
        overallSentiment: { type: 'string', enum: [...SENTIMENTS] },
        notableStaff: stringList,
    },
    required: ['summary', 'pros', 'cons', 'topThemes', 'overallSentiment', 'notableStaff'],
    additionalProperties: false,
};
/**
 * The built-in counterpart of background.ts summarize(): same filtering, same
 * sampling and prompt, same result — but the prompt is fitted to the context
 * window the model reports, which is small and not published.
 */
export async function summarizeBuiltin(reviews, placeName, settings, googleRating, googleReviewCount, onDetail) {
    const { reviews: filtered, dateParseWarning } = filterReviews(reviews, settings);
    if (filtered.length === 0) {
        abortBuiltin(); // the session started for this run will not be used
        throw new Error('No reviews matched the selected time range. Try widening the review scope in ⚙ Settings.');
    }
    if (!pending)
        void startBuiltinSession(settings, onDetail);
    const { controller, promise } = pending;
    const signal = controller.signal;
    try {
        const session = await promise;
        onDetail(ON_DEVICE_DETAIL);
        const avgRating = computeAvg(filtered, googleRating);
        const { language, notice } = outputLanguageFor(settings);
        // One prompt, fitted to the model: the depth preset's budget clamped to the
        // reported window, then measured and shrunk — the chars-per-token estimate
        // is far off for CJK text (about one token per character).
        const depth = ANALYSIS_DEPTHS[settings.analysisDepth ?? AI_DEFAULTS.ANALYSIS_DEPTH];
        const windowTokens = session.contextWindow ?? session.inputQuota;
        let budget = Number.isFinite(windowTokens)
            ? charBudgetForContext(windowTokens, BUILTIN.OUTPUT_RESERVE_TOKENS, depth.maxChars)
            : depth.maxChars;
        const ordered = selectReviewsForPrompt(filtered, settings, budget);
        let selected = ordered;
        let prompt = buildPrompt(selected, placeName, filtered.length, settings, language);
        const measure = (session.measureContextUsage ?? session.measureInputUsage)?.bind(session);
        if (measure && Number.isFinite(windowTokens)) {
            const limit = windowTokens - BUILTIN.OUTPUT_RESERVE_TOKENS;
            for (let i = 0; i < BUILTIN.FIT_ATTEMPTS; i++) {
                const used = await measure(prompt, { signal });
                if (used <= limit)
                    break;
                // Scale what the selection actually spends, not the budget it was cut
                // to — a selection well under budget would otherwise lose nothing.
                const spent = selected.reduce((n, r) => n + r.text.length + PROMPT_BUDGET.PER_REVIEW_OVERHEAD, 0);
                budget = Math.floor(Math.min(budget, spent) * (limit / used) * 0.9);
                // Same ordered selection, cut shorter — complaints still come first.
                const shorter = enforceCharBudget(ordered, budget);
                // Nothing left to cut: send it, and let an overflow report itself.
                if (shorter.length === 0)
                    break;
                selected = shorter;
                prompt = buildPrompt(selected, placeName, filtered.length, settings, language);
            }
        }
        console.log(`[Review Atlas] builtin · depth=${settings.analysisDepth ?? AI_DEFAULTS.ANALYSIS_DEPTH} · ` +
            `${selected.length} of ${filtered.length} reviews in prompt ` +
            `(~${Math.round(prompt.length / PROMPT_BUDGET.CHARS_PER_TOKEN).toLocaleString()} tokens)`);
        // No timeout on the download above — only on the prompt itself.
        const timer = setTimeout(() => controller.abort(new DOMException('The on-device model did not answer in time.', 'TimeoutError')), BUILTIN.REQUEST_TIMEOUT_MS);
        try {
            // A fresh clone per attempt: retrying on the same session would append
            // the failed turn to its context.
            const parsed = await withRetry(async () => {
                const attempt = await session.clone({ signal });
                try {
                    return parseAIResponse(await attempt.prompt(prompt, {
                        signal,
                        responseConstraint: SUMMARY_SCHEMA,
                        omitResponseConstraintInput: true, // the prompt already describes the shape
                    }));
                }
                finally {
                    attempt.destroy();
                }
            });
            return buildResult(parsed, placeName, avgRating, googleReviewCount ?? reviews.length, selected.length, filtered.length, dateParseWarning, notice);
        }
        catch (err) {
            // The API may reject with a bare AbortError rather than the reason.
            if (signal.aborted && signal.reason?.name === 'TimeoutError')
                throw signal.reason;
            throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    finally {
        releaseSession(controller);
    }
}
// ─── Errors ───────────────────────────────────────────────────────────────────
/**
 * What the user reads when the built-in path fails. This extension's own
 * errors (an empty time range, no Prompt API) already say what to do and pass
 * through; the API's DOMExceptions and a malformed answer get an explanation.
 */
export function describeBuiltinError(err) {
    const name = err?.name;
    const message = err?.message ?? String(err);
    switch (name) {
        case 'TimeoutError':
        case 'AbortError':
            return 'The on-device model did not answer within 5 minutes — try Quick depth, or a faster provider in ⚙ Settings.';
        case 'QuotaExceededError':
            return "Too many reviews for the on-device model's context — choose Quick depth.";
        case 'NotSupportedError':
            return "The built-in model doesn't support the language of these reviews or the chosen output language. " +
                'Choose another provider in ⚙ Settings.';
        case 'NotAllowedError':
            // The download must start from a click, and the Analyze click can expire
            // before create() runs. Download now is a click of its own.
            return 'Chrome would not start the on-device model from here. Open ⚙ Settings → Built-in, ' +
                'click Download now, then analyze again.';
    }
    // The API rejects with DOMExceptions; a plain Error is one of ours.
    if (name === 'Error')
        return message;
    return `The built-in model failed: ${message.replace(/[.!?]+$/, '')}. ` +
        'See chrome://on-device-internals, or choose another provider in ⚙ Settings.';
}
