/**
 * Review Atlas uninstall survey endpoint.
 *
 * One route: POST / stores a survey answer in D1. The caller's IP address is used
 * as the rate-limit key and nothing else: it is never stored and never logged,
 * and nothing about a request is written with console.log.
 */

/**
 * Reason slugs. Keep identical to the checkbox values in docs/uninstall.html (the
 * comment above them points back here).
 */
const REASONS = ['setup', 'quality', 'slow', 'broken', 'cost', 'privacy', 'once', 'switched', 'other'];

const MAX_BODY_BYTES = 4096;
const MAX_NOTE_CHARS = 1000;
const VERSION_PATTERN = /^\d{1,3}(\.\d{1,3}){0,3}$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fail(status: number, message: string, cors: Record<string, string>): Response {
  return json(status, { error: message }, cors);
}

/** Reads the body as text, giving up as soon as it passes the limit. Returns null when too large. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/') return json(404, { error: 'Not found' });

    const origin = request.headers.get('Origin');
    const allowed = origin !== null && origin === env.ALLOWED_ORIGIN;
    const cors: Record<string, string> = allowed
      ? { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN, Vary: 'Origin' }
      : { Vary: 'Origin' };

    if (request.method === 'OPTIONS') {
      if (!allowed) return fail(403, 'Origin not allowed', cors);
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return json(405, { error: 'Method not allowed' }, { Allow: 'POST, OPTIONS' });
    }

    if (!allowed) return fail(403, 'Origin not allowed', cors);

    // The address is the limiter's key and goes nowhere else.
    const { success } = await env.LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
    if (!success) return fail(429, 'Too many requests', cors);

    const text = await readCapped(request, MAX_BODY_BYTES);
    if (text === null) return fail(413, 'Body too large', cors);

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return fail(400, 'Body is not valid JSON', cors);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return fail(400, 'Body must be a JSON object', cors);
    }
    const body = data as Record<string, unknown>;

    // Honeypot: a person never fills it. Look successful and store nothing.
    if (typeof body.website === 'string' && body.website !== '') {
      return new Response(null, { status: 204, headers: cors });
    }

    const rawReasons = body.reasons ?? [];
    if (!Array.isArray(rawReasons) || !rawReasons.every((r) => typeof r === 'string' && REASONS.includes(r))) {
      return fail(400, 'Unknown reason', cors);
    }
    const reasons = [...new Set(rawReasons as string[])];

    const rawNote = body.note ?? '';
    if (typeof rawNote !== 'string') return fail(400, 'Note must be text', cors);
    const note = rawNote.trim();
    if (note.length > MAX_NOTE_CHARS) return fail(400, 'Note is too long', cors);

    if (reasons.length === 0 && note === '') return fail(400, 'Nothing to store', cors);

    const version = typeof body.v === 'string' && VERSION_PATTERN.test(body.v) ? body.v : null;
    const createdOn = new Date().toISOString().slice(0, 10);

    try {
      await env.DB
        .prepare('INSERT INTO responses (created_on, version, reasons, note) VALUES (?, ?, ?, ?)')
        .bind(createdOn, version, JSON.stringify(reasons), note === '' ? null : note)
        .run();
    } catch {
      return fail(500, 'Could not save the answer', cors);
    }

    return new Response(null, { status: 204, headers: cors });
  },
} satisfies ExportedHandler<Env>;
