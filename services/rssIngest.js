import Parser from "rss-parser";
import crypto from "crypto";

/**
 * Infer a coarse news category from the headline
 */
function inferCategory(headline = "") {
  const text = headline.toLowerCase();

  if (/(ukraine|russia|nato|israel|gaza)/.test(text)) return "geopolitics";
  if (/(election|pm|president|minister)/.test(text)) return "politics";
  if (/(court|trial|sentence|arrested)/.test(text)) return "law";
  if (/(storm|flood|earthquake|landslide)/.test(text)) return "disaster";
  if (/(tech|ai|data|cyber)/.test(text)) return "technology";
  if (/(inflation|economy|markets|trade)/.test(text)) return "economy";

  return "world";
}

/**
 * Calculate deterministic initial score (0–100)
 */
function calculateInitialScore({ category, publishedAt, headline }) {
  let score = 0;

  // Rule 1 — Breaking boost (last 2 hours)
  if (publishedAt) {
    const ageMinutes =
      (Date.now() - new Date(publishedAt).getTime()) / 60000;
    if (ageMinutes <= 120) score += 30;
  }

  // Rule 2 — Serious category boost
  if (["world", "politics", "courts", "security", "science"].includes(category)) {
    score += 20;
  }

  // Rule 3 — Opinion penalty
  if (/opinion|analysis|comment/i.test(headline)) {
    score -= 30;
  }

  // Rule 4 — Sensationalism penalty
  if (/shocking|you won’t believe|blow your mind/i.test(headline)) {
    score -= 40;
  }

  return Math.max(0, Math.min(100, score));
}

const parser = new Parser();
const BBC_WORLD_RSS = "http://feeds.bbci.co.uk/news/world/rss.xml";

/**
 * Ingest BBC World RSS into candidates
 */
export async function ingestBBCWorldRSS(pool) {
  const feed = await parser.parseURL(BBC_WORLD_RSS);

  let inserted = 0;
  let skipped = 0;

  for (const item of feed.items.slice(0, 10)) {
    const headline = item.title?.trim();
    const summary = item.contentSnippet || "";
    const sourceUrl = item.link;
    const publishedAt = item.pubDate || null;

    if (!headline || !sourceUrl) {
      skipped++;
      continue;
    }

    // ✅ Step 3 — Infer category
    const category = inferCategory(headline);

    // Optional scoring (already in your pipeline)
    const initialScore = calculateInitialScore({
      category,
      publishedAt,
      headline
    });

    // Decide status at insert time
    const status = initialScore >= 50 ? "queued" : "new";

    const contentHash = crypto
      .createHash("sha256")
      .update(headline + sourceUrl)
      .digest("hex");

    try {
      const result = await pool.query(
        `
        INSERT INTO candidates (
          headline,
          summary,
          source_platform,
          source_name,
          source_url,
          category,
          source_tier,
          status,
          published_at,
          content_hash,
          initial_score
        )
        VALUES (
          $1,
          $2,
          'rss',
          'BBC News',
          $3,
          $4,
          1,
          $5,
          $6,
          $7,
          $8
        )
        ON CONFLICT (content_hash) DO NOTHING
        `,
        [
          headline,
          summary,
          sourceUrl,
          category,
          status,
          publishedAt,
          contentHash,
          initialScore
        ]
      );

      if (result.rowCount === 0) skipped++;
      else inserted++;
    } catch (err) {
      console.error("RSS insert failed:", err.message);
      skipped++;
    }
  }

  return { inserted, skipped };
}
