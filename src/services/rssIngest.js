import Parser from "rss-parser";
import crypto from "crypto";

/**
 * RSS ingestion service
 * - Pulls BBC World RSS
 * - Stores items as candidates
 * - Skips duplicates via content_hash
 */

const parser = new Parser();

const BBC_WORLD_RSS = "http://feeds.bbci.co.uk/news/world/rss.xml";

export async function ingestBBCWorldRSS(pool) {
  const feed = await parser.parseURL(BBC_WORLD_RSS);

  let inserted = 0;
  let skipped = 0;

  for (const item of feed.items.slice(0, 10)) {
    const headline = item.title?.trim();
    const summary = item.contentSnippet || "";
    const sourceUrl = item.link;

    if (!headline || !sourceUrl) {
      skipped++;
      continue;
    }

    // Create deterministic hash (deduplication)
    const hash = crypto
      .createHash("sha256")
      .update(headline + sourceUrl)
      .digest("hex");

    try {
      await pool.query(
        `
        INSERT INTO candidates
          (headline, summary, source_platform, source_name, source_url, content_hash, status)
        VALUES
          ($1, $2, 'rss', 'BBC News', $3, $4, 'new')
        ON CONFLICT (content_hash) DO NOTHING
        `,
        [headline, summary, sourceUrl, hash]
      );

      inserted++;
    } catch (err) {
      console.error("RSS insert failed:", err.message);
      skipped++;
    }
  }

  return { inserted, skipped };
}
