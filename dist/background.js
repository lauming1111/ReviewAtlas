import { AI_DEFAULTS, PROMPT_BUDGET } from './config.js';
import { buildPrompt, buildResult, computeAvg, filterReviews, isLocalProvider, localParams, parseAIResponse, selectReviewsForPrompt, withRetry, } from './summarize.js';
/** Ollama base URL for this request — user-configurable, trailing slashes stripped. */
function ollamaBase(settings) {
    return (settings.ollamaEndpoint || AI_DEFAULTS.OLLAMA_ENDPOINT).replace(/\/+$/, '');
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
// ─── Connection test / model listing ─────────────────────────────────────────
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
        // Its API exists only in a window, so popup.ts checks it via builtin.ts.
        case 'builtin':
            return { ok: false, message: 'The built-in model is checked from the popup.' };
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
// ─── Orchestration ────────────────────────────────────────────────────────────
async function summarize(reviews, placeName, settings, googleRating, googleReviewCount) {
    const provider = settings.aiProvider ?? 'ollama';
    // The Prompt API is exposed to windows only, so the built-in model is called
    // from the popup (builtin.ts). Refuse it here rather than let the fallback
    // below quietly send its reviews to Ollama.
    if (provider === 'builtin') {
        throw new Error('The built-in model runs inside the popup, not the background worker.');
    }
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
