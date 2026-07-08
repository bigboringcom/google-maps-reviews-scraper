# Google Maps Reviews Scraper

Extract reviews from any Google Maps business listing at scale. Get reviewer name, star rating, full review text, publication date, owner responses, and more.

**Pay only $0.003 per review** — no per-place fees, no hidden costs.

## What does Google Maps Reviews Scraper do?

This Actor extracts customer reviews from Google Maps business listings. Unlike full Google Maps scrapers that charge per place AND per review, this Actor focuses exclusively on reviews with simple pay-per-result pricing.

Use it to:
- Monitor your business reputation across locations
- Analyze competitor reviews for market intelligence
- Build datasets for sentiment analysis and NLP research
- Track review trends over time
- Identify common customer complaints or praise

## Why use this over other Google Maps scrapers?

| Feature | This Actor | Competitors |
|---------|-----------|-------------|
| Pricing model | $0.003/review (flat) | $0.003/place + $0.0005/review + add-ons |
| Focus | Reviews only (fast) | Full place data (slower) |
| Owner responses | Included free | Paid add-on |
| Sort options | 4 sort modes | Limited |
| Min complexity | Just paste URLs | Complex config |

## Input

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `placeUrls` | Array | Google Maps place URLs to scrape | Required |
| `maxReviewsPerPlace` | Integer | Max reviews per place (0 = unlimited) | 100 |
| `sortBy` | String | Sort: newest, highest, lowest, relevant | newest |
| `language` | String | Language code (en, es, fr, de, etc.) | en |
| `includeOwnerResponse` | Boolean | Include owner replies | true |
| `minRating` | Integer | Only reviews with this rating or higher (1-5) | 1 |
| `maxRunTimeMinutes` | Integer | Auto-stop after N minutes | 10 |
| `proxyConfiguration` | Object | Proxy settings | Apify GOOGLE_SERP |

### Example input

```json
{
    "placeUrls": [
        "https://www.google.com/maps/place/Sydney+Opera+House",
        "https://www.google.com/maps/place/Melbourne+Cricket+Ground"
    ],
    "maxReviewsPerPlace": 50,
    "sortBy": "newest",
    "language": "en",
    "includeOwnerResponse": true,
    "minRating": 1
}
```

## Output

Each review is a JSON object with these fields:

```json
{
    "reviewerName": "John Smith",
    "rating": 5,
    "reviewText": "Amazing experience! The architecture is breathtaking and the tours are very informative.",
    "publishedAt": "2 weeks ago",
    "reviewerProfileUrl": "https://www.google.com/maps/contrib/12345",
    "reviewerTotalReviews": 42,
    "isLocalGuide": true,
    "ownerResponse": "Thank you for your kind words, John! We're glad you enjoyed the tour.",
    "ownerResponseDate": "1 week ago",
    "reviewLikes": 3,
    "reviewPhotos": ["https://lh3.googleusercontent.com/..."],
    "placeName": "Sydney Opera House",
    "placeAddress": "Bennelong Point, Sydney NSW 2000, Australia",
    "placeOverallRating": 4.7,
    "placeTotalReviews": 48521,
    "placeUrl": "https://www.google.com/maps/place/Sydney+Opera+House"
}
```

## Pricing

This Actor uses **Pay Per Result** pricing at **$0.003 per review** extracted.

Example costs:
- 100 reviews from 1 place = **$0.30**
- 1,000 reviews from 10 places = **$3.00**
- 10,000 reviews from 100 places = **$30.00**

No per-place fees. No add-on charges for owner responses. What you see is what you pay.

## Tips for best results

1. **Use full Google Maps URLs** — copy the URL directly from your browser when viewing the business on Google Maps.
2. **Start with fewer reviews** — test with `maxReviewsPerPlace: 10` first to verify the output format meets your needs.
3. **Filter by rating** — use `minRating` to focus on negative reviews (set to 1-2) for reputation monitoring, or positive reviews (4-5) for testimonial collection.
4. **Sort by newest** — default sort gives you the most recent reviews, ideal for monitoring.

## Limitations

- Google Maps dynamically loads reviews, so very large review volumes (10,000+) per place may take longer.
- Some places may have limited review data available depending on Google's rendering.
- Review text in languages other than the specified `language` parameter may still appear if the reviewer wrote in a different language.

## Support

For questions or issues, contact us through the Apify Store or open an issue on GitHub.
