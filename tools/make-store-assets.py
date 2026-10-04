#!/usr/bin/env python3
"""Render the Chrome Web Store assets from the extension's own popup.

The popup's CSS and markup are read straight out of popup.html, so a shot always
shows the current interface — only the content is sample data. Rerun this after
any UI change, otherwise the listing drifts away from what users install.

    python3 tools/make-store-assets.py

Writes five 1280x800 screenshots and the 440x280 promo tile into store-assets/.
Needs Google Chrome installed; nothing else.
"""
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / 'store-assets'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

VERSION = json.loads((REPO / 'manifest.json').read_text(encoding='utf-8'))['version']

# The sample business is fictional on purpose: putting invented pros and cons
# beside a real company's name makes a claim about that company.
PLACE = 'Harbour View Bistro'

SHOT_CSS = """
  html, body.shot { width: 1280px; height: 800px; max-height: none; margin: 0; padding: 0; overflow: hidden; }
  body.shot {
    display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 72px;
    background:
      radial-gradient(900px 620px at 76% 34%, #241d47 0%, transparent 62%),
      radial-gradient(760px 560px at 18% 72%, #1b1733 0%, transparent 60%),
      #0c0b14;
  }
  .copy { width: 516px; }
  .copy .badge {
    display: inline-flex; align-items: center; gap: 7px;
    background: rgba(108, 99, 255, .14); border: 1px solid rgba(108, 99, 255, .34);
    color: #cfc9ff; border-radius: 999px; padding: 8px 15px;
    font-size: 13.5px; font-weight: 600;
  }
  .copy h2 {
    font-family: 'Syne', sans-serif; font-weight: 800; color: #fff;
    font-size: 35px; line-height: 1.18; letter-spacing: -0.015em; margin: 22px 0 18px;
  }
  .copy p { font-size: 17px; line-height: 1.55; color: #9a9ac0; margin: 0; }
  .popup {
    width: 380px; flex: none; display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg); border-radius: 15px; border: 1px solid rgba(255, 255, 255, .07);
    box-shadow: 0 34px 80px rgba(0, 0, 0, .58);
  }
"""

FILL_COMMON = f"""
  document.querySelectorAll('.screen').forEach((s) => {{ s.hidden = true; }});
  const show = (name) => {{ const s = document.querySelector(`[data-screen="${{name}}"]`); if (s) s.hidden = false; }};
  const set = (sel, text) => {{ const el = document.querySelector(sel); if (el) el.textContent = text; }};
  set('[data-field="app-version"]', ' \\u00b7 v{VERSION}');
  const models = document.querySelector('#ollama-model-select');
  if (models) {{
    models.innerHTML = ['llama3.2:latest', 'qwen2.5:7b', 'mistral:latest']
      .map((m) => `<option>${{m}}</option>`).join('');
  }}
"""

PROS = ['Seafood is consistently excellent', 'Staff remember regulars by name',
        'Terrace tables worth asking for']
CONS = ['Weekend brunch waits of 30+ minutes', 'Noisy when the room is full',
        'Card-only, which surprises people']
THEMES = ['seafood', 'service', 'waiting times', 'noise', 'terrace', 'value']
STAFF = ['Marta', 'Declan']
SUMMARY = ('Praised again and again for the seafood and for staff who remember regulars, '
           'with steady complaints about the wait at weekend brunch and a room that gets loud.')

SHOTS = [
    dict(
        name='screenshot-1-summary',
        badge='★ Instant summary',
        headline='Hundreds of reviews,<br />one clear answer.',
        sub='Pros, cons, recurring themes and the staff people actually name — drawn from the review text, not the star average.',
        fill=f"""
  show('result');
  set('[data-field="place-name"]', {json.dumps(PLACE)});
  set('[data-field="stars"]', '★★★★½');
  set('[data-field="rating"]', '4.5 / 5');
  set('[data-field="review-count"]', '247 of 1,043 reviews analyzed');
  const badge = document.querySelector('[data-field="sentiment"]');
  badge.textContent = '😊 Mostly Positive';
  badge.className = 'sentiment-badge sentiment-positive';
  set('[data-field="summary"]', {json.dumps(SUMMARY)});
  document.querySelector('[data-field="pros"]').innerHTML =
    {json.dumps(PROS)}.map((p) => `<li><span class="bullet pro-bullet">✓</span>${{p}}</li>`).join('');
  document.querySelector('[data-field="cons"]').innerHTML =
    {json.dumps(CONS)}.map((c) => `<li><span class="bullet con-bullet">✗</span>${{c}}</li>`).join('');
  document.querySelector('[data-field="themes"]').innerHTML =
    {json.dumps(THEMES)}.map((t) => `<span class="theme-chip">${{t}}</span>`).join('');
  document.getElementById('staff-section').hidden = false;
  document.querySelector('[data-field="staff"]').innerHTML =
    {json.dumps(STAFF)}.map((n) => `<span class="staff-chip">★ ${{n}}</span>`).join('');
  set('#analyzed-at', 'Analyzed 2m ago');
""",
    ),
    dict(
        name='screenshot-2-providers',
        badge='◆ Your choice of AI',
        headline='Seven ways to answer.<br />One is your laptop.',
        sub='OpenAI, Claude, Gemini, Groq and Grok — or a model running on your own machine, where the review text never leaves.',
        fill="""
  show('settings');
  document.querySelectorAll('#ai-provider-group .scope-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  const settings = document.querySelector('[data-screen="settings"]');
  requestAnimationFrame(() => { settings.scrollTop = 0; });
""",
    ),
    dict(
        name='screenshot-3-local-model',
        badge='🔒 Local-first',
        headline='A model running on<br />your own machine.',
        sub='Ollama, LM Studio, llama.cpp, Jan, vLLM and friends. Pick the runtime, the address fills itself in, and the model list loads from your server.',
        fill="""
  show('settings');
  document.querySelectorAll('#ai-provider-group .scope-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  set('#ollama-test-status', '✓ Connected · 3 models available');
  const status = document.querySelector('#ollama-test-status');
  if (status) status.classList.add('ok');
  const settings = document.querySelector('[data-screen="settings"]');
  const anchor = document.querySelector('#ollama-config');
  requestAnimationFrame(() => { if (anchor) settings.scrollTop = anchor.offsetTop - 92; });
""",
    ),
    dict(
        name='screenshot-4-collecting',
        badge='⏱ While you wait',
        headline='It checks your AI,<br />then starts scrolling.',
        sub='A provider that is down is reported in a second, before a minute of collecting is spent on it.',
        height=404,
        fill="""
  show('loading');
  set('#step-1-detail', '1,043 reviews found');
  set('#step-1-time', '48s');
  set('#step-2-detail', 'Waiting…');
""",
    ),
    dict(
        name='screenshot-5-history',
        badge='⚡ Kept for a day',
        headline='Places you already<br />asked about.',
        sub='Summaries and the reviews behind them are cached for 24 hours on your own machine, so a second look is instant.',
        fill="""
  show('history');
  const items = [
    ['Harbour View Bistro', '★★★★½', '4.5', '1,043 reviews', '2m ago', 'sentiment-positive'],
    ['Kestrel Coffee Roasters', '★★★★', '4.2', '612 reviews', '1h ago', 'sentiment-positive'],
    ['Northgate Dental Practice', '★★★', '3.4', '208 reviews', '3h ago', 'sentiment-mixed'],
    ['Riverside Garage', '★★', '2.6', '95 reviews', '1d ago', 'sentiment-negative'],
    ['Pier 9 Seafood Market', '★★★★', '4.1', '1,877 reviews', '1d ago', 'sentiment-positive'],
  ];
  document.getElementById('history-list').innerHTML = items.map(([name, stars, rating, count, when, cls]) => `
      <div class="history-item ${cls}">
        <div style="min-width:0">
          <div class="history-item-name">${name}</div>
          <div class="history-item-meta">
            <span class="history-stars">${stars}</span>
            <span>${rating}</span><span>·</span><span>${count}</span><span>·</span><span>${when}</span>
          </div>
        </div>
        <button class="history-delete" title="Remove">✕</button>
      </div>`).join('');
""",
    ),
]

PROMO_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face { font-family:'Syne'; src:url('fonts/Syne.woff2') format('woff2-variations'); font-weight:400 800; }
@font-face { font-family:'DM Sans'; src:url('fonts/DMSans.woff2') format('woff2-variations'); font-weight:100 1000; }
html,body{width:440px;height:280px;margin:0;overflow:hidden}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
  background:radial-gradient(420px 300px at 50% 18%, #241d47 0%, transparent 65%), #0c0b14;
  font-family:'DM Sans',system-ui,sans-serif;text-align:center}
img{width:62px;height:62px;border-radius:14px;box-shadow:0 8px 26px rgba(108,99,255,.42)}
h1{font-family:'Syne',sans-serif;font-weight:800;color:#fff;font-size:26px;line-height:1.22;margin:4px 0 0;letter-spacing:-.01em}
p{color:#9a9ac0;font-size:13px;margin:0;max-width:370px;line-height:1.45}
</style></head><body>
<img src="icon128.png" alt="" />
<h1>Hundreds of reviews,<br />one clear answer.</h1>
<p>Pros, cons and themes — from your own local AI model</p>
</body></html>"""


def capture(page: Path, out: Path, size: str) -> None:
    subprocess.run([
        CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--force-device-scale-factor=1', f'--window-size={size}',
        '--virtual-time-budget=2500', f'--screenshot={out}', page.as_uri(),
    ], check=True, capture_output=True)
    print(f'wrote {out.relative_to(REPO)}')


def build_screenshots() -> None:
    popup = (REPO / 'popup.html').read_text(encoding='utf-8')
    css = re.search(r'<style>(.*?)</style>', popup, re.S).group(1)
    body = re.sub(r'<script[^>]*></script>', '', re.search(r'<body>(.*?)</body>', popup, re.S).group(1))

    work = Path(tempfile.mkdtemp(prefix='store-shots-'))
    shutil.copytree(REPO / 'fonts', work / 'fonts')
    shutil.copytree(REPO / 'icons', work / 'icons')
    try:
        for shot in SHOTS:
            page = work / f"{shot['name']}.html"
            page.write_text(f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<style>{css}</style>
<style>{SHOT_CSS}</style>
</head>
<body class="shot">
  <div class="copy">
    <span class="badge">{shot['badge']}</span>
    <h2>{shot['headline']}</h2>
    <p>{shot['sub']}</p>
  </div>
  <div class="popup" style="height:{shot.get('height', 590)}px">{body}</div>
<script>
{FILL_COMMON}
{shot['fill']}
</script>
</body></html>""", encoding='utf-8')
            capture(page, OUT_DIR / f"{shot['name']}.png", '1280,800')
    finally:
        shutil.rmtree(work, ignore_errors=True)


def build_promo() -> None:
    work = Path(tempfile.mkdtemp(prefix='store-promo-'))
    shutil.copytree(REPO / 'fonts', work / 'fonts')
    shutil.copy(REPO / 'icons' / 'icon128.png', work / 'icon128.png')
    try:
        page = work / 'promo.html'
        page.write_text(PROMO_HTML, encoding='utf-8')
        capture(page, OUT_DIR / 'promo-440x280.png', '440,280')
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    build_screenshots()
    build_promo()
