#!/usr/bin/env node
/**
 * Render the promo video from the extension's own popup.
 *
 * Like make-store-assets.py, the popup's CSS and markup are read straight out
 * of popup.html, so every frame shows the interface people install — only the
 * content is sample data, and the business is fictional on purpose.
 *
 *     node tools/make-promo-video.mjs                  # store-assets/promo-video.mp4
 *     node tools/make-promo-video.mjs --stills 2,11,23  # PNG stills, for checking
 *
 * Every frame is a pure function of its timestamp: the page exposes seek(t),
 * which sets every element's state for that instant, and Chrome is stepped
 * through the timeline over the DevTools protocol. CSS animations are switched
 * off, so nothing depends on how fast the machine renders.
 *
 * Needs Google Chrome, ffmpeg with libx264, and Node 22+ (for the built-in
 * WebSocket). Nothing to install.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO, 'store-assets');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// The stage is laid out at 1280x720 and captured at 1.5x, so text is drawn at
// 1080p rather than scaled up to it.
const STAGE_W = 1280;
const STAGE_H = 720;
const SCALE = 1.5;
const FPS = 30;
const DURATION = 40;

const VERSION = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8')).version;

// "Free on the Chrome Web Store" only becomes true once the listing is
// approved; until then the video must not say it.
const END_LINE = 'Free Chrome extension';
const END_URL = 'lauming1111.github.io/ReviewAtlas';

const PLACE = 'Harbour View Bistro';

// A faint static grain over the background. Dark radial gradients quantise
// into visible rings at 8 bits, and YouTube's re-encode makes them worse;
// noise below one percent of the range breaks the steps up before any encoder
// sees them. Static, so it costs almost nothing to compress.
const GRAIN = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>"
  + "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/>"
  + "<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.035 0'/></filter>"
  + "<rect width='100%' height='100%' filter='url(#g)'/></svg>",
);

// Fictional reviews for the opening wall. They agree with the summary shown
// later, so the video never claims the AI found something the reviews lack.
const REVIEWS = [
  ['Priya S.', 5, 'The seafood platter was the best I have had in years. Marta remembered us from last summer.'],
  ['Tom H.', 3, 'Waited 40 minutes for a table at Sunday brunch. Worth it, but plan ahead.'],
  ['Elena R.', 5, 'Ask for the terrace. Oysters at sunset over the harbour — perfect.'],
  ['Marcus B.', 4, 'Loud on a Friday night, hard to hear each other. Great fish though.'],
  ['Aisha K.', 5, 'Declan is the best server in town. Knew our order before we sat down.'],
  ['Ben L.', 4, 'Card only, so leave the cash at home. Chowder was rich and generous.'],
  ['Sofia M.', 5, 'Fresh, simple, perfectly cooked halibut. We will be back.'],
  ['James W.', 3, 'Brunch queue was out the door. Weekdays are much calmer.'],
  ['Hana T.', 5, 'Best fish and chips on the waterfront, hands down.'],
  ['Liam O.', 3, 'Lovely staff, but the room gets really noisy once it fills up.'],
  ['Grace N.', 5, 'Booked for our anniversary and they brought out a little dessert. So kind.'],
  ['Chloe D.', 3, 'Service slowed down a lot once it got busy.'],
  ['Ravi P.', 5, 'The grilled octopus alone is worth the trip.'],
  ['Nina G.', 4, 'Terrace tables go fast, so ask when you book.'],
  ['Owen C.', 5, 'Marta talked us through the specials like old friends. Superb mussels.'],
  ['Mei L.', 4, 'Great food, slightly pricey, view makes up for it.'],
];

const PROS = ['Seafood is consistently excellent', 'Staff remember regulars by name',
  'Terrace tables worth asking for'];
const CONS = ['Weekend brunch waits of 30+ minutes', 'Noisy when the room is full',
  'Card-only, which surprises people'];
const THEMES = ['seafood', 'service', 'waiting times', 'noise', 'terrace', 'value'];
const STAFF = ['Marta', 'Declan'];
const SUMMARY = 'Praised again and again for the seafood and for staff who remember regulars, '
  + 'with steady complaints about the wait at weekend brunch and a room that gets loud.';

// ─── Stage page ──────────────────────────────────────────────────────────────

const STAGE_CSS = `
  /* Every frame is set by seek(t); nothing may move on its own. */
  *, *::before, *::after { animation: none !important; transition: none !important; }

  html, body.stage {
    width: ${STAGE_W}px; height: ${STAGE_H}px; max-height: none; min-height: 0;
    margin: 0; padding: 0; overflow: hidden; display: block; position: relative;
    background:
      url("${GRAIN}"),
      radial-gradient(900px 620px at 76% 34%, #241d47 0%, transparent 62%),
      radial-gradient(760px 560px at 18% 72%, #1b1733 0%, transparent 60%),
      #0c0b14;
  }
  .layer { position: absolute; inset: 0; opacity: 0; }

  /* Title and end cards */
  .card { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .card img { width: 88px; height: 88px; border-radius: 20px; box-shadow: 0 14px 44px rgba(108, 99, 255, 0.45); }
  .card h1 {
    font-family: 'Syne', sans-serif; font-weight: 800; color: #fff;
    font-size: 58px; letter-spacing: -0.02em; margin: 26px 0 10px;
  }
  .card .sub { font-size: 21px; color: #9a9ac0; }
  .card .url { font: 500 17px ui-monospace, SFMono-Regular, Menlo, monospace; color: #a78bfa; margin-top: 14px; }
  .card > * { opacity: 0; }

  /* Opening wall of reviews */
  .wall { display: flex; gap: 18px; padding: 0 40px; justify-content: center; }
  .wall .col { width: 280px; display: flex; flex-direction: column; gap: 16px; }
  .review {
    background: #17161f; border: 1px solid #2a2a3a; border-radius: 12px; padding: 14px 16px;
    font-size: 13.5px; line-height: 1.45; color: #c9c9e0;
  }
  .review .who { display: flex; align-items: center; gap: 9px; margin-bottom: 7px; }
  .review .av {
    width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
    font-size: 12px; font-weight: 700; color: #fff; background: #3b3566;
  }
  .review .name { font-weight: 600; color: #f0f0f8; font-size: 13px; }
  .review .stars { color: #fbbf24; font-size: 12px; letter-spacing: 1px; margin-left: auto; }
  .wall-veil {
    position: absolute; inset: 0;
    background:
      linear-gradient(180deg, #0c0b14 0%, rgba(12,11,20,0.2) 22%, rgba(12,11,20,0.2) 78%, #0c0b14 100%),
      radial-gradient(700px 230px at 50% 50%, rgba(12,11,20,0.97) 0%, rgba(12,11,20,0.92) 55%, rgba(12,11,20,0.3) 100%);
  }
  .wall-text { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .wall-text .place { font-size: 19px; color: #9a9ac0; opacity: 0; }
  .wall-text h2 {
    font-family: 'Syne', sans-serif; font-weight: 800; color: #fff;
    font-size: 54px; line-height: 1.12; letter-spacing: -0.02em; margin-top: 14px; opacity: 0;
  }

  /* Demo: caption left, popup right — the layout of the store screenshots */
  .caption { position: absolute; left: 156px; top: 50%; width: 516px; opacity: 0; }
  .caption .badge {
    display: inline-flex; align-items: center; gap: 7px;
    background: rgba(108, 99, 255, .14); border: 1px solid rgba(108, 99, 255, .34);
    color: #cfc9ff; border-radius: 999px; padding: 8px 15px; font-size: 13.5px; font-weight: 600;
  }
  .caption h2 {
    font-family: 'Syne', sans-serif; font-weight: 800; color: #fff;
    font-size: 36px; line-height: 1.18; letter-spacing: -0.015em; margin: 22px 0 18px;
  }
  .caption h2 .line { display: block; }
  .caption p { font-size: 17px; line-height: 1.55; color: #9a9ac0; margin: 0; }

  .popup {
    position: absolute; left: 744px; top: 50%;
    width: 380px; display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg); border-radius: 15px; border: 1px solid rgba(255, 255, 255, .07);
    box-shadow: 0 34px 80px rgba(0, 0, 0, .58);
  }

  /* Same pill as the caption badges: the emoji version rendered as a blue tile. */
  .sped-up { position: absolute; left: 744px; width: 380px; text-align: right; opacity: 0; }
  .sped-up span {
    display: inline-flex; align-items: center; gap: 6px;
    background: rgba(108, 99, 255, .14); border: 1px solid rgba(108, 99, 255, .34);
    color: #cfc9ff; border-radius: 999px; padding: 4px 11px 4px 9px; font-size: 12px; font-weight: 600;
  }
  .sped-up svg { width: 12px; height: 12px; }

  .cursor { position: absolute; left: 0; top: 0; width: 24px; height: 24px; opacity: 0; z-index: 10; }
  .ripple {
    position: absolute; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px;
    border-radius: 50%; border: 2px solid rgba(167, 139, 250, 0.9); opacity: 0; z-index: 9;
  }
`;

const STAGE_JS = String.raw`
  // Report a failure to the runner instead of leaving it waiting for __ready.
  window.addEventListener('error', (e) => { window.__error = e.message + ' @' + e.lineno; });

  const PROS = __PROS__, CONS = __CONS__, THEMES = __THEMES__, STAFF = __STAFF__;

  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const E = {
    out: (p) => 1 - Math.pow(1 - p, 3),
    inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    lin: (p) => p,
  };
  const prog = (t, start, dur, ease = E.out) => ease(clamp01((t - start) / dur));
  const lerp = (a, b, p) => a + (b - a) * p;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Fade and rise in at inAt, fade out ending at outAt. */
  function appear(el, t, inAt, outAt = Infinity, { dur = 0.55, dy = 14, outDur = 0.4 } = {}) {
    const pin = prog(t, inAt, dur);
    const pout = outAt === Infinity ? 0 : prog(t, outAt - outDur, outDur, E.inOut);
    el.style.opacity = String(pin * (1 - pout));
    el.style.transform = 'translateY(' + ((1 - pin) * dy - pout * dy * 0.4) + 'px)';
    return pin * (1 - pout);
  }

  const popup = $('.popup');
  const screens = {};
  $$('.popup .screen').forEach((s) => { screens[s.dataset.screen] = s; });

  // ── One-time fill: the same content the store screenshots use ──
  (function fill() {
    const set = (sel, text) => { const el = $(sel, popup); if (el) el.textContent = text; };
    set('[data-field="app-version"]', ' · v__VERSION__');

    set('[data-field="info-place-name"]', __PLACE__);
    const cat = $('[data-field="info-category"]', popup);
    if (cat) { cat.textContent = 'Seafood restaurant'; cat.hidden = false; }
    set('[data-field="info-stars"]', '★★★★½');
    set('[data-field="info-rating"]', '4.5');
    set('[data-field="info-review-count"]', '1,043 reviews');

    set('[data-field="place-name"]', __PLACE__);
    set('[data-field="stars"]', '★★★★½');
    set('[data-field="rating"]', '4.5 / 5');
    set('[data-field="review-count"]', '247 of 1,043 reviews analyzed');
    const badge = $('[data-field="sentiment"]', popup);
    badge.textContent = '😊 Mostly Positive';
    badge.className = 'sentiment-badge sentiment-positive';
    set('[data-field="summary"]', __SUMMARY__);
    const li = (cls, mark) => (text) => {
      const el = document.createElement('li');
      const b = document.createElement('span');
      b.className = 'bullet ' + cls; b.textContent = mark;
      el.append(b, text);
      return el;
    };
    $('[data-field="pros"]', popup).replaceChildren(...PROS.map(li('pro-bullet', '✓')));
    $('[data-field="cons"]', popup).replaceChildren(...CONS.map(li('con-bullet', '✗')));
    const chip = (cls, prefix) => (text) => {
      const el = document.createElement('span');
      el.className = cls; el.textContent = prefix + text;
      return el;
    };
    $('[data-field="themes"]', popup).replaceChildren(...THEMES.map(chip('theme-chip', '')));
    $('#staff-section', popup).hidden = false;
    $('[data-field="staff"]', popup).replaceChildren(...STAFF.map(chip('staff-chip', '★ ')));
    set('#analyzed-at', 'Analyzed just now');

    const models = $('#ollama-model-select', popup);
    if (models) {
      models.replaceChildren(...['llama3.2:latest', 'qwen2.5:7b', 'mistral:latest'].map((m) => {
        const o = document.createElement('option'); o.textContent = m; return o;
      }));
    }
    const status = $('#ollama-test-status', popup);
    if (status) { status.textContent = '✓ Connected · 3 models available'; status.classList.add('ok'); }
  })();

  // Elements that are revealed one by one on the result screen.
  const result = screens.result;
  const resultBody = $('.result-body', result);
  const reveal = [
    [$('[data-field="summary"]', result), 21.1],
    [$('.pros-title', result), 22.1],
    ...$$('[data-field="pros"] li', result).map((el, i) => [el, 22.3 + i * 0.32]),
    [$('.cons-title', result), 24.1],
    ...$$('[data-field="cons"] li', result).map((el, i) => [el, 24.3 + i * 0.32]),
    [$('.themes-title', result), 26.5],
    ...$$('[data-field="themes"] .theme-chip', result).map((el, i) => [el, 26.7 + i * 0.13]),
    [$('.staff-title', result), 27.7],
    ...$$('[data-field="staff"] .staff-chip', result).map((el, i) => [el, 27.9 + i * 0.22]),
  ];

  function showOnly(name) {
    for (const [n, el] of Object.entries(screens)) el.hidden = n !== name;
  }

  /** The height Chrome would give the popup for this screen, read from layout. */
  function naturalHeight(name) {
    showOnly(name);
    popup.style.height = 'auto';
    return Math.ceil(popup.getBoundingClientRect().height);
  }

  // Result and settings scroll inside a fixed-height popup, as they do for real.
  const FULL = 590;
  let TIMELINE;

  /**
   * Where a control sits inside the popup, measured once while its screen is
   * showing. The cursor reads this rather than the live element, because the
   * element is gone the moment the screen it lives on switches away.
   */
  function anchor(name, height, el) {
    showOnly(name);
    popup.style.height = height + 'px';
    popup.style.transform = 'translateY(-50%)';
    const pr = popup.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { dx: r.left + r.width / 2 - pr.left, dy: r.top + r.height / 2 - pr.top };
  }
  const analyzeBtn = $('[data-action="analyze"]', popup);
  const settingsBtn = $('.result-screen .footer [data-action="open-settings"]', popup);
  let ANCHORS;
  let SCROLL;

  /** Everything read from layout, run once the fonts are in. */
  function init() {
    TIMELINE = [
      { at: 9.0, screen: 'info', height: naturalHeight('info') },
      { at: 12.15, screen: 'loading', height: naturalHeight('loading') },
      { at: 20.9, screen: 'result', height: FULL },
      { at: 30.6, screen: 'settings', height: FULL },
    ];
    ANCHORS = {
      analyze: anchor('info', TIMELINE[0].height, analyzeBtn),
      settings: anchor('result', FULL, settingsBtn),
    };
    // Two scroll stops on the result screen: the complaints, then the bottom.
    // Measured, so each section is in view before its items start arriving.
    showOnly('result');
    popup.style.height = FULL + 'px';
    resultBody.scrollTop = 0;
    const max = resultBody.scrollHeight - resultBody.clientHeight;
    const consTop = $('.cons-title', result).getBoundingClientRect().top - resultBody.getBoundingClientRect().top;
    SCROLL = { cons: Math.min(max, Math.max(0, consTop - 70)), max };
  }

  const PROVIDERS = ['ollama', 'openai', 'anthropic', 'gemini', 'groq', 'xai', 'custom', 'ollama'];
  const PROVIDER_START = 31.3;
  const PROVIDER_STEP = 0.5;

  const cursor = $('.cursor');
  const ripple = $('.ripple');

  /**
   * A cursor that glides to a control, presses it and fades. The target point is
   * the measured anchor plus the popup's current position, so it follows the
   * popup if its markup changes.
   */
  function cursorEpisode(t, target, spot, { show, arrive, press, hide, from }) {
    if (t < show || t > hide + 0.4) return false;
    const pr = popup.getBoundingClientRect();
    const end = { x: pr.left + spot.dx, y: pr.top + spot.dy };
    const start = { x: end.x + from[0], y: end.y + from[1] };
    const p = prog(t, show + 0.2, arrive - show - 0.2, E.inOut);
    const x = lerp(start.x, end.x, p);
    const y = lerp(start.y, end.y, p);
    const down = t >= press && t < press + 0.16;
    const opacity = Math.min(prog(t, show, 0.25), 1 - prog(t, hide, 0.35, E.inOut));
    cursor.style.opacity = String(opacity);
    cursor.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px) scale(' + (down ? 0.86 : 1) + ')';
    const rp = prog(t, press, 0.5);
    ripple.style.opacity = t >= press ? String((1 - rp) * 0.9) : '0';
    ripple.style.transform = 'translate(' + end.x + 'px,' + end.y + 'px) scale(' + (0.4 + rp * 0.9) + ')';
    target.style.transform = down ? 'scale(0.97)' : '';
    target.style.filter = t >= arrive - 0.15 && t < press + 0.3 ? 'brightness(1.12)' : '';
    return true;
  }

  function setLoading(t) {
    const s1 = $('#step-1', popup), s2 = $('#step-2', popup);
    const d1 = $('#step-1-detail', popup), d2 = $('#step-2-detail', popup);
    const t1 = $('#step-1-time', popup), t2 = $('#step-2-time', popup);
    const dot1 = $('.step-dot', s1);
    const now = $('#summarize-now-btn', popup);
    const STEP2 = 19.6;

    // The spinner never stops in the real popup; here its angle is just t.
    $('.spinner', popup).style.transform = 'rotate(' + (t * 450) + 'deg)';

    // Gathering is shown sped up: 7.5 seconds of video stand for 48 real ones.
    const real = Math.round(lerp(0, 48, clamp01((t - 12.15) / (STEP2 - 12.15))));
    if (t < STEP2) {
      s1.className = 'step step-active';
      s2.className = 'step step-pending';
      dot1.textContent = '●';
      t1.textContent = real + 's';
      t2.textContent = '';
      d2.textContent = 'Waiting…';
      now.hidden = t < 13.6;
      if (t < 13.6) d1.textContent = 'Checking Ollama…';
      else if (t < 14.3) d1.textContent = 'Scrolling through reviews…';
      else d1.textContent = Math.round(1043 * prog(t, 14.3, STEP2 - 14.6, E.out)).toLocaleString('en-US') + ' reviews found';
    } else {
      s1.className = 'step step-done';
      s2.className = 'step step-active';
      dot1.textContent = '✓';
      t1.textContent = '48s';
      d1.textContent = '1,043 reviews found';
      d2.textContent = 'Summarizing with AI…';
      t2.textContent = Math.round(lerp(0, 9, clamp01((t - STEP2) / 1.3))) + 's';
      now.hidden = true;
    }
  }

  function setResult(t) {
    for (const [el, at] of reveal) {
      if (!el) continue;
      const p = prog(t, at, 0.45);
      el.style.opacity = String(p);
      el.style.transform = 'translateY(' + ((1 - p) * 8) + 'px)';
    }
    const toCons = lerp(0, SCROLL.cons, prog(t, 23.4, 0.7, E.inOut));
    resultBody.scrollTop = lerp(toCons, SCROLL.max, prog(t, 25.9, 0.8, E.inOut));
  }

  function setSettings(t) {
    const step = Math.floor((t - PROVIDER_START) / PROVIDER_STEP);
    const active = PROVIDERS[Math.max(0, Math.min(PROVIDERS.length - 1, step))];
    $$('#ai-provider-group .scope-btn', popup).forEach((b) => b.classList.toggle('active', b.dataset.value === active));
    // The config card under the grid follows the selection, as it does in the popup.
    for (const p of new Set(PROVIDERS)) {
      const card = $('#' + p + '-config', popup);
      if (card) card.hidden = p !== active;
    }
    screens.settings.scrollTop = 0;
  }

  window.seek = function seek(t) {
    // ── Title ──
    const title = $('#title');
    title.style.opacity = String(1 - prog(t, 3.5, 0.5, E.inOut));
    const [ic, h1, sub] = $$('#title > *');
    ic.style.opacity = String(prog(t, 0.2, 0.6));
    ic.style.transform = 'scale(' + lerp(0.86, 1, prog(t, 0.2, 0.7)) + ')';
    appear(h1, t, 0.5);
    appear(sub, t, 0.85);

    // ── Wall of reviews ──
    const wall = $('#wall');
    wall.style.opacity = String(Math.min(prog(t, 4.0, 0.6), 1 - prog(t, 8.5, 0.5, E.inOut)));
    $$('#wall .col').forEach((col, i) => {
      const speed = [26, 38, 30, 42][i % 4];
      col.style.transform = 'translateY(' + (-40 - (t - 4) * speed - (i % 2) * 60) + 'px)';
    });
    appear($('#wall .place'), t, 4.6, Infinity, { dy: 8 });
    appear($('#wall h2'), t, 5.2, Infinity, { dy: 18, dur: 0.7 });

    // ── Popup ──
    const popOpacity = Math.min(prog(t, 9.0, 0.6), 1 - prog(t, 35.4, 0.5, E.inOut));
    const popY = (1 - prog(t, 9.0, 0.7)) * 26;
    popup.style.opacity = String(popOpacity);
    popup.style.visibility = popOpacity > 0 ? 'visible' : 'hidden';

    let current = TIMELINE[0], previous = null;
    for (const entry of TIMELINE) if (t >= entry.at) { previous = current; current = entry; }
    for (const [name, el] of Object.entries(screens)) el.hidden = name !== current.screen;
    // The popup's own screen-in animation: 0.18s, 3px rise.
    const sp = prog(t, current.at, 0.18);
    screens[current.screen].style.opacity = String(current === TIMELINE[0] ? 1 : sp);
    screens[current.screen].style.transform = 'translateY(' + ((1 - sp) * 3) + 'px)';
    // Chrome resizes a popup to its content; ease the height so the change reads.
    const fromH = previous && previous !== current ? previous.height : current.height;
    const h = lerp(fromH, current.height, prog(t, current.at, 0.5, E.inOut));
    popup.style.height = h + 'px';
    popup.style.transform = 'translateY(calc(-50% + ' + popY + 'px))';

    if (current.screen === 'loading') setLoading(t);
    if (current.screen === 'result') setResult(t);
    if (current.screen === 'settings') setSettings(t);

    // Sped-up label sits just above the popup while gathering runs.
    const sped = $('.sped-up');
    sped.style.opacity = String(Math.min(prog(t, 13.8, 0.4), 1 - prog(t, 19.5, 0.35)));
    sped.style.top = (__STAGE_H__ / 2 - h / 2 - 30) + 'px';

    // ── Captions ──
    const caps = $$('.caption');
    const capTimes = [[9.3, 12.3], [12.5, 20.9], [21.1, 30.5], [30.8, 35.9]];
    caps.forEach((cap, i) => {
      const [a, b] = capTimes[i];
      const pin = prog(t, a, 0.55), pout = prog(t, b - 0.35, 0.35, E.inOut);
      cap.style.opacity = String(pin * (1 - pout));
      cap.style.transform = 'translateY(calc(-50% + ' + ((1 - pin) * 14 - pout * 6) + 'px))';
    });
    // Caption 3 lights each line as its part of the summary arrives.
    $$('.caption.beats .line').forEach((line, i) => {
      line.style.opacity = String(lerp(0.32, 1, prog(t, [21.9, 23.9, 27.5][i], 0.4)));
    });

    // ── Cursor ──
    cursor.style.opacity = '0';
    ripple.style.opacity = '0';
    analyzeBtn.style.transform = ''; analyzeBtn.style.filter = '';
    settingsBtn.style.transform = ''; settingsBtn.style.filter = '';
    cursorEpisode(t, analyzeBtn, ANCHORS.analyze, { show: 10.0, arrive: 11.5, press: 11.75, hide: 12.25, from: [150, 120] });
    cursorEpisode(t, settingsBtn, ANCHORS.settings, { show: 29.3, arrive: 30.15, press: 30.35, hide: 30.55, from: [-170, -110] });

    // ── End card ──
    const end = $('#end');
    end.style.opacity = String(prog(t, 36.0, 0.5));
    const [eic, eh1, esub, eurl] = $$('#end > *');
    eic.style.opacity = String(prog(t, 36.1, 0.6));
    eic.style.transform = 'scale(' + lerp(0.86, 1, prog(t, 36.1, 0.7)) + ')';
    appear(eh1, t, 36.35);
    appear(esub, t, 36.65);
    appear(eurl, t, 36.9);
  };

  // Load every face the timeline uses before measuring anything: a screen that
  // is hidden at t=0 would otherwise first lay out in a fallback font.
  Promise.all([
    '800 36px Syne', '700 16px Syne', '400 14px "DM Sans"', '500 14px "DM Sans"', '600 14px "DM Sans"',
  ].map((face) => document.fonts.load(face))).then(() => document.fonts.ready).then(() => {
    init();
    window.seek(0);
    window.__ready = true;
  }).catch((err) => { window.__error = String(err && err.stack || err); });
`;

function reviewCard([name, stars, text]) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<div class="review"><div class="who"><span class="av">${name[0]}</span>`
    + `<span class="name">${esc(name)}</span><span class="stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</span></div>`
    + `${esc(text)}</div>`;
}

function buildStage() {
  const popupHtml = readFileSync(join(REPO, 'popup.html'), 'utf8');
  const css = popupHtml.match(/<style>([\s\S]*?)<\/style>/)[1];
  const body = popupHtml.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script[^>]*><\/script>/g, '');

  // Four columns of reviews, each long enough to keep the frame full for the
  // whole five seconds of drift (the fastest column climbs ~310px).
  const cols = [0, 1, 2, 3].map((c) => {
    const cards = [];
    for (let i = 0; i < 9; i++) cards.push(reviewCard(REVIEWS[(c * 5 + i * 3) % REVIEWS.length]));
    return `<div class="col">${cards.join('')}</div>`;
  }).join('');

  const js = STAGE_JS
    .replace('__PROS__', JSON.stringify(PROS))
    .replace('__CONS__', JSON.stringify(CONS))
    .replace('__THEMES__', JSON.stringify(THEMES))
    .replace('__STAFF__', JSON.stringify(STAFF))
    .replace('__VERSION__', VERSION)
    .replace('__STAGE_H__', String(STAGE_H))
    .replaceAll('__PLACE__', JSON.stringify(PLACE))
    .replace('__SUMMARY__', JSON.stringify(SUMMARY));

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<style>${css}</style>
<style>${STAGE_CSS}</style>
</head>
<body class="stage">
  <div class="layer card" id="title">
    <img src="icons/icon128.png" alt="" />
    <h1>Review Atlas</h1>
    <div class="sub">AI review summaries for Google Maps</div>
  </div>

  <div class="layer" id="wall">
    <div class="wall">${cols}</div>
    <div class="wall-veil"></div>
    <div class="wall-text">
      <div class="place">${PLACE} · 1,043 reviews</div>
      <h2>Nobody reads<br />1,043 reviews.</h2>
    </div>
  </div>

  <div class="caption">
    <span class="badge">★ One click</span>
    <h2>So it reads them<br />for you.</h2>
    <p>Open any place on Google Maps, click the extension, press Analyze.</p>
  </div>
  <div class="caption">
    <span class="badge">⏱ While you wait</span>
    <h2>It checks your AI,<br />then gathers<br />every review.</h2>
    <p>If your AI is not reachable it says so in a second, before any time is spent collecting.</p>
  </div>
  <div class="caption beats">
    <span class="badge">◆ The summary</span>
    <h2><span class="line">What people love.</span><span class="line">What they complain about.</span><span class="line">Who they name.</span></h2>
    <p>Drawn from what reviewers actually wrote — not the star average.</p>
  </div>
  <div class="caption">
    <span class="badge">🔒 Your choice of AI</span>
    <h2>Your own computer —<br />or the AI you<br />already use.</h2>
    <p>With Ollama or LM Studio the reviews never leave your machine. OpenAI, Claude, Gemini, Groq and Grok work too.</p>
  </div>

  <div class="sped-up"><span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 2l5 4-5 4zM6 2l5 4-5 4z" fill="currentColor"/></svg>Sped up</span></div>
  <div class="popup">${body}</div>

  <svg class="cursor" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 2l16 9.5-7 1.6L8.6 20z" fill="#fff" stroke="#0c0b14" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>
  <div class="ripple"></div>

  <div class="layer card" id="end">
    <img src="icons/icon128.png" alt="" />
    <h1>Review Atlas</h1>
    <div class="sub">${END_LINE}</div>
    <div class="url">${END_URL}</div>
  </div>
<script>${js}</script>
</body></html>`;
}

// ─── Chrome over the DevTools protocol ───────────────────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const waiter = msg.id && this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else waiter.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }));
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }
}

async function launchChrome(pageUrl, profileDir) {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    `--window-size=${STAGE_W},${STAGE_H}`, pageUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // Chrome picks a free port and prints it; nothing else on stderr is needed.
  const port = await new Promise((resolvePort, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not report a DevTools port')), 15000);
    chrome.stderr.on('data', (chunk) => {
      seen += chunk;
      const match = seen.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
    });
    chrome.on('exit', (code) => reject(new Error(`Chrome exited early (${code})`)));
  });

  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
    if (!target) await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) throw new Error('Stage page never appeared in Chrome');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, 'open');
  return { chrome, cdp: new Cdp(ws), ws };
}

async function waitForStage(cdp) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const error = await cdp.evaluate('window.__error || null');
    if (error) throw new Error(`Stage script failed: ${error}`);
    if (await cdp.evaluate('window.__ready === true')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Stage never became ready (fonts or script failed)');
}

async function frameAt(cdp, t) {
  await cdp.evaluate(`window.seek(${t})`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
  return Buffer.from(data, 'base64');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const stillsArg = process.argv.indexOf('--stills');
  const stills = stillsArg > -1 ? process.argv[stillsArg + 1].split(',').map(Number) : null;

  const work = mkdtempSync(join(tmpdir(), 'promo-video-'));
  cpSync(join(REPO, 'fonts'), join(work, 'fonts'), { recursive: true });
  cpSync(join(REPO, 'icons'), join(work, 'icons'), { recursive: true });
  const stagePath = join(work, 'stage.html');
  writeFileSync(stagePath, buildStage(), 'utf8');

  const { chrome, cdp, ws } = await launchChrome(pathToFileURL(stagePath).href, join(work, 'profile'));
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: STAGE_W, height: STAGE_H, deviceScaleFactor: SCALE, mobile: false,
    });
    await waitForStage(cdp);
    mkdirSync(OUT_DIR, { recursive: true });

    if (stills) {
      const dir = join(OUT_DIR, 'promo-stills');
      mkdirSync(dir, { recursive: true });
      for (const t of stills) {
        const file = join(dir, `t${String(t).replace('.', '_')}.png`);
        writeFileSync(file, await frameAt(cdp, t));
        console.log(`wrote ${file.slice(REPO.length + 1)}`);
      }
      return;
    }

    const out = join(OUT_DIR, 'promo-video.mp4');
    // Tagged BT.709 throughout: untagged HD is read as BT.601 by some players,
    // which shifts the purples.
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart', out,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });

    const total = DURATION * FPS;
    const started = Date.now();
    for (let i = 0; i < total; i++) {
      const png = await frameAt(cdp, i / FPS);
      if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain');
      if (i % FPS === 0) process.stdout.write(`\rframe ${i}/${total}`);
    }
    ffmpeg.stdin.end();
    const [code] = await once(ffmpeg, 'exit');
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
    console.log(`\rwrote ${out.slice(REPO.length + 1)} — ${total} frames in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    ws.close();
    // Chrome keeps writing its profile until it has actually exited.
    if (chrome.exitCode === null) {
      chrome.kill();
      await once(chrome, 'exit');
    }
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
