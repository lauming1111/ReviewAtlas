# Chrome Web Store listing — working document

Not published to the site. This is the copy and the justifications to paste into
the Developer Dashboard.

Live URLs to use in the listing (available once GitHub Pages is switched on):

- **Privacy policy:** `https://lauming1111.github.io/GReviewSumm/privacy.html` *(required)*
- **Homepage:** `https://lauming1111.github.io/GReviewSumm/`
- **Support:** `https://lauming1111.github.io/GReviewSumm/support.html`

---

## Item name

```
GReviewSumm – AI Review Summarizer
```

## Short description (132 char max)

```
Turn hundreds of Google Maps reviews into pros, cons and themes — using your own local AI model or a provider you choose.
```

*(119 characters.)*

## Category

Productivity

## Language

English

---

## Detailed description

```
Busy places have hundreds of reviews you will never scroll through. GReviewSumm reads them for you and returns what people actually keep saying.

WHAT YOU GET
• Pros and cons — specific recurring points drawn from the review text, not a star average
• Top themes — the topics that come up most: parking, wait times, service
• Named staff — employees praised by name in multiple reviews
• Overall sentiment and the real review count analyzed

BRING YOUR OWN MODEL
Point it at a model running on your own computer and the review text never leaves your machine:
• Ollama
• LM Studio, llama.cpp, Jan, vLLM, KoboldCpp, LocalAI, text-generation-webui
• Any other OpenAI-compatible server

Pick your runtime and its default address is filled in for you. One click tests the connection and loads the model list from the server itself.

Prefer a hosted API? OpenAI, Anthropic Claude, Google Gemini, Groq and xAI Grok are supported too.

CONTROLS
• Review scope — all reviews, the newest N, or the last 1/3/6/12 months
• Analysis depth — Quick, Balanced or Thorough
• Output language — match the reviews, or pin it to one you choose
• Full sampling control for local models: temperature, top-p, top-k, repeat penalty, context window

PRIVACY
There is no GReviewSumm server. Nothing is sent to us, because there is nowhere to send it.
• Review text goes only to the AI provider you selected — with a local model, nowhere at all
• API keys are AES-GCM-256 encrypted in local storage and never shown back to you
• No analytics, no telemetry, no tracking, no ads, no account
• The interface makes zero third-party requests — even the fonts are bundled

Full policy: https://lauming1111.github.io/GReviewSumm/privacy.html
Source code: https://github.com/lauming1111/GReviewSumm
```

---

## Single purpose statement

```
GReviewSumm has one purpose: to summarize the customer reviews shown on a Google
Maps place page into pros, cons, themes and overall sentiment, using an AI model
that the user selects and configures.
```

---

## Permission justifications

Paste each into the matching field. Keep them specific — vague justifications are
the most common cause of rejection.

### `activeTab`

```
Used to read the review content of the Google Maps page the user is currently
viewing, and only after the user clicks "Analyze Reviews" in the extension popup.
The extension does not read any tab until that button is pressed.
```

### `scripting`

```
Used to inject the content script that collects review text from the Google Maps
reviews panel. Injection happens only on Google Maps and Google Search pages, and
only when the user starts an analysis.
```

### `storage`

```
Used to store the user's own settings (chosen AI provider, model, endpoint,
review scope, output language) and a 24-hour local cache of generated summaries
so reopening a place is instant. All of it stays in local extension storage on
the user's device. Nothing is transmitted to the developer.
```

### Host permission — `https://www.google.com/*`, `https://maps.google.com/*`

```
These are the pages whose reviews the extension summarizes. The content script
runs on Google Maps place pages and Google Search knowledge panels in order to
read the visible review text, ratings and place details.
```

### Host permission — `http://localhost/*`, `http://127.0.0.1/*`

```
Required to send review text to an AI model running locally on the user's own
machine (Ollama on port 11434, LM Studio on 1234, llama.cpp on 8080, and similar).
This is the privacy-preserving default: when a local model is used, review text
never leaves the user's computer.
```

### Host permissions — the five provider APIs

```
api.openai.com, api.anthropic.com, generativelanguage.googleapis.com,
api.groq.com and api.x.ai are contacted only to generate a summary, and only for
the single provider the user has selected in settings. The user supplies their own
API key for that provider. No other host among these is ever contacted.
```

### Optional host permissions — `http://*/*`, `https://*/*`

> This is the entry reviewers scrutinise hardest. The justification below is
> accurate — the broad pattern is declared, but the request made at runtime is
> always for one concrete origin.

```
These are declared as OPTIONAL host permissions and are never requested at
install time.

The extension supports self-hosted, OpenAI-compatible AI servers (LM Studio,
llama.cpp, Jan, vLLM, LocalAI and similar). A user may run such a server on any
address on their own machine or private network. Because that address is supplied
by the user at runtime, it cannot be known when the extension is packaged, so the
optional pattern must be broad.

At runtime the extension never requests this broad pattern. When the user saves a
custom endpoint, chrome.permissions.request() is called with only that single
origin (for example https://my-server.example.com/*), and only when the address is
not localhost. Users who do not configure a self-hosted endpoint are never asked
for any additional permission.
```

### Remote code

```
No remote code is used. All scripts are bundled in the package. Fonts are
self-hosted within the extension rather than loaded from a CDN.
```

---

## Data usage disclosures (Privacy practices tab)

| Question | Answer |
|---|---|
| Personally identifiable information | Not collected |
| Health information | Not collected |
| Financial and payment information | Not collected |
| Authentication information | **Collected** — the user's own AI provider API key, stored encrypted on the user's device only, transmitted solely to that provider as an auth header |
| Personal communications | Not collected |
| Location | Not collected |
| Web history | Not collected |
| User activity | Not collected |
| Website content | **Collected** — the public review text on the page being summarized, sent only to the AI provider the user selected in order to generate the summary |

Certifications (all true for this extension):

- [x] Does not sell or transfer user data to third parties outside of approved use cases
- [x] Does not use or transfer user data for purposes unrelated to the item's single purpose
- [x] Does not use or transfer user data to determine creditworthiness or for lending purposes

---

## Assets checklist

| Asset | Requirement | Status |
|---|---|---|
| Store icon | 128×128 PNG | `icons/icon128.png` |
| Screenshots | 1280×800 or 640×400, at least 1 | 5 in `store-assets/` |
| Small promo tile | 440×280 | `store-assets/promo-440x280.png` |
| Privacy policy URL | required | pending Pages being enabled |

---

## Before submitting

1. Enable GitHub Pages (**Settings → Pages → main branch → /docs**) and confirm the
   privacy URL loads over HTTPS.
2. Replace the donation placeholders on the landing page, or delete that section.
3. Update the landing page's install CTA to the store URL once the listing is live.
4. Zip **the build output**, not the source: `cd review-atlas-extension && zip -r ../greviewsumm-1.3.0.zip .`
