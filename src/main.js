import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {

const input = await Actor.getInput() || {};
const {
    placeUrls = [],
    maxReviewsPerPlace = 100,
    sortBy = 'newest',
    language = 'en',
    includeOwnerResponse = true,
    minRating = 1,
    maxRunTimeMinutes = 10,
    proxyConfiguration,
} = input;

if (!placeUrls.length) {
    log.error('No place URLs provided.');
    await Actor.exit({ statusMessage: 'No place URLs provided' });
}

// Residential proxy is required for Google Maps
const proxyConfig = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : await Actor.createProxyConfiguration({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] });

let totalReviewsScraped = 0;

/**
 * Parse Google Maps review JSON response (from listugcposts/listentitiesreviews).
 * Google prefixes with )]}' and returns a deeply nested protobuf-style array.
 */
function parseReviewResponse(text) {
    const reviews = [];
    try {
        const clean = text.replace(/^\)\]\}'\n?/, '');
        const data = JSON.parse(clean);
        // The reviews live in a nested array. Recursively find review-like tuples.
        collectReviews(data, reviews, 0);
    } catch (e) {
        log.debug(`parseReviewResponse failed: ${e.message}`);
    }
    return reviews;
}

/**
 * Recursively walk the parsed structure and pull out review objects.
 * A Google Maps review node contains: a review id string, an author block
 * (with name + profile url + photo), a rating (1-5), the review text,
 * a relative time string, and optionally an owner response.
 */
function collectReviews(node, out, depth) {
    if (depth > 25 || node == null) return;
    if (Array.isArray(node)) {
        const review = tryExtractReview(node);
        if (review) {
            out.push(review);
            // don't recurse into a matched review node
            return;
        }
        for (const child of node) collectReviews(child, out, depth + 1);
    }
}

/**
 * Heuristically extract a review from an array node.
 * Google's format for a single review (listugcposts) looks roughly like:
 * [ reviewId, [ ...authorInfo (name, url, photo, "Local Guide · N reviews") ],
 *   [ ...rating/time block ], ... , reviewText, ... ]
 * We scan for the signature rather than relying on exact indices.
 */
function tryExtractReview(arr) {
    try {
        // Must have a review-id-like string at [0]
        if (typeof arr[0] !== 'string' || arr[0].length < 8) return null;

        // Flatten a shallow view to search for signals
        const flat = flattenShallow(arr, 4);

        // Find a rating: a lone integer 1..5 that appears near a star context.
        // In listugcposts the rating is nested; we look for the value in known spots.
        let rating = findRating(arr);
        if (rating == null) return null;

        // Reviewer name: first reasonable human-readable string that isn't a URL/id
        let reviewerName = null;
        let reviewerProfileUrl = '';
        let isLocalGuide = false;
        let reviewerTotalReviews = 0;

        for (const s of flat) {
            if (typeof s !== 'string') continue;
            if (!reviewerProfileUrl && s.includes('/maps/contrib/')) reviewerProfileUrl = s;
            if (!reviewerName && /^[\p{L}][\p{L}\s.'-]{1,60}$/u.test(s) && !s.startsWith('http') && s.split(' ').length <= 5) {
                // avoid catching the review text (too long) or generic tokens
                reviewerName = s;
            }
            if (/local guide/i.test(s)) isLocalGuide = true;
            const rev = s.match(/(\d+)\s+reviews?/i);
            if (rev) reviewerTotalReviews = parseInt(rev[1], 10);
        }

        // Review text: the longest string that isn't a URL and isn't the name
        let reviewText = '';
        for (const s of flat) {
            if (typeof s === 'string' && !s.startsWith('http') && s !== reviewerName && s.length > reviewText.length) {
                // exclude obvious metadata strings
                if (!/^\d+$/.test(s) && !s.includes('/maps/') && !/^[A-Za-z0-9_-]{20,}$/.test(s)) {
                    reviewText = s;
                }
            }
        }

        // Relative time string like "2 months ago"
        let publishedAt = '';
        for (const s of flat) {
            if (typeof s === 'string' && /\b(a|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i.test(s)) {
                publishedAt = s;
                break;
            }
        }

        if (rating < minRating) return null;

        return {
            reviewerName: reviewerName || 'Anonymous',
            rating,
            reviewText: reviewText || '',
            publishedAt,
            reviewerProfileUrl,
            reviewerTotalReviews,
            isLocalGuide,
            reviewLikes: 0,
            reviewPhotos: [],
            ownerResponse: '',
            ownerResponseDate: '',
        };
    } catch {
        return null;
    }
}

function findRating(arr) {
    // Look for the star rating. In listugcposts the rating integer 1..5 is
    // usually wrapped in a small array like [rating] near the top levels.
    const stack = [{ n: arr, d: 0 }];
    while (stack.length) {
        const { n, d } = stack.pop();
        if (d > 6 || !Array.isArray(n)) continue;
        for (let i = 0; i < n.length; i++) {
            const v = n[i];
            if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) {
                // sanity: rating is rarely at index 0 top-level; accept it
                return v;
            }
            if (Array.isArray(v)) stack.push({ n: v, d: d + 1 });
        }
    }
    return null;
}

function flattenShallow(arr, maxDepth) {
    const out = [];
    const stack = [{ n: arr, d: 0 }];
    while (stack.length) {
        const { n, d } = stack.pop();
        if (Array.isArray(n)) {
            if (d >= maxDepth) continue;
            for (const c of n) stack.push({ n: c, d: d + 1 });
        } else {
            out.push(n);
        }
    }
    return out;
}

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 1,
    maxConcurrency: 1,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 150,
    headless: true,
    browserPoolOptions: { maxOpenPagesPerBrowser: 1 },

    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            // networkidle never fires on Google Maps (live app). Use domcontentloaded.
            gotoOptions.waitUntil = 'domcontentloaded';
            gotoOptions.timeout = 60000;
            await page.context().addCookies([{
                name: 'SOCS',
                value: 'CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMTA5LjA1X3AwGgJlbiADGgYIgLC_rQY',
                domain: '.google.com',
                path: '/',
            }, {
                name: 'CONSENT',
                value: 'YES+cb.20210720-07-p0.en+FX+410',
                domain: '.google.com',
                path: '/',
            }]);
        },
    ],

    async requestHandler({ page, request }) {
        const { maxReviews } = request.userData;
        const target = maxReviews || 100;
        const captured = [];
        let sniffedFtid = null;

        // Intercept Google's own background XHRs: grab reviews + the feature ID
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('listugcposts') || url.includes('listentitiesreviews') || url.includes('/maps/preview/place')) {
                try {
                    const body = await response.text();
                    if (!sniffedFtid) {
                        const m = body.match(/(0x[0-9a-f]{8,}:0x[0-9a-f]{8,})/i);
                        if (m) { sniffedFtid = m[1]; log.info(`Sniffed featureId from XHR: ${sniffedFtid}`); }
                    }
                    const parsed = parseReviewResponse(body);
                    if (parsed.length) {
                        captured.push(...parsed);
                        log.info(`Captured ${parsed.length} reviews from background XHR (total ${captured.length})`);
                    }
                } catch { /* ignore */ }
            }
        });

        log.info(`Navigating to: ${request.url}`);
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        // Give Google's own background requests time to fire (preview/place, reviews)
        await page.waitForTimeout(8000);

        // Dismiss consent if present
        try {
            for (const sel of ['button[aria-label*="Accept"]', 'button:has-text("Accept all")', 'form[action*="consent"] button']) {
                const b = page.locator(sel).first();
                if (await b.isVisible({ timeout: 1500 }).catch(() => false)) {
                    await b.click().catch(() => {});
                    await page.waitForTimeout(2000);
                    break;
                }
            }
        } catch { /* ignore */ }

        // Grab place metadata (best-effort)
        let placeData = { placeName: 'Unknown', placeOverallRating: null, placeTotalReviews: null, placeAddress: '' };
        try {
            placeData = await page.evaluate(() => {
                const t = (document.title || '').replace(/ - Google Maps.*$/, '').trim();
                const h1 = document.querySelector('h1');
                let rating = null;
                const bodyTxt = document.body ? document.body.innerText : '';
                const rm = bodyTxt.match(/([0-9][.,][0-9])\s*\n?\s*[\d,]+\s*reviews?/i);
                if (rm) rating = parseFloat(rm[1].replace(',', '.'));
                let total = null;
                const cm = bodyTxt.match(/([\d,]+)\s*reviews?/i);
                if (cm) total = parseInt(cm[1].replace(/,/g, ''), 10);
                return {
                    placeName: (h1 && h1.textContent.trim()) || t || 'Unknown',
                    placeOverallRating: rating,
                    placeTotalReviews: total,
                    placeAddress: '',
                };
            });
        } catch (e) { log.debug(`metadata: ${e.message}`); }

        // DIRECT API METHOD: resolve the place feature ID, then call listugcposts.
        // The interactive Maps UI often won't hydrate headless, so we skip it and
        // hit Google's internal review RPC directly from within the page context
        // (so it uses the browser's cookies/session/IP).
        const finalUrl = page.url();
        const pageHtml = await page.content().catch(() => '');

        // Feature ID looks like 0x6b12ae401e8b983f:0x5017d681632ccc0
        // Prefer the one sniffed from Google's own XHR responses.
        let featureId = sniffedFtid;
        const fidPatterns = [
            /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i,
            /(0x[0-9a-f]{8,}:0x[0-9a-f]{8,})/i,
            /"(0x[0-9a-f]{8,}:0x[0-9a-f]{8,})"/i,
        ];
        if (!featureId) {
            for (const src of [finalUrl, pageHtml]) {
                for (const re of fidPatterns) {
                    const m = src.match(re);
                    if (m) { featureId = m[1]; break; }
                }
                if (featureId) break;
            }
        }
        log.info(`Place="${placeData.placeName}" featureId=${featureId || 'NOT FOUND'} sniffedReviews=${captured.length} url=${finalUrl.slice(0, 120)}`);

        const SORT_PB = { relevant: 1, newest: 2, highest: 3, lowest: 4 };
        const sortCode = SORT_PB[sortBy] || 2;

        if (featureId) {
            // Fetch reviews page-by-page via the internal RPC, inside the browser
            let pageToken = '';
            let pageNum = 0;
            while (captured.length < target && pageNum < 30) {
                const pb = `!1m6!1s${featureId}!6m4!4m1!1e1!4m1!1e3!2m2!1i10!2s${pageToken}!5m2!1s!7e81!8m9!2b1!3b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1!11m4!1e3!2e1!6m1!1i2!13m1!1e${sortCode}`;
                const apiUrl = `https://www.google.com/maps/rpc/listugcposts?authuser=0&hl=${language}&gl=us&pb=${encodeURIComponent(pb)}`;

                let body = '';
                try {
                    body = await page.evaluate(async (u) => {
                        const res = await fetch(u, { credentials: 'include' });
                        return await res.text();
                    }, apiUrl);
                } catch (e) {
                    log.warning(`fetch page ${pageNum} failed: ${e.message}`);
                    break;
                }

                // Save the first raw RPC response so we can inspect/fix the parser
                if (pageNum === 0) {
                    try {
                        const store = await Actor.openKeyValueStore();
                        await store.setValue('DEBUG_RPC_RAW', body, { contentType: 'text/plain' });
                        log.info(`RPC page 0 body length=${body.length}, starts: ${body.slice(0, 80)}`);
                    } catch { /* ignore */ }
                }

                const parsed = parseReviewResponse(body);
                log.info(`RPC page ${pageNum}: parsed ${parsed.length} reviews`);
                if (!parsed.length) break;
                captured.push(...parsed);

                // Extract next page token (a long string near the start of the response)
                const clean = body.replace(/^\)\]\}'\n?/, '');
                const tokMatch = clean.match(/"([A-Za-z0-9_=-]{40,})"/);
                const newToken = tokMatch ? tokMatch[1] : '';
                if (!newToken || newToken === pageToken) break;
                pageToken = newToken;
                pageNum++;
                await page.waitForTimeout(600 + Math.random() * 600);
            }
        }

        // Dedupe
        const seen = new Set();
        const unique = [];
        for (const r of captured) {
            const key = `${r.reviewerName}|${r.rating}|${(r.reviewText || '').slice(0, 40)}|${r.publishedAt}`;
            if (!seen.has(key)) { seen.add(key); unique.push(r); }
        }

        const finalReviews = unique.slice(0, target).map(r => ({
            reviewerName: r.reviewerName,
            rating: r.rating,
            reviewText: r.reviewText,
            publishedAt: r.publishedAt,
            reviewerProfileUrl: r.reviewerProfileUrl,
            reviewerTotalReviews: r.reviewerTotalReviews,
            isLocalGuide: r.isLocalGuide,
            ownerResponse: includeOwnerResponse ? r.ownerResponse : undefined,
            ownerResponseDate: includeOwnerResponse ? r.ownerResponseDate : undefined,
            reviewLikes: r.reviewLikes,
            reviewPhotos: r.reviewPhotos,
            placeName: placeData.placeName,
            placeAddress: placeData.placeAddress,
            placeOverallRating: placeData.placeOverallRating,
            placeTotalReviews: placeData.placeTotalReviews,
            placeUrl: request.url,
        }));

        if (finalReviews.length) {
            try {
                await Actor.pushData(finalReviews);
                totalReviewsScraped += finalReviews.length;
                log.info(`✅ Pushed ${finalReviews.length} reviews for "${placeData.placeName}"`);
            } catch (e) {
                log.error(`pushData failed: ${e.message}`);
            }
        } else {
            // Save a screenshot + HTML so we can see what happened
            try {
                const shot = await page.screenshot({ fullPage: false });
                const store = await Actor.openKeyValueStore();
                await store.setValue('DEBUG_SCREENSHOT', shot, { contentType: 'image/png' });
                const html = await page.content();
                await store.setValue('DEBUG_HTML', html, { contentType: 'text/html' });
            } catch { /* ignore */ }

            // Diagnostic row — only valid-typed fields (no nulls for int/number fields)
            try {
                await Actor.pushData([{
                    reviewerName: 'NO_REVIEWS_CAPTURED',
                    reviewText: `Place="${placeData.placeName}". Captured 0 review XHRs. See DEBUG_SCREENSHOT/DEBUG_HTML.`,
                    placeName: placeData.placeName,
                    placeUrl: request.url,
                }]);
            } catch (e) {
                log.error(`diagnostic pushData failed: ${e.message}`);
            }
            log.warning(`No reviews captured for "${placeData.placeName}"`);
        }
    },

    async failedRequestHandler({ request }, error) {
        log.error(`Request failed: ${request.url} — ${error.message}`);
        try {
            await Actor.pushData([{
                reviewerName: 'REQUEST_FAILED',
                reviewText: `${error.message}`,
                placeName: 'ERROR',
                placeUrl: request.url,
            }]);
        } catch { /* ignore */ }
    },
});

const killTimer = setTimeout(async () => {
    log.warning(`Max run time ${maxRunTimeMinutes}m reached. Tearing down.`);
    await crawler.teardown();
}, maxRunTimeMinutes * 60 * 1000);

const requests = placeUrls.map(url => {
    let u = url.trim();
    if (!u.startsWith('http')) u = `https://www.google.com/maps/place/${encodeURIComponent(u)}`;
    if (!u.includes('hl=')) u += (u.includes('?') ? '&' : '?') + `hl=${language}`;
    return { url: u, userData: { maxReviews: maxReviewsPerPlace || 100 } };
});

log.info(`Starting GMaps Reviews Scraper (network interception). Places=${requests.length} sort=${sortBy}`);
await crawler.run(requests);
clearTimeout(killTimer);

log.info(`🎉 Done. Total reviews: ${totalReviewsScraped}`);
await Actor.exit({ statusMessage: `Extracted ${totalReviewsScraped} reviews from ${placeUrls.length} place(s)` });

} catch (err) {
    log.error(`Fatal: ${err.message}`);
    log.error(err.stack);
    await Actor.exit({ statusMessage: `FATAL: ${err.message}`, exitCode: 1 });
}
