import Parser from "rss-parser";
import crypto from "crypto";

console.log("🔥 RSS INGEST SERVICE FILE LOADED 🔥");

const parser = new Parser();
const BBC_WORLD_RSS = "http://feeds.bbci.co.uk/news/world/rss.xml";

/**
 * Infer a coarse category from headline text
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
 * Time-based breaking boost
 */
function computeTimeBoost(pubDate) {
  if (!pubDate) return 0;

  const published = new Date(pubDate).getTime();
  const now = Date.now();
  const diffMinutes = (now - published) / (1000 * 60);

  if (diffMinutes <= 60) return 25;      // within 1 hour
  if (diffMinutes <= 180) return 15;     // within 3 hours
  if (diffMinutes <= 360) return 10;     // within 6 hours

  return 0;
}

/**
 * Deterministic explainable scoring
 */
function computeInitialScore(headline = "", category = "", pubDate = null) {
  console.log("🧮 SCORING:", headline);

  const text = headline.toLowerCase();
  let score = 0;

  // Breaking / violence / urgency
  if (/(kill|dies|dead|attack|explosion|arrest)/.test(text)) score += 30;

  // Geopolitics
  if (/(ukraine|russia|china|israel|gaza|nato)/.test(text)) score += 20;

  // Disasters
  if (/(storm|flood|landslide|earthquake|fire)/.test(text)) score += 10;

  // Novelty boost for non-world
  if (category && category !== "world") score += 10;

  // 🔥 Time-based breaking boost
  score += computeTimeBoost(pubDate);

  console.log("➡ Final score:", score);

  return score;
}

/**
 * Ingest BBC World RSS into candidates table
 */
export async function ingestBBCWorldRSS(pool) {
  const feed = await parser.parseURL(BBC_WORLD_RSS);

  let inserted = 0;
  let skipped = 0;

  for (const item of feed.items.slice(0, 10)) {
    const headline = item.title?.trim();
    const summary = item.contentSnippet || "";
    const sourceUrl = item.link;
    const pubDate = item.pubDate || item.isoDate || null;

    if (!headline || !sourceUrl) {
      skipped++;
      continue;
    }

    // 1️⃣ Infer category
    const category = inferCategory(headline);

    // 2️⃣ Compute score (includes time boost)
    const initialScore = computeInitialScore(headline, category, pubDate);

    // 3️⃣ Decide status
    let status = "new";
    if (initialScore >= 55) status = "queued";
    else if (initialScore < 25) status = "ignored";

    // 4️⃣ Deduplication
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
          source_name,
          source_url,
          category,
          source_platform,
          status,
          initial_score,
          content_hash,
          published_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (content_hash) DO NOTHING
        `,
        [
          headline,
          summary,
          "BBC News",
          sourceUrl,
          category,
          "rss",
          status,
          initialScore,
          contentHash,
          pubDate
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
