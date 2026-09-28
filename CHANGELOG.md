# Changelog

All notable changes to Review Atlas will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [1.4.0] — 2026-09-28

### Changed
- **Renamed to Review Atlas.** The name, the popup header and the website follow the repository, which was renamed earlier. Storage keys keep their old names on purpose, so settings, saved API keys and cached summaries survive the update untouched

### Added
- **Back button in Settings**, pinned to the top of the pane so it stays in reach while scrolling. Previously the only way out was Cancel at the very bottom
- **↻ Refresh models** button beside each provider's model field, shown once Test connection succeeds. Every provider's picker now fills from the models the provider actually lists — the OpenAI, Gemini, Groq and Grok dropdowns were fixed four-model lists, and Claude had no suggestions at all. Embedding, speech, image and moderation models are left out, since none can write a summary

- **The AI provider is checked before any reviews are collected.** An analysis used to spend up to a minute scrolling Google Maps and only then report that Ollama was not running or that an API key was wrong. The provider's model-list endpoint — free, no tokens — is now called first, the loading screen says which provider it is checking, and a failure stops the run before the page is touched. That endpoint only proves model listing works, and a local server can answer chat without exposing `/models`, so the error screen also offers **Analyze anyway**, which skips the check for the rest of that popup session

### Fixed
- **Every Ollama analysis failed with HTTP 403.** Chrome sends `Origin: chrome-extension://…` on the extension's requests to generate a summary, and Ollama refuses any origin it does not recognise — while Test connection, a GET sent without an Origin, kept reporting success. The extension now removes that header from its own requests to your local server (a session rule via the new `declarativeNetRequestWithHostAccess` permission, which adds no install warning). The rule matches only requests this extension makes, so websites calling your Ollama still carry their Origin and are still refused
- **Reasoning models (deepseek-r1, qwen3…) never produced a summary on Ollama.** Ollama turns thinking on by default for them and it shares the output budget: on deepseek-r1:8b all 2048 tokens and 100 seconds went to reasoning, the answer came back empty, and each of the three retries repeated it. Requests now send `think: false`. Thinking that a self-hosted OpenAI-compatible server writes inline (`<think>…</think>`) is also stripped before the JSON is read
- **The Ollama model field hid your installed models.** It was a text field with suggestions, and Chrome only suggests entries that match what the field already holds — so with the default `llama3.2:latest` in it and a different model installed, the list looked empty and Test connection seemed to do nothing. It is now a dropdown of the models installed on the server, loaded as soon as Settings opens; a stored model that is not installed is marked as such and replaced by one that is
- **The Google Maps page reacted to buttons in the popup.** History's Back and Settings' Cancel re-queried the tab, and each query made the page switch to Overview and back. Back and Cancel now return to the screen you came from without touching the page
- **The page was left on the Reviews tab** whenever the popup read place info from any tab other than Overview — the "switch back" step always clicked Reviews. It now returns to the tab you were on, and a place already seen is answered from memory with no tab switch at all
- Finishing an analysis no longer pulls you out of History or Settings; Back takes you to the result
- A model picked from a refreshed list is no longer lost on reopen — the dropdown blanked a value it had no option for, and the next save silently fell back to the default model
- Claude's and Gemini's model lists were cut off at their API's default page size (20 and 50)
- **The result screen showed the wrong Google rating — "5 / 5" for a 4.5-star place.** Analysis reads the rating on the Reviews tab, which has no place-name heading to anchor on, so the first star label on the page was taken: a histogram bar ("5 stars, 4,128 reviews"). Its count stood in for the place's total too, so a large scrape stopped at 4,128 reviews and History listed 4,128 instead of 5,967. With search results still listed beside the place, it took the first result's rating and count instead — often another place's. The rating is now read only from the open place's own panel, skipping histogram bars and links to other places, and an analysis reuses what the info screen already read for the place
- An error screen left the loading-step timer running behind it, and the next analysis overwrote that timer's handle without clearing it
- The info screen's review count was blank when opened on Overview, and the histogram bar's count when opened on Reviews — Maps prints the count beside the stars rather than in their label, and only the label was read
- **The place was named "Tartine Bakery - Google Maps", "Results" or "Search Results"** in the result screen, in History and in the prompt sent to the AI. The name was read from the page heading, which Maps renders only on Overview — so an analysis started on the Reviews tab fell back to the browser tab's title, and with search results still listed beside the place it took the list's own "Results" heading. On Google Search the page's first heading is a hidden "Search Results" label. The name now comes from the open place's own panel on every Maps tab, from the knowledge panel on Google Search, and from the search query when no place is open

---

## [1.3.0] — 2026-09-07

### Added
- **Any local AI runtime is now a first-class provider, not just Ollama.** The "Local server" provider gained the same sampling controls Ollama had (temperature, top-p, top-k, repeat penalty, context window), a model picker fed by its own `/models` listing, and one-click presets for LM Studio, llama.cpp server, Jan, vLLM, KoboldCpp, text-generation-webui, LocalAI, and Ollama's OpenAI-compatible API. Previously "use a local model" effectively meant "install Ollama": the custom endpoint could not be tuned at all and its temperature was pinned to the cloud default
- **Ollama server endpoint is configurable** — a remote or non-default-port Ollama was previously unreachable (the base URL was a module constant), and the Custom provider was not a workaround since it speaks `/chat/completions` and discards every Ollama sampling parameter
- **Ollama model picker** — the model field now autocompletes from the server's own installed models; `/api/tags` was already being called for the health check and its response body thrown away
- **Test connection** button per provider — validates the key or endpoint against the provider's free model-list endpoint, so a bad key surfaces immediately instead of after a 60-second scrape
- **Output language** setting — previously there was no language directive in the prompt at all, so the output language depended on the provider and on the reviews, and could differ between runs
- **Analysis depth** (Quick / Balanced / Thorough) — exposes how many collected reviews actually reach the model
- **Reset to defaults**, with saved API keys and the custom endpoint preserved
- Result screen warns when most review dates could not be parsed, which is what makes a time-window scope silently behave like "all"
- **Scraped reviews are cached** for 24 h alongside the summary, so Re-analyze and provider switches skip the scroll phase entirely — a new **⟳ Fresh** button forces a re-scrape
- **Save** button in settings, separate from **Save & Analyze** — changing a model or pasting a key no longer forces a full analysis
- Result header now reports the sample size (e.g. "113 of 1,043 reviews analyzed") instead of implying every review was read
- Request timeout on all AI calls, so a hung Ollama server surfaces an error instead of spinning forever
- `optional_host_permissions` plus a save-time permission request, so custom OpenAI-compatible endpoints on non-localhost hosts work

### Fixed
- **The prompt-overflow clamp only protected Ollama.** `resolveCharBudget` returned early for every other provider, so a local OpenAI-compatible server with a small context window got the full depth budget and overflowed — the exact bug the clamp exists to prevent. It now applies to every locally-hosted model, using that provider's own context setting. Measured: a local server at 4096 tokens now gets ~5,700 characters instead of 96,000
- **Sampling parameters are no longer sent to hosted APIs.** `top_k` and `repetition_penalty` are not part of the OpenAI schema; they are sent only to local servers, and if a strict server rejects them the request is retried once without them rather than surfacing a 400
- **Accessibility: 6 of 20 text/background combinations failed WCAG AA.** The worst were affordances users must find — the API-key revoke button measured **1.85:1** and the sub-label under every provider and scope button **2.83:1**. Every failure came from `opacity` stacked on muted text, or from `--accent` used as text at 3.82:1. `--text-muted` is now `#9a9ac0`, accent-as-text uses a new `--accent-text` token, and the opacity reductions are gone. All 31 combinations now pass, verified by script
- **Keyboard focus was invisible** — `.scope-btn`, `.history-delete`, and every input, select, and slider set `outline: none` with no replacement. A single `:focus-visible` ring now applies throughout
- **`All` and `Recent` scopes were identical.** `Recent` now sorts Google Maps by newest before scraping, so it really means the newest N rather than the first N in relevance order. The review cache key includes the sort order, since a relevance-ordered set is not interchangeable with a newest-first one
- **The prompt could overflow a small context window.** The character budget assumed `num_ctx` 16384, but `num_ctx` is editable down to 512 and nothing revalidated. It is now clamped to what the configured context window can actually hold
- Sentiment values from the model are validated against the four the UI knows — an unrecognised value (common when a model replies in another language) previously rendered a blank badge
- The Ollama health check ran on a bare `fetch` with no timeout, unlike every other request
- Stale markup default: the `num_ctx` field showed `4096`, four times below the actual default
- `#review-count-input` allowed `max="2000"` while the code ceiling was 10000, and the maximum was not enforced on read; it is now clamped at both ends
- **Wrong business summary on Google Search pages** — the cache key kept only origin + pathname, so every `google.com/search` knowledge panel collapsed onto one key and served the previously analyzed business's summary
- Cache key now includes provider, model, and review scope — switching provider previously returned the old result unchanged
- `config.ts` values never reached the scroll loop; the content script dropped the `scrollConfig` it was sent and always used its own hardcoded copy
- Reviews with an unparseable date are kept rather than silently dropped, which could empty every time-window result set
- Rating-only reviews no longer feed card UI chrome ("Like", "Share", "Local Guide") to the model as review prose
- `reviewCount` is now honoured in **All** scope, and its input is no longer hidden there — previously there was no way to cap a very large place
- Expired cache entries are evicted on read and both caches are capped at 50 entries
- Anthropic output cap raised to 2048 tokens; a truncated response produced invalid JSON that then burned every retry

### Changed
- **Settings restructured into four cards** — Provider, Review scope, Analysis, Advanced. Previously a single flat scroll of 60+ controls in which every label was uppercased, so nothing read as more important than anything else. Uppercase is now reserved for card headers
- **Fonts are self-hosted.** The popup pulled Syne and DM Sans from `fonts.googleapis.com` on every open — a network round-trip on a surface that lives for seconds, in an extension whose premise is that nothing leaves your machine. Both are variable fonts, so two files (97 KB) cover every weight
- Summary text is no longer italic, and the settings pane uses the same styled scrollbar as the rest of the UI instead of the default light one
- **Prompt is now bounded.** Reviews sent to the model are capped and sampled — all 1–2★ reviews are kept, the rest stride-sampled across the full time range, with a hard character budget. A 1000-review place previously produced a ~68k-token prompt against a 4096-token context window, so the model silently read a fraction of it at full latency. Ollama `num_ctx` default raised to 16384
- **Scraper no longer re-parses collected reviews.** Cards are tracked in a `WeakSet` and parsed exactly once; polling now collects as it goes rather than parsing the whole list to answer a boolean and discarding the result
- `MAX_STABLE_ROUNDS` reduced from 5 to 2, plus an early exit once Google's reported review count is reached — removing up to ~20 s of waiting after the last review was already collected
- Cancel is now checked mid-wait instead of only between rounds (was up to ~4 s to register)
- Scroll targets the resolved review panel directly, replacing a per-round sentinel insert, ancestor scroll-walk, and an `offsetParent` scan over every button and link on the page
- Retry now wraps only the model call and its parse — prompt construction and the Ollama health check no longer repeat on every attempt — and backs off between attempts
- `author` is dropped and `date` omitted for non-time-window scopes before crossing the popup → background message boundary

---

## [1.2.0] — 2026-05-25

### Added
- **Multi-provider AI support** — OpenAI, Anthropic Claude, Google Gemini, Groq, xAI Grok, and any OpenAI-compatible custom endpoint alongside the existing Ollama integration
- **Ollama advanced parameters** — tune temperature, top-p, top-k, repeat penalty, and context window (`num_ctx`) directly from the settings panel
- **API key protection** — keys are never loaded into DOM inputs; a `✓ Saved` badge confirms a stored key and an explicit `✕` button is required to revoke it
- **API key encryption** — keys are encrypted at rest using AES-GCM-256 with PBKDF2-SHA-256 key derivation (100 000 iterations); legacy plaintext keys are migrated transparently on next save
- **Wrong-page screen** — when the extension is opened on a non-Google Maps tab it now shows a clear prompt with an "Open Google Maps" button instead of silently failing

### Fixed
- Staff section no longer picks up customer names (reviewers) or platform/brand names — the AI prompt now explicitly restricts `notableStaff` to business employees only

### Changed
- Renamed from *Review Lens* to **GReviewSumm** across all storage keys, console output, and UI copy

---

## [1.1.0] — 2026-05-24

### Added
- **Frequently mentioned staff** — a dedicated section surfaces employee first names that appear in at least two separate reviews
- **⚡ Summarize Now** — lets you cut review gathering short and summarize whatever has been collected so far, without cancelling the whole run
- **Centralized config** — a single `config.ts` module owns all tunable constants (scroll timing, AI defaults, popup behaviour) so they are easy to find and change
- **Rich place info panel** — the info screen now shows category, address, and phone number scraped from the Maps sidebar

### Fixed
- Complete rewrite of the review scraper — more reliable across Maps layouts and edge cases
- Aggregate star rating now uses Google's official rating instead of recalculating from visible review cards, which was producing wrong values
- Retry button now wired correctly on all error and no-reviews screens

---

## [1.0.0] — 2026-05-23

### Added
- Initial release — summarize Google Maps reviews with a local Ollama model
- Review scope filters: all-time, most-recent N, or a time window (1 month, 3 months, 6 months, 1 year)
- 24-hour result cache keyed by page URL, with a full history screen to browse and re-open past summaries
- Two-step loading indicator with per-step elapsed timers
- Cancel button to abort an in-progress analysis and return to the info screen
- Pinned footer on the result screen (Settings / Re-analyze always visible without scrolling)
