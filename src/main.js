import { CheerioCrawler, log, RequestQueue } from 'crawlee';
import { Actor } from 'apify';

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

// Sort mapping for Google Maps internal sort parameter
const SORT_MAP = {
    newest: 1,
    highest: 3,
    lowest: 4,
    relevant: 0,
};

// Kill switch to prevent runaway costs
const killTimer = setTimeout(() => {
    log.warning(`Maximum run time of ${maxRunTimeMinutes} minutes reached. Shutting down gracefully.`);
    crawler.teardown();
}, maxRunTimeMinutes * 60 * 1000);

/**
 * Extract the place feature ID (data ID) from a Google Maps URL.
 * Google Maps URLs contain the place ID in the format: 0x...:0x...
 * or as a CID, or we can get it from the place page HTML.
 */
function extractPlaceId(url) {
    // Try to extract from URL pattern like /place/.../@lat,lng,.../data=!3m1!4b1!4m...
    // The FID is usually in the data parameter
    const fidMatch = url.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/);
    if (fidMatch) return fidMatch[1];

    // Try CID pattern
    const cidMatch = url.match(/cid=(\d+)/);
    if (cidMatch) return cidMatch[1];

    return null;
}

/**
 * Parse Google Maps internal JSON response for reviews.
 * Google Maps uses a custom protobuf-like JSON format.
 */
function parseReviewsFromResponse(responseText) {
    const reviews = [];

    try {
        // Google returns )]}' prefix then JSON array
        const cleanText = responseText.replace(/^\)\]\}'\n/, '');
        const data = JSON.parse(cleanText);

        // Navigate the nested structure to find review arrays
        // The structure varies but reviews are typically in deep nested arrays
        const reviewArrays = findReviewArrays(data);

        for (const reviewData of reviewArrays) {
            const review = extractReviewFields(reviewData);
            if (review) reviews.push(review);
        }
    } catch (err) {
        log.debug(`Failed to parse response: ${err.message}`);
    }

    return reviews;
}

/**
 * Recursively find arrays that look like review data.
 * Reviews typically have a structure with name, rating (1-5), and text.
 */
function findReviewArrays(data, depth = 0) {
    const reviews = [];
    if (depth > 15 || !data) return reviews;

    if (Array.isArray(data)) {
        // Check if this looks like a single review entry
        // Reviews typically have: [null, null, null, [null, null, reviewerName], ...]
        if (isReviewEntry(data)) {
            reviews.push(data);
            return reviews;
        }

        // Otherwise recurse into each element
        for (const item of data) {
            reviews.push(...findReviewArrays(item, depth + 1));
        }
    }

    return reviews;
}

/**
 * Heuristic to determine if an array entry looks like a review.
 * Google Maps reviews in the protobuf format have identifiable patterns.
 */
function isReviewEntry(arr) {
    if (!Array.isArray(arr) || arr.length < 4) return false;

    // A review entry typically has:
    // - A string ID at position [0]
    // - Reviewer info nested somewhere with a name string
    // - A rating integer (1-5)
    // - Review text string
    try {
        // Check for reviewer name pattern - usually arr[1] or arr[0] contains nested arrays with strings
        const hasString = arr.some(item => typeof item === 'string' && item.length > 0 && item.length < 200);
        const hasNumber = arr.some(item => typeof item === 'number' && item >= 1 && item <= 5);

        // More specific: look for the typical review structure
        // [reviewId, [authorInfo...], rating, [null, text], timestamp, ...]
        if (typeof arr[0] === 'string' && arr[0].length > 5) {
            // This might be a review ID
            if (Array.isArray(arr[1]) && hasNumber) {
                return true;
            }
        }

        return false;
    } catch {
        return false;
    }
}

/**
 * Extract structured review fields from raw review data array.
 */
function extractReviewFields(reviewData) {
    try {
        if (!Array.isArray(reviewData)) return null;

        // Navigate the known Google Maps review structure
        // This varies by endpoint version, so we use multiple extraction strategies

        let reviewerName = null;
        let rating = null;
        let reviewText = null;
        let publishedAt = null;
        let reviewerProfileUrl = null;
        let reviewerTotalReviews = null;
        let isLocalGuide = false;
        let ownerResponse = null;
        let ownerResponseDate = null;
        let reviewLikes = 0;
        let reviewPhotos = [];

        // Strategy: Walk known positions in the review protobuf
        // Position [1] typically contains author info
        if (Array.isArray(reviewData[1])) {
            const authorInfo = reviewData[1];
            // Author name is usually a string in the first few positions
            for (const item of authorInfo) {
                if (typeof item === 'string' && item.length > 0 && item.length < 100 && !item.startsWith('http')) {
                    reviewerName = item;
                    break;
                }
            }
            // Profile URL
            for (const item of authorInfo) {
                if (typeof item === 'string' && item.includes('/contrib/')) {
                    reviewerProfileUrl = item;
                    break;
                }
            }
        }

        // Rating is usually a standalone integer 1-5
        for (let i = 2; i < Math.min(reviewData.length, 8); i++) {
            if (typeof reviewData[i] === 'number' && reviewData[i] >= 1 && reviewData[i] <= 5) {
                rating = reviewData[i];
                break;
            }
        }

        // Review text - look for longer strings
        for (let i = 2; i < reviewData.length; i++) {
            if (typeof reviewData[i] === 'string' && reviewData[i].length > 10 && !reviewData[i].startsWith('http')) {
                reviewText = reviewData[i];
                break;
            }
            if (Array.isArray(reviewData[i])) {
                for (const item of reviewData[i]) {
                    if (typeof item === 'string' && item.length > 10 && !item.startsWith('http')) {
                        reviewText = item;
                        break;
                    }
                }
                if (reviewText) break;
            }
        }

        // Timestamp - look for large numbers (unix timestamps in ms)
        for (let i = 0; i < reviewData.length; i++) {
            if (typeof reviewData[i] === 'number' && reviewData[i] > 1000000000000) {
                publishedAt = new Date(reviewData[i]).toISOString();
                break;
            }
            // Also check for relative time strings like "2 months ago"
            if (typeof reviewData[i] === 'string' && reviewData[i].match(/\d+\s+(day|week|month|year|hour)s?\s+ago/i)) {
                publishedAt = reviewData[i];
            }
        }

        // Only return if we have at minimum a rating (the core data point)
        if (rating === null) return null;

        return {
            reviewerName: reviewerName || 'Anonymous',
            rating,
            reviewText: reviewText || '',
            publishedAt: publishedAt || 'Unknown',
            reviewerProfileUrl: reviewerProfileUrl || '',
            reviewerTotalReviews: reviewerTotalReviews || 0,
            isLocalGuide,
            ownerResponse: ownerResponse || '',
            ownerResponseDate: ownerResponseDate || '',
            reviewLikes,
            reviewPhotos,
        };
    } catch (err) {
        log.debug(`Failed to extract review fields: ${err.message}`);
        return null;
    }
}

/**
 * Extract place info and initial reviews from the place page HTML.
 * This is the fallback/primary approach using the rendered page data.
 */
function extractFromPlacePage($, url) {
    const placeInfo = {
        placeName: '',
        placeAddress: '',
        placeOverallRating: null,
        placeTotalReviews: null,
        placeUrl: url,
    };

    // Extract place name from title or specific elements
    placeInfo.placeName = $('h1').first().text().trim()
        || $('[data-attrid="title"]').text().trim()
        || $('title').text().replace(/ - Google Maps$/, '').trim();

    // Extract overall rating
    const ratingText = $('[class*="rating"], .fontDisplayLarge').first().text().trim();
    const ratingMatch = ratingText.match(/(\d+[.,]\d)/);
    if (ratingMatch) placeInfo.placeOverallRating = parseFloat(ratingMatch[1].replace(',', '.'));

    // Extract total review count
    const bodyText = $('body').text();
    const reviewCountMatch = bodyText.match(/([\d,]+)\s*reviews?/i);
    if (reviewCountMatch) placeInfo.placeTotalReviews = parseInt(reviewCountMatch[1].replace(/,/g, ''), 10);

    // Extract address
    const addressEl = $('[data-item-id="address"], [aria-label*="Address"]').first();
    placeInfo.placeAddress = addressEl.text().trim() || '';

    // Try to extract reviews directly from page scripts
    const reviews = [];
    $('script').each((_, el) => {
        const scriptText = $(el).html() || '';
        if (scriptText.includes('reviewerName') || scriptText.includes('reviewText') || scriptText.length > 5000) {
            // Try to find review data in window.__WEB_COMMUNITIES_CONFIG__ or similar
            const parsed = parseReviewsFromScript(scriptText);
            reviews.push(...parsed);
        }
    });

    // Also try to extract from visible review elements on the page
    $('[data-review-id], [class*="review"]').each((_, el) => {
        const reviewEl = $(el);
        const name = reviewEl.find('[class*="name"], [aria-label]').first().text().trim();
        const ratingEl = reviewEl.find('[aria-label*="star"], [class*="star"]').first();
        const ratingLabel = ratingEl.attr('aria-label') || '';
        const starMatch = ratingLabel.match(/(\d)/);
        const text = reviewEl.find('[class*="text"], [class*="body"]').first().text().trim();
        const date = reviewEl.find('[class*="date"], [class*="time"]').first().text().trim();

        if (name || text || starMatch) {
            reviews.push({
                reviewerName: name || 'Anonymous',
                rating: starMatch ? parseInt(starMatch[1], 10) : null,
                reviewText: text || '',
                publishedAt: date || '',
                reviewerProfileUrl: '',
                reviewerTotalReviews: 0,
                isLocalGuide: false,
                ownerResponse: '',
                ownerResponseDate: '',
                reviewLikes: 0,
                reviewPhotos: [],
            });
        }
    });

    return { placeInfo, reviews };
}

/**
 * Try to parse reviews from inline script content.
 */
function parseReviewsFromScript(scriptText) {
    const reviews = [];
    try {
        // Look for JSON arrays that contain review-like data
        const jsonMatches = scriptText.match(/\[(?:[^\[\]]*|\[(?:[^\[\]]*|\[[^\[\]]*\])*\])*\]/g);
        if (!jsonMatches) return reviews;

        for (const match of jsonMatches.slice(0, 5)) { // Limit to prevent over-processing
            try {
                const parsed = JSON.parse(match);
                if (Array.isArray(parsed)) {
                    const found = findReviewArrays(parsed);
                    for (const reviewData of found) {
                        const review = extractReviewFields(reviewData);
                        if (review) reviews.push(review);
                    }
                }
            } catch {
                // Not valid JSON, skip
            }
        }
    } catch {
        // Ignore parse errors
    }
    return reviews;
}

// Configure proxy
const proxyConfig = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : await Actor.createProxyConfiguration({ useApifyProxy: true, apifyProxyGroups: ['GOOGLE_SERP'] });

let totalReviewsScraped = 0;

const crawler = new CheerioCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries: 3,
    maxConcurrency: 5,
    requestHandlerTimeoutSecs: 60,
    additionalMimeTypes: ['application/json'],

    async requestHandler({ $, request, body, response }) {
        const { userData } = request;

        if (userData.type === 'place') {
            // First visit: extract place info and queue review pages
            log.info(`Processing place: ${request.url}`);

            const { placeInfo, reviews } = extractFromPlacePage($, request.url);
            log.info(`Place: "${placeInfo.placeName}" — ${placeInfo.placeTotalReviews || '?'} total reviews`);

            // Push any reviews found directly on the place page
            const filteredReviews = reviews
                .filter(r => r.rating >= minRating)
                .slice(0, maxReviewsPerPlace || Infinity)
                .map(r => ({
                    ...r,
                    ...placeInfo,
                    ownerResponse: includeOwnerResponse ? r.ownerResponse : undefined,
                    ownerResponseDate: includeOwnerResponse ? r.ownerResponseDate : undefined,
                }));

            if (filteredReviews.length > 0) {
                await Actor.pushData(filteredReviews);
                totalReviewsScraped += filteredReviews.length;
                log.info(`✅ Extracted ${filteredReviews.length} reviews from place page for "${placeInfo.placeName}"`);
            }

            // Queue the Google Maps reviews sort URL for paginated extraction
            // This uses the internal Maps API to fetch reviews sorted by our preference
            const sortParam = SORT_MAP[sortBy] ?? 1;
            const reviewsNeeded = (maxReviewsPerPlace || 100) - filteredReviews.length;

            if (reviewsNeeded > 0) {
                // Construct the reviews tab URL
                const reviewsUrl = request.url.includes('/reviews')
                    ? request.url
                    : `${request.url.replace(/\/$/, '')}/reviews`;

                await crawler.addRequests([{
                    url: reviewsUrl,
                    userData: {
                        type: 'reviews_page',
                        placeInfo,
                        sortParam,
                        reviewsCollected: filteredReviews.length,
                        maxReviews: maxReviewsPerPlace,
                    },
                }]);
            }
        } else if (userData.type === 'reviews_page') {
            // Reviews tab page - extract reviews from here
            const { placeInfo } = userData;

            log.info(`Scraping reviews page for "${placeInfo.placeName}"`);

            const reviews = [];

            // Extract from page data scripts
            $('script').each((_, el) => {
                const scriptText = $(el).html() || '';
                if (scriptText.length > 1000) {
                    const parsed = parseReviewsFromScript(scriptText);
                    reviews.push(...parsed);
                }
            });

            // Also try DOM-based extraction
            $('[data-review-id], [jscontroller][class*="review"], div[class*="review"]').each((_, el) => {
                const reviewEl = $(el);
                const name = reviewEl.find('[class*="name"], [class*="author"]').first().text().trim()
                    || reviewEl.find('a[href*="/contrib/"]').first().text().trim();

                const ratingEl = reviewEl.find('[role="img"][aria-label*="star"], [aria-label*="stars"]').first();
                const ratingLabel = ratingEl.attr('aria-label') || '';
                const starMatch = ratingLabel.match(/(\d)/);

                const text = reviewEl.find('[class*="body"], [class*="text"], [data-expandable-section]').first().text().trim();
                const date = reviewEl.find('[class*="date"], [class*="ago"], time').first().text().trim();

                // Owner response
                let ownerResp = '';
                let ownerRespDate = '';
                if (includeOwnerResponse) {
                    const respEl = reviewEl.find('[class*="owner"], [class*="response"]').first();
                    ownerResp = respEl.find('[class*="text"], [class*="body"]').text().trim() || respEl.text().trim();
                    ownerRespDate = respEl.find('[class*="date"], time').text().trim();
                }

                // Local guide badge
                const isLocal = reviewEl.text().toLowerCase().includes('local guide');

                // Photos
                const photos = [];
                reviewEl.find('img[src*="googleusercontent"], img[src*="lh3"]').each((_, img) => {
                    const src = $(img).attr('src');
                    if (src && !src.includes('profile')) photos.push(src);
                });

                if (name || text || starMatch) {
                    reviews.push({
                        reviewerName: name || 'Anonymous',
                        rating: starMatch ? parseInt(starMatch[1], 10) : null,
                        reviewText: text || '',
                        publishedAt: date || '',
                        reviewerProfileUrl: '',
                        reviewerTotalReviews: 0,
                        isLocalGuide: isLocal,
                        ownerResponse: includeOwnerResponse ? ownerResp : undefined,
                        ownerResponseDate: includeOwnerResponse ? ownerRespDate : undefined,
                        reviewLikes: 0,
                        reviewPhotos: photos,
                    });
                }
            });

            // Filter and push
            const maxRemaining = (userData.maxReviews || 100) - (userData.reviewsCollected || 0);
            const filteredReviews = reviews
                .filter(r => r.rating === null || r.rating >= minRating)
                .slice(0, maxRemaining)
                .map(r => ({ ...r, ...placeInfo }));

            if (filteredReviews.length > 0) {
                await Actor.pushData(filteredReviews);
                totalReviewsScraped += filteredReviews.length;
                log.info(`✅ Extracted ${filteredReviews.length} reviews from reviews page for "${placeInfo.placeName}"`);
            } else {
                log.warning(`⚠️ No reviews extracted from reviews page for "${placeInfo.placeName}". Google Maps may require browser rendering for this page.`);
            }
        }
    },

    async failedRequestHandler({ request }, error) {
        log.error(`Request failed: ${request.url} — ${error.message}`);
    },
});

// Build initial request list from place URLs
const requests = placeUrls.map(url => {
    // Normalize Google Maps URLs
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http')) {
        normalizedUrl = `https://www.google.com/maps/place/${encodeURIComponent(normalizedUrl)}`;
    }

    return {
        url: normalizedUrl,
        userData: { type: 'place' },
        headers: {
            'Accept-Language': language || 'en',
        },
    };
});

log.info(`Starting Google Maps Reviews Scraper...`);
log.info(`Places to process: ${requests.length}`);
log.info(`Max reviews per place: ${maxReviewsPerPlace || 'unlimited'}`);
log.info(`Sort by: ${sortBy}`);

await crawler.run(requests);

clearTimeout(killTimer);

log.info(`🎉 Scraping complete. Total reviews extracted: ${totalReviewsScraped}`);
await Actor.exit({ statusMessage: `Extracted ${totalReviewsScraped} reviews from ${placeUrls.length} place(s)` });
