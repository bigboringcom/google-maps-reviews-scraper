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
    log.error('No place URLs provided. Please add at least one Google Maps place URL.');
    await Actor.exit({ statusMessage: 'No place URLs provided' });
}

const SORT_BUTTON_MAP = {
    newest: 'Newest',
    highest: 'Highest rating',
    lowest: 'Lowest rating',
    relevant: 'Most relevant',
};

// Configure proxy — use residential for Google Maps
const proxyConfig = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : await Actor.createProxyConfiguration({ useApifyProxy: true });

let totalReviewsScraped = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 2,
    maxConcurrency: 1,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    headless: true,
    browserPoolOptions: {
        maxOpenPagesPerBrowser: 1,
    },
    preNavigationHooks: [
        async ({ page }) => {
            // Set locale and timezone to appear more natural
            await page.context().addCookies([{
                name: 'CONSENT',
                value: 'YES+cb.20210720-07-p0.en+FX+410',
                domain: '.google.com',
                path: '/',
            }]);
        },
    ],

    async requestHandler({ page, request }) {
        const { maxReviews } = request.userData;
        log.info(`Navigating to: ${request.url}`);

        // Wait for page to be interactive — use shorter timeout and don't throw
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(5000);

        // Handle consent dialog if it appears
        try {
            const consentSelectors = [
                'button:has-text("Accept all")',
                'button:has-text("Accept")',
                'button:has-text("I agree")',
                'button:has-text("Agree")',
                'form[action*="consent"] button',
                '[aria-label="Accept all"]',
            ];
            for (const sel of consentSelectors) {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await btn.click();
                    log.info('Clicked consent button');
                    await page.waitForTimeout(3000);
                    break;
                }
            }
        } catch (e) {
            log.debug(`Consent handling: ${e.message}`);
        }

        // Wait for Google Maps to fully load — look for key elements
        await page.waitForSelector('h1, [role="main"], #searchboxinput', { timeout: 15000 })
            .catch(() => log.warning('Main page elements not found within 15s timeout'));

        // Additional wait for dynamic content
        await page.waitForTimeout(3000);

        // Take a screenshot for debugging (stored in KV store)
        const screenshot = await page.screenshot({ fullPage: false });
        const store = await Actor.openKeyValueStore();
        await store.setValue('DEBUG_SCREENSHOT', screenshot, { contentType: 'image/png' });

        // Extract place metadata
        const placeData = await page.evaluate(() => {
            const nameEl = document.querySelector('h1');
            let placeName = nameEl ? nameEl.textContent.trim() : '';

            // Fallback: get from title
            if (!placeName) {
                const title = document.title || '';
                placeName = title.replace(/ - Google Maps.*$/, '').trim() || 'Unknown Place';
            }

            // Rating
            let placeOverallRating = null;
            const ratingEl = document.querySelector('div.fontDisplayLarge, span.ceNzKf, [class*="fontDisplayLarge"]');
            if (ratingEl) {
                const val = parseFloat(ratingEl.textContent.trim().replace(',', '.'));
                if (val >= 1 && val <= 5) placeOverallRating = val;
            }

            // Total reviews count
            let placeTotalReviews = null;
            const allText = document.body.innerText || '';
            const reviewMatch = allText.match(/([\d,]+)\s*reviews?/i);
            if (reviewMatch) placeTotalReviews = parseInt(reviewMatch[1].replace(/,/g, ''), 10);

            // Address
            let placeAddress = '';
            const addrBtn = document.querySelector('[data-item-id="address"]');
            if (addrBtn) placeAddress = addrBtn.textContent.trim();

            return { placeName, placeOverallRating, placeTotalReviews, placeAddress };
        });

        log.info(`Place: "${placeData.placeName}" — Rating: ${placeData.placeOverallRating}, Reviews: ${placeData.placeTotalReviews || '?'}`);

        // If we couldn't even get a place name, the page likely didn't load properly
        if (!placeData.placeName || placeData.placeName === 'Unknown Place') {
            const pageTitle = await page.title();
            const url = page.url();
            log.warning(`Page might not have loaded correctly. Title: "${pageTitle}", URL: ${url}`);

            // Try waiting a bit more
            await page.waitForTimeout(5000);
            const retryName = await page.evaluate(() => {
                const h1 = document.querySelector('h1');
                return h1 ? h1.textContent.trim() : null;
            });
            if (retryName) placeData.placeName = retryName;
        }

        // Click on Reviews tab
        let reviewsTabClicked = false;
        const reviewsTabSelectors = [
            'button[role="tab"]:has-text("Reviews")',
            'button[role="tab"]:has-text("reviews")',
            '[role="tablist"] button:nth-child(2)',
        ];

        for (const sel of reviewsTabSelectors) {
            try {
                const tab = page.locator(sel).first();
                if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await tab.click();
                    reviewsTabClicked = true;
                    log.info('Clicked Reviews tab');
                    await page.waitForTimeout(3000);
                    break;
                }
            } catch (e) {
                log.debug(`Tab selector ${sel} failed: ${e.message}`);
            }
        }

        if (!reviewsTabClicked) {
            // Try clicking on the review count text/button
            try {
                const reviewBtn = page.locator('button:has-text("review"), [jsaction*="review"]').first();
                if (await reviewBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await reviewBtn.click();
                    reviewsTabClicked = true;
                    await page.waitForTimeout(3000);
                }
            } catch (e) {
                log.debug(`Review button click failed: ${e.message}`);
            }
        }

        // Sort reviews if we managed to get to the reviews section
        if (reviewsTabClicked) {
            try {
                // Look for sort button
                const sortBtn = page.locator('button[aria-label*="Sort"], button[data-value="Sort"], button:has-text("Sort")').first();
                if (await sortBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                    await sortBtn.click();
                    await page.waitForTimeout(1500);

                    const sortOption = SORT_BUTTON_MAP[sortBy] || 'Newest';
                    const menuItem = page.locator(`[role="menuitemradio"]:has-text("${sortOption}"), [role="menuitem"]:has-text("${sortOption}"), li:has-text("${sortOption}")`).first();
                    if (await menuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                        await menuItem.click();
                        log.info(`Sorted reviews by: ${sortOption}`);
                        await page.waitForTimeout(3000);
                    }
                }
            } catch (e) {
                log.debug(`Sort failed: ${e.message}`);
            }
        }

        // Scroll to load more reviews
        const targetReviews = maxReviews || 100;
        let scrollAttempts = 0;
        const maxScrollAttempts = Math.min(Math.ceil(targetReviews / 3) + 5, 50);

        while (scrollAttempts < maxScrollAttempts) {
            const reviewCount = await page.locator('[data-review-id]').count();
            if (reviewCount >= targetReviews) break;

            // Scroll the scrollable panel
            await page.evaluate(() => {
                // Google Maps reviews are in a scrollable div
                const scrollables = document.querySelectorAll('[class*="m6QErb"][class*="DxyBCb"], div[tabindex="-1"][class*="e3goi"]');
                for (const el of scrollables) {
                    if (el.scrollHeight > el.clientHeight + 100) {
                        el.scrollTop = el.scrollHeight;
                        return;
                    }
                }
                // Fallback: scroll any tall div that's likely the reviews container
                const divs = document.querySelectorAll('div[tabindex="-1"]');
                for (const div of divs) {
                    if (div.scrollHeight > 2000 && div.clientHeight < div.scrollHeight) {
                        div.scrollTop = div.scrollHeight;
                        return;
                    }
                }
            });

            await page.waitForTimeout(1500 + Math.random() * 1000);
            scrollAttempts++;

            // Check if we're still getting new reviews
            const newCount = await page.locator('[data-review-id]').count();
            if (newCount === reviewCount && scrollAttempts > 3) {
                log.info(`No new reviews after scroll attempt ${scrollAttempts}. Stopping.`);
                break;
            }
        }

        // Expand "More" buttons for full review text
        try {
            const moreButtons = page.locator('button[aria-label="See more"], button.w8nwRe');
            const moreCount = await moreButtons.count();
            for (let i = 0; i < Math.min(moreCount, targetReviews); i++) {
                await moreButtons.nth(i).click({ timeout: 500 }).catch(() => {});
            }
            if (moreCount > 0) await page.waitForTimeout(500);
        } catch (e) {
            log.debug(`Expand buttons: ${e.message}`);
        }

        // Extract reviews
        const reviews = await page.evaluate(({ includeOwnerResponse, minRating }) => {
            const results = [];
            const reviewEls = document.querySelectorAll('[data-review-id]');

            for (const el of reviewEls) {
                // Reviewer name
                const nameEl = el.querySelector('.d4r55') || el.querySelector('button.WEBjve') || el.querySelector('[class*="d4r55"]');
                const reviewerName = nameEl ? nameEl.textContent.trim() : 'Anonymous';

                // Rating
                let rating = null;
                const starsEl = el.querySelector('[role="img"][aria-label*="star"]');
                if (starsEl) {
                    const label = starsEl.getAttribute('aria-label') || '';
                    const match = label.match(/(\d)/);
                    if (match) rating = parseInt(match[1], 10);
                }

                if (rating !== null && rating < minRating) continue;

                // Review text (expanded)
                const textEl = el.querySelector('.wiI7pd') || el.querySelector('[class*="wiI7pd"]') || el.querySelector('.MyEned span');
                const reviewText = textEl ? textEl.textContent.trim() : '';

                // Date
                const dateEl = el.querySelector('.rsqaWe') || el.querySelector('[class*="rsqaWe"]');
                const publishedAt = dateEl ? dateEl.textContent.trim() : '';

                // Profile URL
                const profileLink = el.querySelector('a[href*="/contrib/"]');
                const reviewerProfileUrl = profileLink ? profileLink.href : '';

                // Local Guide
                const isLocalGuide = (el.textContent || '').includes('Local Guide');

                // Reviewer stats
                let reviewerTotalReviews = 0;
                const statsEl = el.querySelector('.RfnDt') || el.querySelector('[class*="RfnDt"]');
                if (statsEl) {
                    const m = statsEl.textContent.match(/(\d+)\s*review/i);
                    if (m) reviewerTotalReviews = parseInt(m[1], 10);
                }

                // Likes
                let reviewLikes = 0;
                const likesEl = el.querySelector('.pkWtMe') || el.querySelector('[class*="pkWtMe"]');
                if (likesEl) {
                    const m = likesEl.textContent.match(/(\d+)/);
                    if (m) reviewLikes = parseInt(m[1], 10);
                }

                // Photos
                const photos = [];
                el.querySelectorAll('button.Tya61d img, [class*="KtCyie"] img').forEach(img => {
                    const src = img.getAttribute('src');
                    if (src && src.includes('googleusercontent')) photos.push(src);
                });

                // Owner response
                let ownerResponse = '';
                let ownerResponseDate = '';
                if (includeOwnerResponse) {
                    const respContainer = el.querySelector('.CDe7pd') || el.querySelector('[class*="CDe7pd"]');
                    if (respContainer) {
                        ownerResponse = respContainer.textContent.trim();
                        const respDate = el.querySelector('.pi8uOe') || el.querySelector('[class*="pi8uOe"]');
                        if (respDate) ownerResponseDate = respDate.textContent.trim();
                    }
                }

                results.push({
                    reviewerName,
                    rating,
                    reviewText,
                    publishedAt,
                    reviewerProfileUrl,
                    reviewerTotalReviews,
                    isLocalGuide,
                    ownerResponse: includeOwnerResponse ? ownerResponse : undefined,
                    ownerResponseDate: includeOwnerResponse ? ownerResponseDate : undefined,
                    reviewLikes,
                    reviewPhotos: photos,
                });
            }

            return results;
        }, { includeOwnerResponse, minRating });

        log.info(`Found ${reviews.length} reviews on page`);

        // Build final output
        const finalReviews = reviews.slice(0, targetReviews).map(r => ({
            ...r,
            placeName: placeData.placeName,
            placeAddress: placeData.placeAddress,
            placeOverallRating: placeData.placeOverallRating,
            placeTotalReviews: placeData.placeTotalReviews,
            placeUrl: request.url,
        }));

        if (finalReviews.length > 0) {
            await Actor.pushData(finalReviews);
            totalReviewsScraped += finalReviews.length;
            log.info(`✅ Pushed ${finalReviews.length} reviews for "${placeData.placeName}"`);
        } else {
            // Push a diagnostic record
            await Actor.pushData([{
                reviewerName: null,
                rating: null,
                reviewText: `NO_REVIEWS_EXTRACTED. Place loaded: "${placeData.placeName}". Reviews tab clicked: ${reviewsTabClicked}. Page URL: ${page.url()}`,
                publishedAt: null,
                placeName: placeData.placeName || 'Unknown',
                placeAddress: placeData.placeAddress || '',
                placeOverallRating: placeData.placeOverallRating,
                placeTotalReviews: placeData.placeTotalReviews,
                placeUrl: request.url,
            }]);
            totalReviewsScraped += 1;
            log.warning(`⚠️ No reviews extracted for "${placeData.placeName}". Diagnostic record pushed.`);
        }
    },

    async failedRequestHandler({ request }, error) {
        log.error(`Request failed after retries: ${request.url}`);
        log.error(`Error: ${error.message}`);

        // Save error details
        await Actor.pushData([{
            reviewerName: null,
            rating: null,
            reviewText: `REQUEST_FAILED: ${error.message}`,
            publishedAt: null,
            placeName: 'ERROR',
            placeUrl: request.url,
        }]);
    },
});

// Kill switch
const killTimer = setTimeout(async () => {
    log.warning(`Maximum run time of ${maxRunTimeMinutes} minutes reached. Shutting down.`);
    await crawler.teardown();
}, maxRunTimeMinutes * 60 * 1000);

// Build requests
const requests = placeUrls.map(url => {
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http')) {
        normalizedUrl = `https://www.google.com/maps/place/${encodeURIComponent(normalizedUrl)}`;
    }
    if (!normalizedUrl.includes('hl=')) {
        normalizedUrl += (normalizedUrl.includes('?') ? '&' : '?') + `hl=${language}`;
    }
    return {
        url: normalizedUrl,
        userData: { maxReviews: maxReviewsPerPlace || 100 },
    };
});

log.info(`Starting Google Maps Reviews Scraper (Playwright, Node 20)...`);
log.info(`Places: ${requests.length}, Max reviews/place: ${maxReviewsPerPlace}, Sort: ${sortBy}`);

await crawler.run(requests);
clearTimeout(killTimer);

log.info(`🎉 Done. Total reviews extracted: ${totalReviewsScraped}`);
await Actor.exit({ statusMessage: `Extracted ${totalReviewsScraped} reviews from ${placeUrls.length} place(s)` });

} catch (err) {
    log.error(`Fatal error: ${err.message}`);
    log.error(err.stack);
    const store = await Actor.openKeyValueStore();
    await store.setValue('ERROR_LOG', { message: err.message, stack: err.stack }, { contentType: 'application/json' });
    await Actor.exit({ statusMessage: `FATAL: ${err.message}`, exitCode: 1 });
}
