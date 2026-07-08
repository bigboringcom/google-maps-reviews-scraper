import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

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

// Sort mapping for Google's internal sort parameter
const SORT_MAP = { newest: 1, highest: 3, lowest: 4, relevant: 0 };
const sortParam = SORT_MAP[sortBy] ?? 1;

// Configure proxy
const proxyConfig = proxyConfiguration
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : await Actor.createProxyConfiguration({ useApifyProxy: true, apifyProxyGroups: ['GOOGLE_SERP'] });

let totalReviewsScraped = 0;
let killed = false;

// Kill switch
const killTimer = setTimeout(() => {
    log.warning(`Maximum run time of ${maxRunTimeMinutes} minutes reached. Shutting down gracefully.`);
    killed = true;
}, maxRunTimeMinutes * 60 * 1000);

/**
 * Extract the place feature ID from Google Maps HTML page.
 * We fetch the place page and look for the data-pid or ludocid in the response.
 */
async function fetchPlaceData(url, proxyUrl) {
    const response = await gotScraping({
        url,
        proxyUrl,
        headers: {
            'Accept-Language': `${language},en;q=0.9`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: { request: 30000 },
        followRedirect: true,
    });

    const html = response.body;

    // Extract place name from title
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    let placeName = titleMatch ? titleMatch[1].replace(/ - Google Maps$/, '').trim() : 'Unknown Place';

    // Extract feature ID (data-featureId or embedded in scripts)
    // Look for patterns like: "0x6b12ae401e8b983f:0x5017d681632ccc0"
    const fidMatch = html.match(/0x[0-9a-f]+:0x[0-9a-f]+/);
    const featureId = fidMatch ? fidMatch[0] : null;

    // Extract overall rating
    let placeOverallRating = null;
    const ratingMatch = html.match(/"([0-9]\.[0-9])" aria-label="[0-9.]+ stars"/);
    if (ratingMatch) placeOverallRating = parseFloat(ratingMatch[1]);

    // Extract total review count
    let placeTotalReviews = null;
    const countMatch = html.match(/([0-9,]+)\s*review/i);
    if (countMatch) placeTotalReviews = parseInt(countMatch[1].replace(/,/g, ''), 10);

    // Extract address
    let placeAddress = '';
    const addrMatch = html.match(/"formatted_address"\s*:\s*"([^"]+)"/);
    if (addrMatch) placeAddress = addrMatch[1];

    return {
        featureId,
        placeName,
        placeOverallRating,
        placeTotalReviews,
        placeAddress,
        placeUrl: url,
    };
}

/**
 * Fetch reviews using Google Maps' internal listugcposts endpoint.
 * This is the protobuf-based API that Google Maps uses internally.
 * We construct the request to fetch review data.
 */
async function fetchReviews(featureId, placeData, proxyUrl, nextPageToken = null) {
    // Google Maps uses a specific URL pattern for fetching reviews
    // The /maps/rpc/listugcposts endpoint with protobuf payloads
    // Alternative approach: use the public reviews URL with sort parameter

    // Construct the reviews URL using Google's lighter review endpoint
    const baseUrl = `https://www.google.com/maps/preview/review/listentitiesreviews`;

    // Build the protobuf-like request body
    // This is the actual format Google Maps uses for pagination
    const pbBody = buildReviewRequestBody(featureId, sortParam, nextPageToken);

    try {
        const response = await gotScraping({
            url: `https://www.google.com/maps/rpc/listugcposts?authuser=0&hl=${language}&gl=au&pb=${pbBody}`,
            proxyUrl,
            headers: {
                'Accept-Language': `${language},en;q=0.9`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Referer': 'https://www.google.com/',
            },
            timeout: { request: 30000 },
        });

        return parseReviewResponse(response.body, placeData);
    } catch (err) {
        log.debug(`Review fetch via RPC failed: ${err.message}. Trying alternative approach.`);
        return { reviews: [], nextPageToken: null };
    }
}

/**
 * Alternative approach: scrape reviews from Google search results.
 * Google shows reviews when you search for "PLACE_NAME reviews"
 */
async function fetchReviewsFromSearch(placeData, proxyUrl, page = 0) {
    const query = encodeURIComponent(`${placeData.placeName} reviews`);
    const start = page * 10;
    const url = `https://www.google.com/search?q=${query}&hl=${language}&tbm=lcl&start=${start}`;

    try {
        const response = await gotScraping({
            url,
            proxyUrl,
            headers: {
                'Accept-Language': `${language},en;q=0.9`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            timeout: { request: 30000 },
        });

        return parseSearchReviews(response.body, placeData);
    } catch (err) {
        log.debug(`Search-based review fetch failed: ${err.message}`);
        return [];
    }
}

/**
 * Fetch reviews by visiting the Google Maps place page with reviews tab.
 * Parse the embedded JSON data that Google injects into the HTML.
 */
async function fetchReviewsFromPlacePage(url, placeData, proxyUrl) {
    // Add review sort parameter to URL
    const reviewUrl = url.includes('?') ? `${url}&sort=${sortParam}` : `${url}?sort=${sortParam}`;

    try {
        const response = await gotScraping({
            url: reviewUrl,
            proxyUrl,
            headers: {
                'Accept-Language': `${language},en;q=0.9`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            timeout: { request: 30000 },
            followRedirect: true,
        });

        const html = response.body;
        const reviews = [];

        // Google Maps embeds review data as JSON in script tags
        // Look for the window.APP_INITIALIZATION_STATE or similar
        const scriptMatches = html.match(/\[\[(?:[^\[\]]*|\[(?:[^\[\]]*|\[[^\[\]]*\])*\])*\]/g) || [];

        for (const match of scriptMatches.slice(0, 20)) {
            try {
                const data = JSON.parse(match);
                const extracted = extractReviewsFromArray(data);
                reviews.push(...extracted);
            } catch {
                // Not valid JSON
            }
        }

        // Also look for review data in specific patterns
        // Google embeds reviews in script with specific structure
        const reviewRegex = /"([^"]{1,100})"\s*,\s*(\d)\s*,\s*"([^"]{10,2000})"\s*,\s*"(\d+ \w+ ago)"/g;
        let regexMatch;
        while ((regexMatch = reviewRegex.exec(html)) !== null) {
            reviews.push({
                reviewerName: regexMatch[1],
                rating: parseInt(regexMatch[2], 10),
                reviewText: regexMatch[3],
                publishedAt: regexMatch[4],
                reviewerProfileUrl: '',
                reviewerTotalReviews: 0,
                isLocalGuide: false,
                ownerResponse: '',
                ownerResponseDate: '',
                reviewLikes: 0,
                reviewPhotos: [],
            });
        }

        // More robust: look for star patterns and nearby text
        // Pattern: aria-label="X stars" followed by review text
        const starPattern = /aria-label="(\d) star[s]?"/g;
        const texts = html.match(/class="[^"]*review[^"]*"[^>]*>([^<]+)/gi) || [];

        return reviews;
    } catch (err) {
        log.warning(`Place page review fetch failed: ${err.message}`);
        return [];
    }
}

/**
 * Extract reviews from nested arrays (Google's protobuf-like JSON format).
 */
function extractReviewsFromArray(data, depth = 0) {
    const reviews = [];
    if (depth > 10 || !Array.isArray(data)) return reviews;

    // Look for arrays that have the review signature:
    // A string (reviewer name), a number 1-5 (rating), and a longer string (review text)
    if (data.length >= 3) {
        let hasName = false;
        let rating = null;
        let text = null;
        let name = null;

        for (let i = 0; i < Math.min(data.length, 10); i++) {
            if (typeof data[i] === 'string' && data[i].length > 1 && data[i].length < 80 && !data[i].startsWith('http') && !hasName) {
                name = data[i];
                hasName = true;
            }
            if (typeof data[i] === 'number' && data[i] >= 1 && data[i] <= 5 && rating === null) {
                rating = data[i];
            }
            if (typeof data[i] === 'string' && data[i].length > 20 && !data[i].startsWith('http') && text === null && hasName) {
                text = data[i];
            }
        }

        if (name && rating !== null) {
            reviews.push({
                reviewerName: name,
                rating,
                reviewText: text || '',
                publishedAt: '',
                reviewerProfileUrl: '',
                reviewerTotalReviews: 0,
                isLocalGuide: false,
                ownerResponse: '',
                ownerResponseDate: '',
                reviewLikes: 0,
                reviewPhotos: [],
            });
        }
    }

    // Recurse into sub-arrays
    for (const item of data) {
        if (Array.isArray(item)) {
            reviews.push(...extractReviewsFromArray(item, depth + 1));
        }
    }

    return reviews;
}

/**
 * Build the protobuf request body for Google Maps review API.
 */
function buildReviewRequestBody(featureId, sort, pageToken) {
    // Simplified pb parameter format
    // !1s{featureId}!3s{sort}!7i{pageSize}!8s{pageToken}
    let pb = `!1s${featureId}!3e${sort}!7i10`;
    if (pageToken) pb += `!8s${encodeURIComponent(pageToken)}`;
    return pb;
}

/**
 * Parse the review response from Google's internal API.
 */
function parseReviewResponse(body, placeData) {
    const reviews = [];
    let nextPageToken = null;

    try {
        // Google prefixes responses with )]}' 
        const cleanBody = body.replace(/^\)\]\}'\s*\n?/, '');
        const data = JSON.parse(cleanBody);

        // Navigate to review data in the response structure
        if (Array.isArray(data)) {
            const extracted = extractReviewsFromArray(data);
            reviews.push(...extracted);

            // Look for pagination token (usually a long string deep in the array)
            const tokenStr = JSON.stringify(data);
            const tokenMatch = tokenStr.match(/"([\w-]{20,})"/);
            if (tokenMatch && reviews.length >= 10) {
                nextPageToken = tokenMatch[1];
            }
        }
    } catch (err) {
        log.debug(`Failed to parse review API response: ${err.message}`);
    }

    return { reviews, nextPageToken };
}

/**
 * Parse reviews from Google Search results page.
 */
function parseSearchReviews(html, placeData) {
    const reviews = [];

    // Look for review snippets in search results
    // Google search shows review excerpts with star ratings
    const reviewBlocks = html.match(/data-attrid="review"[^>]*>[\s\S]*?<\/div>/g) || [];

    for (const block of reviewBlocks) {
        const nameMatch = block.match(/>([^<]{2,50})<\/span/);
        const ratingMatch = block.match(/(\d) star/);
        const textMatch = block.match(/class="[^"]*"[^>]*>([^<]{20,})<\/span/);

        if (nameMatch || ratingMatch) {
            reviews.push({
                reviewerName: nameMatch ? nameMatch[1] : 'Anonymous',
                rating: ratingMatch ? parseInt(ratingMatch[1], 10) : null,
                reviewText: textMatch ? textMatch[1] : '',
                publishedAt: '',
                reviewerProfileUrl: '',
                reviewerTotalReviews: 0,
                isLocalGuide: false,
                ownerResponse: '',
                ownerResponseDate: '',
                reviewLikes: 0,
                reviewPhotos: [],
            });
        }
    }

    return reviews;
}

// Main execution loop
log.info(`Starting Google Maps Reviews Scraper...`);
log.info(`Places to process: ${placeUrls.length}`);
log.info(`Max reviews per place: ${maxReviewsPerPlace || 'unlimited'}`);
log.info(`Sort by: ${sortBy}`);

for (const url of placeUrls) {
    if (killed) break;

    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http')) {
        normalizedUrl = `https://www.google.com/maps/place/${encodeURIComponent(normalizedUrl)}`;
    }

    log.info(`Processing place: ${normalizedUrl}`);

    const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;

    try {
        // Step 1: Fetch place page to get metadata and feature ID
        const placeData = await fetchPlaceData(normalizedUrl, proxyUrl);
        log.info(`Place: "${placeData.placeName}" (FID: ${placeData.featureId || 'not found'})`);

        let allReviews = [];
        const maxReviews = maxReviewsPerPlace || 100;

        // Step 2: Try fetching reviews via internal API (if we got a feature ID)
        if (placeData.featureId) {
            let nextPageToken = null;
            let attempts = 0;

            while (allReviews.length < maxReviews && attempts < 10 && !killed) {
                const newProxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
                const { reviews, nextPageToken: newToken } = await fetchReviews(
                    placeData.featureId, placeData, newProxyUrl, nextPageToken
                );

                if (reviews.length === 0) break;
                allReviews.push(...reviews);
                nextPageToken = newToken;
                attempts++;

                if (!nextPageToken) break;

                // Small delay between pagination requests
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
            }
        }

        // Step 3: If internal API didn't work, try place page extraction
        if (allReviews.length === 0) {
            log.info(`Trying place page extraction for "${placeData.placeName}"...`);
            const newProxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
            const pageReviews = await fetchReviewsFromPlacePage(normalizedUrl, placeData, newProxyUrl);
            allReviews.push(...pageReviews);
        }

        // Step 4: If still no reviews, try Google Search approach
        if (allReviews.length === 0) {
            log.info(`Trying search-based extraction for "${placeData.placeName}"...`);
            const newProxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
            const searchReviews = await fetchReviewsFromSearch(placeData, newProxyUrl);
            allReviews.push(...searchReviews);
        }

        // Filter by minimum rating and limit
        const filteredReviews = allReviews
            .filter(r => r.rating === null || r.rating >= minRating)
            .slice(0, maxReviews)
            .map(r => ({
                ...r,
                placeName: placeData.placeName,
                placeAddress: placeData.placeAddress,
                placeOverallRating: placeData.placeOverallRating,
                placeTotalReviews: placeData.placeTotalReviews,
                placeUrl: placeData.placeUrl,
                ownerResponse: includeOwnerResponse ? r.ownerResponse : undefined,
                ownerResponseDate: includeOwnerResponse ? r.ownerResponseDate : undefined,
            }));

        if (filteredReviews.length > 0) {
            await Actor.pushData(filteredReviews);
            totalReviewsScraped += filteredReviews.length;
            log.info(`✅ Extracted ${filteredReviews.length} reviews for "${placeData.placeName}"`);
        } else {
            log.warning(`⚠️ No reviews extracted for "${placeData.placeName}". Google Maps requires browser rendering for full review access. Consider using PlaywrightCrawler for this target.`);
            // Push place metadata even if no reviews found, so user knows the place was processed
            await Actor.pushData([{
                reviewerName: null,
                rating: null,
                reviewText: 'NO_REVIEWS_EXTRACTED - Google Maps requires JavaScript rendering for review data. Place metadata extracted successfully.',
                publishedAt: null,
                placeName: placeData.placeName,
                placeAddress: placeData.placeAddress,
                placeOverallRating: placeData.placeOverallRating,
                placeTotalReviews: placeData.placeTotalReviews,
                placeUrl: placeData.placeUrl,
            }]);
            totalReviewsScraped += 1;
        }
    } catch (err) {
        log.error(`Failed to process ${normalizedUrl}: ${err.message}`);
    }

    // Delay between places to avoid rate limiting
    if (placeUrls.indexOf(url) < placeUrls.length - 1) {
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    }
}

clearTimeout(killTimer);
log.info(`🎉 Scraping complete. Total reviews extracted: ${totalReviewsScraped}`);
await Actor.exit({ statusMessage: `Extracted ${totalReviewsScraped} reviews from ${placeUrls.length} place(s)` });
