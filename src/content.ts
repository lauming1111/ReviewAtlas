import type { Review, MessageType, ReviewSort, ScrollConfig } from './types.js';

const REVIEW_CARD_SELECTOR = '[data-review-id]';

/** Minimum characters for a review body to be considered meaningful content. */
const MIN_REVIEW_TEXT_LEN = 15;

/** Fallback ceiling when the popup does not supply one (mirrors SCROLL_CONFIG.MAX_REVIEWS_ALL). */
const DEFAULT_MAX_REVIEWS = 10000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only return top-level review cards — skip elements nested inside another [data-review-id].
function getReviewCards(): Element[] {
  return Array.from(document.querySelectorAll(REVIEW_CARD_SELECTOR)).filter(
    (el) => !el.parentElement?.closest(REVIEW_CARD_SELECTOR)
  );
}

// If reviews tab isn't open yet, find and click it
async function ensureReviewsTabOpen(tabOpenWaitMs: number): Promise<void> {
  if (getReviewCards().length > 0) return;

  const allButtons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="tab"]'));
  const reviewsBtn = allButtons.find((btn) => {
    const text = btn.textContent?.trim().toLowerCase() ?? '';
    return text === 'reviews' || text.startsWith('reviews ');
  });

  if (reviewsBtn) {
    reviewsBtn.click();
    console.log('[GReviewSumm] Clicked Reviews tab, waiting for cards…');
    await sleep(tabOpenWaitMs);
  }
}

// ─── Sort order ───────────────────────────────────────────────────────────────

/** Text that identifies the desired option inside the sort menu. */
const SORT_OPTION_PATTERN: Record<ReviewSort, RegExp> = {
  newest:    /newest/i,
  relevance: /most relevant|relevance/i,
};

/**
 * Put the reviews list into the requested sort order.
 *
 * Google Maps sorts by "Most relevant" by default, so taking the first N cards
 * yields the most-relevant N, not the newest N.
 *
 * This MUST be able to set the order in both directions. The sort survives
 * across popup invocations within the same tab, so a run with scope 'recent'
 * leaves the page sorted newest; a later 'all' run would then silently scrape a
 * newest-ordered list and cache it under the 'relevance' key.
 *
 * Best-effort: if the control cannot be found the caller proceeds with whatever
 * order the page is in. Returns true when the order was actually changed.
 */
async function ensureSortOrder(sortBy: ReviewSort, pollMs: number, timeoutMs: number): Promise<boolean> {
  const TRIGGER = /^(sort|most relevant|newest|highest rating|lowest rating)/i;
  const wanted = SORT_OPTION_PATTERN[sortBy];

  const trigger = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
    .find((el) => {
      const label = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.trim();
      return TRIGGER.test(label) && el.getClientRects().length > 0;
    });

  if (!trigger) {
    console.log('[GReviewSumm] Sort control not found — leaving the page order as-is');
    return false;
  }

  // The trigger label reflects the active sort, so this doubles as the
  // already-in-the-right-order check.
  const current = `${trigger.getAttribute('aria-label') ?? ''} ${trigger.textContent ?? ''}`;
  if (wanted.test(current)) return false;

  trigger.click();

  // The menu renders asynchronously.
  const deadline = Date.now() + timeoutMs;
  let option: HTMLElement | undefined;
  for (;;) {
    option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"], [role="option"]')
    ).find((el) => wanted.test(el.textContent ?? ''));
    if (option || Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  if (!option) {
    console.log(`[GReviewSumm] "${sortBy}" sort option not found — leaving the page order as-is`);
    trigger.click(); // close the menu we opened
    return false;
  }

  option.click();
  console.log(`[GReviewSumm] Sorted reviews by ${sortBy}`);
  // Maps tears down and rebuilds the list after a sort change.
  await sleep(timeoutMs);
  return true;
}

// ─── Scroll container ─────────────────────────────────────────────────────────

// Find the scrollable ancestor that holds the review list. Resolved once and
// cached — scrolling it directly avoids the sentinel-insert + ancestor-walk
// reflow storm the previous implementation performed on every round.
function findScrollContainer(from: Element): HTMLElement | null {
  let node: HTMLElement | null = from.parentElement;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 4) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

// Scroll past the last card to trigger Google Maps lazy-loading.
function scrollReviewsPanel(lastCard: Element, panel: HTMLElement | null): void {
  // Fast path — one property write, no DOM mutation, no forced layout loop.
  if (panel) {
    panel.scrollTop = panel.scrollHeight;
    return;
  }

  // Fallback 1: insert a 1px sentinel after the last card and scroll to it.
  // scrollIntoView on an already-visible card does nothing; the sentinel is
  // always just below it, so the panel must scroll down to show it.
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'height:1px;width:1px;pointer-events:none;';
  lastCard.after(sentinel);
  sentinel.scrollIntoView({ behavior: 'instant', block: 'end' });
  sentinel.remove();

  // Fallback 2: walk ancestors setting scrollTop = scrollHeight.
  let node: Element | null = lastCard.parentElement;
  while (node && node !== document.documentElement) {
    const prev = node.scrollTop;
    node.scrollTop = node.scrollHeight;
    if (node.scrollTop !== prev) return; // something scrolled — done
    node = node.parentElement;
  }

  // Fallback 3: window scroll for mobile/responsive layouts where the page scrolls.
  window.scrollTo(0, document.documentElement.scrollHeight);
}

// Click a "More reviews" / "See more" button if one is visible, return true if clicked.
// Scoped to the reviews panel when known, and the cheap regex test runs before any
// layout-forcing visibility check.
function clickMoreReviewsButton(panel: HTMLElement | null): boolean {
  const keywords = /more review|see more review|load more|show more review/i;
  const root: ParentNode = panel ?? document;
  const candidates = root.querySelectorAll<HTMLElement>('button, [role="button"], a');

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (!keywords.test(el.textContent?.trim() ?? '') &&
        !keywords.test(el.getAttribute('aria-label') ?? '')) {
      continue;
    }
    if (el.hidden || el.getClientRects().length === 0) continue;
    console.log(`[GReviewSumm] Clicking "More reviews" button: "${el.textContent?.trim()}"`);
    el.click();
    return true;
  }
  return false;
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

// Returns the number of DOM-tree edges between two elements (via their LCA).
// Used to find the rating element nearest to the place-name h1.
function domDistance(from: Element, to: Element): number {
  const distFromAncestors = new Map<Element, number>();
  let node: Element | null = from;
  let d = 0;
  while (node) { distFromAncestors.set(node, d++); node = node.parentElement; }
  node = to; d = 0;
  while (node) {
    if (distFromAncestors.has(node)) return (distFromAncestors.get(node) as number) + d;
    node = node.parentElement; d++;
  }
  return Infinity;
}

/** One bar of the review histogram — a star level's share, not the place's rating. */
const HISTOGRAM_BAR_LABEL = /^\s*\d\s*stars?\s*,\s*[\d,]+\s*reviews?\s*$/i;

/** A review count on its own, as Maps prints it beside the stars: "5,967 reviews". */
const REVIEW_COUNT_TEXT = /^\(?\s*([\d,]+)\s*\)?\s*reviews?$/i;

/** "Tartine Bakery - Google Maps" → "Tartine Bakery"; a bare "Google Maps" → "". */
const TITLE_SUFFIX = /(?:^|[\s ]*[-–—|][\s ]*)Google\s+(?:Maps|Search)[\s ]*$/i;

/**
 * The Maps place panel: the [role="main"] region holding the place's Reviews
 * tab. Every tab renders inside it, whereas the h1 exists only on Overview, and
 * a search's results list — other places' ratings — is a separate [role="main"].
 */
function findPlacePanel(): Element | null {
  const reviewsTab = Array.from(document.querySelectorAll('[role="main"] [role="tab"]'))
    .find((tab) => /^reviews\b/.test(tabLabel(tab)));
  return reviewsTab?.closest('[role="main"]') ?? null;
}

/**
 * The name of the place on screen.
 *
 * Maps renders the place's h1 on Overview only, so an analysis — which reads
 * this on the Reviews tab — used to fall back to the browser tab's title
 * ("Tartine Bakery - Google Maps"), or, with a search's results list open
 * beside the place, to that list's own "Results" heading. On Google Search the
 * first h1 is a hidden "Search Results" label. Hence: no page-wide h1 lookup,
 * and the h1 lookups that remain are scoped to the place panel, so the name and
 * the rating always describe the same place.
 */
function scrapePlaceName(): string {
  const panel = findPlacePanel();
  const clean = (text: string | null | undefined): string => text?.replace(/\s+/g, ' ').trim() ?? '';
  return (
    // Maps Overview — the only tab that renders a heading.
    clean((panel ?? document).querySelector('h1.DUwDvf')?.textContent) ||
    // Every other Maps tab: the panel itself is labelled with the place's name.
    clean(panel?.getAttribute('aria-label')) ||
    // Older Maps markup. Below the panel label because fontHeadlineLarge is a
    // generic Maps type token, so other headings can carry it too.
    clean((panel ?? document).querySelector('h1[class*="fontHeadlineLarge"]')?.textContent) ||
    // Google Search knowledge panel. NOT scoped to #rhs: below ~600px wide the
    // panel moves out of it, and #rhs stops existing entirely.
    clean(document.querySelector('[data-attrid="title"]')?.textContent) ||
    // No place open: the search query. On a place page without a panel (a place
    // with no reviews, Maps' limited view) the title still names the place.
    clean(document.title).replace(TITLE_SUFFIX, '').trim() ||
    'This Place'
  );
}

/**
 * The review count printed beside a rating's stars, which Maps keeps out of the
 * stars' own label: a separate "5,967 reviews" label in the Overview header, and
 * plain "5,967 reviews" text under the big rating on the Reviews tab. Looks only
 * two levels up, so it cannot reach another block's count.
 */
function findNearbyReviewCount(stars: Element): number | null {
  let container = stars.parentElement;
  for (let level = 0; container && level < 2; level++, container = container.parentElement) {
    for (const el of Array.from(container.querySelectorAll('*'))) {
      const match =
        el.getAttribute('aria-label')?.trim().match(REVIEW_COUNT_TEXT) ??
        (el.childElementCount === 0 ? el.textContent?.trim().match(REVIEW_COUNT_TEXT) : null);
      if (match) return parseInt(match[1].replace(/,/g, ''), 10);
    }
  }
  return null;
}

function scrapeGoogleAggregateRating(): { googleRating: number | null; googleReviewCount: number | null } {
  const panel = findPlacePanel();

  function tryParseEl(el: Element): { googleRating: number; googleReviewCount: number | null } | null {
    if (el.closest(REVIEW_CARD_SELECTOR)) return null;
    const label = el.getAttribute('aria-label') ?? '';
    if (HISTOGRAM_BAR_LABEL.test(label) || el.closest('table')) return null;
    // Inside the place panel, links lead elsewhere: "People also search for", sponsored cards.
    if (panel && el.closest('a[href], [role="link"]')) return null;
    // Match X.X before "stars", "out of 5", after "rated", or "X/5" format
    const ratingMatch =
      label.match(/(\d+(?:\.\d+)?)\s*(?:stars?\s*(?:out\s*of)?|out\s*of)/i) ??
      label.match(/rated?\s+(\d+(?:\.\d+)?)/i) ??
      label.match(/(\d+(?:\.\d+)?)\s*\/\s*5/i);
    if (!ratingMatch) return null;
    const rating = parseFloat(ratingMatch[1]);
    if (rating < 1 || rating > 5) return null;
    const countMatch = label.match(/([\d,]+)\s*reviews?/i);
    return {
      googleRating: rating,
      googleReviewCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null,
    };
  }

  // The Google Maps page has many star elements:
  //  • search-results list entries      — a separate [role="main"] beside the place panel
  //  • the place's rating chip          — just after the h1, on Overview only
  //  • the review summary               — big "4.5" over "5,967 reviews", on Overview and Reviews
  //  • review histogram bars            — "5 stars, 4,128 reviews", beside the summary
  //  • "People also search for" entries — links to other places, late in Overview
  //
  // Strategy:
  //  1. With a place open, search only its panel and take the first rating in
  //     document order: the chip on Overview, the summary on Reviews. The h1
  //     cannot anchor this — Reviews and About render none, and the page's first
  //     rating there was a histogram bar or another place's results-list entry.
  //  2. Otherwise (no panel, e.g. Google Search), prefer elements AFTER the h1
  //     and take the one with the smallest DOM distance to it.
  //  3. When the chosen label carries no count, read the one printed beside it.

  const allCandidates = Array.from((panel ?? document).querySelectorAll(
    '[role="img"][aria-label],[aria-label*="star"],[aria-label*="out of 5"],[aria-label*="rated "],[aria-label*="/5"]'
  ));

  const allValid: Array<{ result: { googleRating: number; googleReviewCount: number | null }; el: Element }> = [];
  for (const el of allCandidates) {
    const result = tryParseEl(el);
    if (result) allValid.push({ result, el });
  }

  if (allValid.length === 0) return { googleRating: null, googleReviewCount: null };

  let best = allValid[0]; // in the panel, or with no h1 to anchor on — first found
  const h1 = panel ? null : document.querySelector('h1.DUwDvf, h1[class*="fontHeadlineLarge"], h1');
  if (h1) {
    // Keep only elements that follow h1 in document order; fall back to all if none.
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    const afterH1 = allValid.filter(({ el }) => !!(h1.compareDocumentPosition(el) & FOLLOWING));
    const pool = afterH1.length > 0 ? afterH1 : allValid;

    // Precompute each candidate's distance once — computing it inside the comparator
    // re-walked the ancestor chain on every O(n log n) comparison.
    const withDistance = pool.map((c) => ({ ...c, dist: domDistance(h1, c.el) }));
    withDistance.sort((a, b) => a.dist - b.dist);
    best = withDistance[0];
  }

  return {
    googleRating: best.result.googleRating,
    googleReviewCount: best.result.googleReviewCount ?? findNearbyReviewCount(best.el),
  };
}

function extractStarRating(el: Element): number {
  const ariaLabel = el.getAttribute('aria-label') ?? '';
  const match = ariaLabel.match(/(\d+(?:\.\d+)?)\s*(?:star|out of)/i);
  if (match) return parseFloat(match[1]);
  return 0;
}

function extractReviewFromCard(card: Element): Review | null {
  // NOTE: no `?? card` fallback. Falling back to the card itself yielded the
  // whole card's textContent — author name, date, "Like", "Share", local-guide
  // badge — which was then sent to the model as if it were review prose.
  const textEl =
    card.querySelector('.wiI7pd') ??
    card.querySelector('.MyEned') ??
    card.querySelector('[class*="review-full-text"]') ??
    card.querySelector('span[jslog]');

  if (!textEl) return null;

  const ratingEl =
    card.querySelector('span[role="img"][aria-label*="star"]') ??
    card.querySelector('[aria-label*="star"]') ??
    card.querySelector('[aria-label*="Star"]');

  const authorEl =
    card.querySelector('.d4r55') ??
    card.querySelector('.TSUbDb') ??
    card.querySelector('button[class*="fontBodyMedium"]');

  const dateEl = card.querySelector('.rsqaWe, .dehysf, [class*="date"]');

  let text = textEl.textContent?.trim() ?? '';
  if (text.length > 2000) {
    text = text.split('\n').filter((l) => l.trim().length > 10).slice(0, 3).join(' ').substring(0, 500);
  }
  if (text.length < MIN_REVIEW_TEXT_LEN) return null;

  return {
    author: authorEl?.textContent?.trim() ?? 'Anonymous',
    rating: ratingEl ? extractStarRating(ratingEl) : 0,
    text,
    date: dateEl?.textContent?.trim(),
  };
}

function scrapeContactInfo(): { category?: string; address?: string; phone?: string } {
  // Category — button with category jsaction, or first short text block after h1
  let category: string | undefined;
  const catEl = document.querySelector<HTMLElement>('button[jsaction*="category"]') ??
    document.querySelector<HTMLElement>('[class*="DkEaL"]');
  if (catEl?.textContent?.trim()) category = catEl.textContent.trim();

  // Address — aria-label is most reliable; strip leading "Address: " prefix
  let address: string | undefined;
  const addressBtn = document.querySelector('[data-item-id="address"]');
  if (addressBtn) {
    const label = addressBtn.getAttribute('aria-label');
    address = label
      ? label.replace(/^address:\s*/i, '').trim()
      : addressBtn.textContent?.trim();
  }

  // Phone — data-item-id starts with "phone:tel:"
  let phone: string | undefined;
  const phoneBtn = document.querySelector('[data-item-id^="phone:tel:"]');
  if (phoneBtn) {
    const label = phoneBtn.getAttribute('aria-label');
    phone = label
      ? label.replace(/^phone:\s*/i, '').trim()
      : phoneBtn.textContent?.trim();
  }

  return { category, address, phone };
}

/**
 * What the Overview tab showed for a place, for this page's lifetime, so
 * reopening the popup on a place already seen answers without switching the
 * user's page to Overview again. Keyed by the place's URL slug and feature id,
 * which are the same on the Overview, Reviews and About tabs — the h1 is not
 * (only Overview renders it). The rating is kept too, so an analysis reports
 * the same rating and review count the info screen showed.
 */
const overviewInfoCache = new Map<
  string,
  ReturnType<typeof scrapeContactInfo> & ReturnType<typeof scrapeGoogleAggregateRating>
>();

/** The overviewInfoCache key for the place in the URL, if the URL names one. */
function placeCacheKey(): string | undefined {
  const placeSlug = location.pathname.match(/\/place\/([^/]+)/)?.[1];
  const featureId = location.href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1];
  return placeSlug && featureId ? `${placeSlug}|${featureId}` : undefined;
}

/**
 * The place's aggregate rating for an analysis. What Overview showed wins when
 * the popup has already read this place — it does on every open — so the result
 * agrees with the info screen; the live scrape fills in whatever that lacks.
 */
function scrapePlaceAggregate(): ReturnType<typeof scrapeGoogleAggregateRating> {
  const cacheKey = placeCacheKey();
  const cached = cacheKey ? overviewInfoCache.get(cacheKey) : undefined;
  const live = scrapeGoogleAggregateRating();
  return {
    googleRating: cached?.googleRating ?? live.googleRating,
    googleReviewCount: cached?.googleReviewCount ?? live.googleReviewCount,
  };
}

function tabLabel(tab: Element): string {
  return tab.textContent?.trim().toLowerCase() ?? '';
}

async function scrapeBasicInfo(): Promise<{ placeName: string; googleRating?: number; googleReviewCount?: number; category?: string; address?: string; phone?: string }> {
  const placeName = scrapePlaceName();

  const cacheKey = placeCacheKey();
  const cached = cacheKey ? overviewInfoCache.get(cacheKey) : undefined;

  let { googleRating, googleReviewCount } = cached ?? scrapeGoogleAggregateRating();
  let { category, address, phone } = cached ?? scrapeContactInfo();

  // If contact info is missing we may be on the Reviews or About tab (Overview
  // content not rendered). Switch to Overview, re-scrape, then put the page back
  // on the tab the user had. This used to click Reviews unconditionally, so a
  // user on About — or any tab — was left on Reviews every time the popup asked.
  if (!cached && !address && !phone && !category) {
    const overviewBtn = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
      .find((tab) => tabLabel(tab) === 'overview' || tabLabel(tab) === 'info');
    // Scoped to Overview's own tab strip: a Search page has other tablists
    // whose selected tab must never be clicked.
    const siblingTabs = Array.from(
      (overviewBtn?.closest('[role="tablist"]') ?? overviewBtn?.parentElement)
        ?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
    );
    const returnTo = siblingTabs.find((tab) => tab.getAttribute('aria-selected') === 'true');

    // Only switch when there is a known tab to switch back to — otherwise the
    // page would be stranded on Overview. Already on Overview: nothing to find.
    if (overviewBtn && returnTo && returnTo !== overviewBtn) {
      overviewBtn.click();
      await sleep(700); // wait for Overview panel to render
      ({ category, address, phone } = scrapeContactInfo());
      // Also re-scrape rating — might be more accurate on Overview
      const overviewRating = scrapeGoogleAggregateRating();
      if (overviewRating.googleRating !== null) googleRating = overviewRating.googleRating;
      if (overviewRating.googleReviewCount !== null) googleReviewCount = overviewRating.googleReviewCount;
      returnTo.click();
    }
  }

  // Contact info renders only on Overview, so finding any means this came from
  // Overview. Nothing found is not cached — the panel may not have rendered yet.
  if (cacheKey && !cached && (address || phone || category)) {
    overviewInfoCache.set(cacheKey, { category, address, phone, googleRating, googleReviewCount });
  }

  return {
    placeName,
    ...(googleRating !== null && { googleRating }),
    ...(googleReviewCount !== null && { googleReviewCount }),
    ...(category && { category }),
    ...(address && { address }),
    ...(phone && { phone }),
  };
}

// ─── Incremental scroll + scrape ──────────────────────────────────────────────

// Updated by scrollAndScrapeReviews so GET_PROGRESS can report live count.
let progressCount = 0;
let shouldStop = false;

const DEFAULT_SCROLL_CONFIG: ScrollConfig = {
  tabOpenWaitMs: 1500,
  pollIntervalMs: 300,
  scrollWaitMs: 2000,
  moreReviewsWaitMs: 2000,
  maxStableRounds: 2,
};

async function scrollAndScrapeReviews(
  maxReviews: number,
  cfg: ScrollConfig = DEFAULT_SCROLL_CONFIG,
  sortBy: ReviewSort = 'relevance'
): Promise<{ reviews: Review[]; placeName: string; googleRating?: number; googleReviewCount?: number }> {
  await ensureReviewsTabOpen(cfg.tabOpenWaitMs);

  // Must happen BEFORE any collection — changing the sort rebuilds the list.
  // Called unconditionally: the previous run may have left the page in the
  // other order, and that order persists in the tab.
  await ensureSortOrder(sortBy, cfg.pollIntervalMs, cfg.scrollWaitMs);

  const initialCards = getReviewCards();
  if (initialCards.length === 0) {
    console.log('[GReviewSumm] No review cards found after tab open attempt');
    return { reviews: [], placeName: scrapePlaceName() };
  }

  // Resolve the scrollable review panel once and reuse it every round.
  const panel = findScrollContainer(initialCards[0]);
  console.log(`[GReviewSumm] Scroll container: ${panel ? panel.className || '<unnamed>' : 'not found — using fallback'}`);

  // Scrape the aggregate rating up front so the loop knows its target count.
  const aggregate = scrapePlaceAggregate();
  const targetCount = aggregate.googleReviewCount;

  // Cards already parsed. A WeakSet keyed on the element means each card is
  // parsed exactly once, no matter how many times it is re-queried — this is
  // what removes the quadratic re-parse the previous implementation had.
  const seenCards = new WeakSet<Element>();
  const seenKeys = new Set<string>();
  const allReviews: Review[] = [];
  let lastCard: Element | null = null;

  function collectNew(): number {
    let added = 0;
    const cards = document.querySelectorAll(REVIEW_CARD_SELECTOR);
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (seenCards.has(card)) continue;
      seenCards.add(card);
      if (card.parentElement?.closest(REVIEW_CARD_SELECTOR)) continue; // nested duplicate
      const review = extractReviewFromCard(card);
      if (!review) continue;
      const key = `${review.author}|${review.text.slice(0, 60)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      allReviews.push(review);
      added++;
    }
    // Last element in document order — no extra scan needed for the scroll target.
    lastCard = cards.length > 0 ? cards[cards.length - 1] : lastCard;
    progressCount = allReviews.length;
    return added;
  }

  // Poll until new reviews appear or the timeout elapses, COLLECTING as it goes.
  // Checks before sleeping so a fast page does not pay a full poll interval,
  // and honours shouldStop mid-wait so Cancel is responsive.
  async function pollForNewReviews(timeoutMs: number, pollMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const added = collectNew();
      if (added > 0) return added;
      if (shouldStop) return 0;
      if (Date.now() >= deadline) return 0;
      await sleep(pollMs);
    }
  }

  // Grab the first visible batch before scrolling
  collectNew();

  let stableRounds = 0;

  while (stableRounds < cfg.maxStableRounds && allReviews.length < maxReviews && !shouldStop) {
    // Stop early once we have as many reviews as Google says exist.
    if (targetCount !== null && allReviews.length >= targetCount) {
      console.log(`[GReviewSumm] Reached Google's reported count (${targetCount}) — stopping early`);
      break;
    }

    if (lastCard) scrollReviewsPanel(lastCard, panel);

    const added = await pollForNewReviews(cfg.scrollWaitMs, cfg.pollIntervalMs);
    console.log(`[GReviewSumm] Scroll: ${allReviews.length} unique reviews (${added} new this round)`);

    if (added === 0) {
      if (shouldStop) break;
      const clicked = clickMoreReviewsButton(panel);
      if (clicked) {
        const addedAfterClick = await pollForNewReviews(cfg.moreReviewsWaitMs, cfg.pollIntervalMs);
        if (addedAfterClick > 0) {
          stableRounds = 0;
          continue;
        }
      }
      stableRounds++;
    } else {
      stableRounds = 0;
    }
  }

  console.log(`[GReviewSumm] Done: ${allReviews.length} unique reviews`);

  // Reuse the pre-loop aggregate; only re-scrape if it came back empty.
  const { googleRating, googleReviewCount } =
    aggregate.googleRating !== null ? aggregate : scrapePlaceAggregate();

  return {
    reviews: allReviews.slice(0, maxReviews),
    placeName: scrapePlaceName(),
    ...(googleRating !== null && { googleRating }),
    ...(googleReviewCount !== null && { googleReviewCount }),
  };
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: MessageType, _sender, sendResponse) => {
  if (message.type === 'STOP_REVIEWS') {
    shouldStop = true;
    sendResponse({ type: 'NO_REVIEWS' } satisfies MessageType);
    return true;
  }

  if (message.type === 'GET_PROGRESS') {
    sendResponse({ type: 'PROGRESS', payload: { count: progressCount } } satisfies MessageType);
    return true;
  }

  if (message.type === 'GET_BASIC_INFO') {
    (async () => {
      try {
        sendResponse({ type: 'BASIC_INFO', payload: await scrapeBasicInfo() } satisfies MessageType);
      } catch (err) {
        sendResponse({ type: 'ERROR', payload: String(err) } satisfies MessageType);
      }
    })();
    return true;
  }

  if (message.type === 'GET_REVIEWS') {
    (async () => {
      try {
        progressCount = 0;
        shouldStop = false;
        const result = await scrollAndScrapeReviews(
          message.maxReviews ?? DEFAULT_MAX_REVIEWS,
          message.scrollConfig ?? DEFAULT_SCROLL_CONFIG,
          message.sortBy ?? 'relevance',
        );
        if (result.reviews.length === 0) {
          sendResponse({ type: 'NO_REVIEWS' } satisfies MessageType);
        } else {
          sendResponse({ type: 'REVIEWS_DATA', payload: result } satisfies MessageType);
        }
      } catch (err) {
        sendResponse({ type: 'ERROR', payload: String(err) } satisfies MessageType);
      }
    })();
    return true;
  }
});
