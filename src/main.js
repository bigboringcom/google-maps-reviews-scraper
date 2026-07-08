import { Actor, log } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';

await Actor.init();

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

// Sort button text mapping (English)
const SORT_BUTTON_MAP = {
    newest: 'Newest',
    highest: 'Highest rating',
    lowest: 'Lowest rating',
    relevant: 'Most relevant',
};

// Configure proxy
const proxyConfig = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : await Actor.createProxyConfiguration({ useApifyProxy: true, apifyProxyGroups: ['GOOGLE_SERP'] });

let totalReviewsScraped = 0;

// Kill switch
const killTimer = setTimeout(async () => {
    log.warning(`Maximum run time of ${maxRunTimeMinutes} minutes reached. Shutting down gracefully.`);
    await crawler.teardown();
}, maxRunTimeMinutes * 60 * 1000);

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 2,
    maxConcurrency: 1, // Google Maps is heavy, keep concurrency low
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    headless: true,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    browserPoolOptions: {
        maxOpenPagesPerBrowser: 1,
    },

    async requestHandler({ page, request }) {
        const { maxReviews } = request.userData;

        log.info(`Processing place: ${request.url}`);

        // Wait for the page to load
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

        // Accept cookies if prompted
        const consentButton = page.locator('button:has-text("Accept all")');
        if (await consentButton.isVisible({ timeout: 3000 }).catch(() => false)) {
            await consentButton.click();
            await page.waitForTimeout(1000);
        }

        // Wait for the place name to appear (indicates page loaded)
        await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});

        // Extract place metadata
        const placeData = await page.evaluate(() => {
            const nameEl = document.querySelector('h1');
            const ratingEl = document.querySelector('[class*="fontDisplayLarge"]');
            const reviewCountEl = document.querySelector('button[jsaction*="review"]');

            // Try to get address
            const addressEl = document.querySelector('[data-item-id="address"] .fontBodyMedium');
            const addressAlt = document.querySelector('button[data-item-id="address"]');

            let totalReviews = null;
            if (reviewCountEl) {
                const match = reviewCountEl.textContent.match(/([\d,]+)\s*review/i);
                if (match) totalReviews = parseInt(match[1].replace(/,/g, ''), 10);
            }
            // Also try from aria-label
            if (!totalReviews) {
                const allButtons = document.querySelectorAll('button');
                for (const btn of allButtons) {
                    const match = btn.textContent.match(/([\d,]+)\s*review/i);
                    if (match) { totalReviews = parseInt(match[1].replace(/,/g, ''), 10); break; }
                }
            }

            return {
                placeName: nameEl ? nameEl.textContent.trim() : 'Unknown Place',
                placeOverallRating: ratingEl ? parseFloat(ratingEl.textContent.trim()) : null,
                placeTotalReviews: totalReviews,
                placeAddress: addressEl ? addressEl.textContent.trim() : (addressAlt ? addressAlt.textContent.trim() : ''),
            };
        });

        log.info(`Place: "${placeData.placeName}" — Rating: ${placeData.placeOverallRating}, Total reviews: ${placeData.placeTotalReviews || '?'}`);

        // Click on the Reviews tab
        const reviewsTab = page.locator('button[role="tab"]:has-text("Reviews")');
        if (await reviewsTab.isVisible({ timeout: 5000 }).catch(() => false)) {
            await reviewsTab.click();
            await page.waitForTimeout(2000);
        } else {
            // Try alternative: click on the reviews count text
            const reviewsLink = page.locator('button:has-text("review")').first();
            if (await reviewsLink.isVisible({ timeout: 3000 }).catch(() => false)) {
                await reviewsLink.click();
                await page.waitForTimeout(2000);
            }
        }

        // Sort reviews
        const sortButton = page.locator('button[aria-label*="Sort"], button[data-value="Sort"]').first();
        if (await sortButton.isVisible({ timeout: 5000 }).catch(() => false)) {
            await sortButton.click();
            await page.waitForTimeout(1000);

            // Click the desired sort option
            const sortOption = SORT_BUTTON_MAP[sortBy] || 'Newest';
            const sortMenuItem = page.locator(`[role="menuitemradio"]:has-text("${sortOption}"), [data-index]:has-text("${sortOption}")`).first();
            if (await sortMenuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                await sortMenuItem.click();
                await page.waitForTimeout(2000);
            }
        }

        // Scroll to load reviews
        const reviewsContainer = page.locator('[class*="review"], div[tabindex="-1"]').first();
        const scrollable = page.locator('div[tabindex="-1"]').first();

        let previousReviewCount = 0;
        let scrollAttempts = 0;
        const maxScrollAttempts = Math.ceil(maxReviews / 5) + 10; // ~5 reviews per scroll

        while (scrollAttempts < maxScrollAttempts) {
            // Count current visible reviews
            const currentCount = await page.locator('[data-review-id], [class*="fontBodyMedium"][data-review-id], div[aria-label*="stars"]').count();

            if (currentCount >= maxReviews) break;
            if (currentCount === previousReviewCount && scrollAttempts > 3) break;

            previousReviewCount = currentCount;

            // Scroll the reviews panel
            await page.evaluate(() => {
                const panels = document.querySelectorAll('div[tabindex="-1"]');
                for (const panel of panels) {
                    if (panel.scrollHeight > panel.clientHeight) {
                        panel.scrollTop = panel.scrollHeight;
                    }
                }
                // Also try scrolling the main scrollable container
                const scrollable = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf');
                if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
            });

            await page.waitForTimeout(1500 + Math.random() * 1000);
            scrollAttempts++;
        }

        // Expand all "More" buttons to get full review text
        const moreButtons = page.locator('button[aria-label="See more"], button:has-text("More")');
        const moreCount = await moreButtons.count();
        for (let i = 0; i < Math.min(moreCount, maxReviews); i++) {
            try {
                await moreButtons.nth(i).click({ timeout: 1000 });
            } catch { /* ignore click failures */ }
        }
        await page.waitForTimeout(500);

        // Extract all reviews from the page
        const reviews = await page.evaluate(({ includeOwnerResponse, minRating }) => {
            const results = [];

            // Find review containers - Google Maps uses data-review-id attribute
            const reviewEls = document.querySelectorAll('[data-review-id]');

            for (const el of reviewEls) {
                // Reviewer name
                const nameEl = el.querySelector('[class*="d4r55"]') || el.querySelector('button[class*="WEBjve"]');
                const reviewerName = nameEl ? nameEl.textContent.trim() : 'Anonymous';

                // Rating from aria-label
                let rating = null;
                const starsEl = el.querySelector('[role="img"][aria-label*="star"]');
                if (starsEl) {
                    const match = starsEl.getAttribute('aria-label').match(/(\d)/);
                    if (match) rating = parseInt(match[1], 10);
                }

                // Skip if below min rating
                if (rating !== null && rating < minRating) continue;

                // Review text
                const textEl = el.querySelector('[class*="wiI7pd"]') || el.querySelector('[class*="MyEned"]');
                const reviewText = textEl ? textEl.textContent.trim() : '';

                // Date
                const dateEl = el.querySelector('[class*="rsqaWe"]');
                const publishedAt = dateEl ? dateEl.textContent.trim() : '';

                // Reviewer profile URL
                const profileLink = el.querySelector('a[href*="/contrib/"]');
                const reviewerProfileUrl = profileLink ? profileLink.href : '';

                // Local Guide badge
                const isLocalGuide = el.textContent.toLowerCase().includes('local guide');

                // Reviewer total reviews
                let reviewerTotalReviews = 0;
                const statsEl = el.querySelector('[class*="RfnDt"]');
                if (statsEl) {
                    const match = statsEl.textContent.match(/(\d+)\s*review/i);
                    if (match) reviewerTotalReviews = parseInt(match[1], 10);
                }

                // Likes
                let reviewLikes = 0;
                const likesEl = el.querySelector('[class*="pkWtMe"]');
                if (likesEl) {
                    const match = likesEl.textContent.match(/(\d+)/);
                    if (match) reviewLikes = parseInt(match[1], 10);
                }

                // Photos
                const photoEls = el.querySelectorAll('button[class*="Tya61d"] img, [class*="KtCyie"] img');
                const reviewPhotos = [];
                for (const img of photoEls) {
                    const src = img.getAttribute('src');
                    if (src && src.includes('googleusercontent')) reviewPhotos.push(src);
                }

                // Owner response
                let ownerResponse = '';
                let ownerResponseDate = '';
                if (includeOwnerResponse) {
                    const responseEl = el.querySelector('[class*="CDe7pd"]');
                    if (responseEl) {
                        ownerResponse = responseEl.textContent.trim();
                        const respDateEl = el.querySelector('[class*="pi8uOe"]');
                        if (respDateEl) ownerResponseDate = respDateEl.textContent.trim();
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
                    reviewPhotos,
                });
            }

            return results;
        }, { includeOwnerResponse, minRating });

        // Limit to maxReviews and add place metadata
        const finalReviews = reviews.slice(0, maxReviews).map(r => ({
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
            log.info(`✅ Extracted ${finalReviews.length} reviews for "${placeData.placeName}"`);
        } else {
            log.warning(`⚠️ No reviews extracted for "${placeData.placeName}". The page structure may have changed.`);
            // Still push place metadata
            await Actor.pushData([{
                reviewerName: null,
                rating: null,
                reviewText: 'NO_REVIEWS_FOUND - Place was loaded but no reviews could be extracted.',
                publishedAt: null,
                placeName: placeData.placeName,
                placeAddress: placeData.placeAddress,
                placeOverallRating: placeData.placeOverallRating,
                placeTotalReviews: placeData.placeTotalReviews,
                placeUrl: request.url,
            }]);
            totalReviewsScraped += 1;
        }
    },

    async failedRequestHandler({ request }, error) {
        log.error(`Request failed: ${request.url} — ${error.message}`);
    },
});

// Build requests
const requests = placeUrls.map(url => {
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http')) {
        normalizedUrl = `https://www.google.com/maps/place/${encodeURIComponent(normalizedUrl)}`;
    }
    // Add language parameter
    if (!normalizedUrl.includes('hl=')) {
        normalizedUrl += (normalizedUrl.includes('?') ? '&' : '?') + `hl=${language}`;
    }
    return {
        url: normalizedUrl,
        userData: { maxReviews: maxReviewsPerPlace || 100 },
    };
});

log.info(`Starting Google Maps Reviews Scraper (Playwright)...`);
log.info(`Places to process: ${requests.length}`);
log.info(`Max reviews per place: ${maxReviewsPerPlace || 'unlimited'}`);
log.info(`Sort by: ${sortBy}`);

await crawler.run(requests);

clearTimeout(killTimer);
log.info(`🎉 Scraping complete. Total reviews extracted: ${totalReviewsScraped}`);
await Actor.exit({ statusMessage: `Extracted ${totalReviewsScraped} reviews from ${placeUrls.length} place(s)` });
