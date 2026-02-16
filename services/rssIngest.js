import Parser from "rss-parser";
import crypto from "crypto";

console.log("🔥 RSS INGEST SERVICE FILE LOADED 🔥");

const parser = new Parser();

/* ===========================
   ROBUST FEED SET (~25)
   (high quality, stable)
=========================== */
const FEEDS = [
  // BBC
  { name: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "BBC UK", url: "http://feeds.bbci.co.uk/news/uk/rss.xml" },
  { name: "BBC Business", url: "http://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "BBC Technology", url: "http://feeds.bbci.co.uk/news/technology/rss.xml" },

  // Reuters Best (Agency feeds)
  { name: "Reuters World", url: "https://www.reutersagency.com/feed/?best-topics=world&post_type=best" },
  { name: "Reuters Business", url: "https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best" },

  // DW
  { name: "DW Top", url: "https://rss.dw.com/rdf/rss-en-top" },
  { name: "DW World", url: "https://rss.dw.com/rdf/rss-en-world" },

  // Middle East / International
  { name: "Al Jazeera (All)", url: "https://www.aljazeera.com/xml/rss/all.xml" },

  // UK / Global publishers
  { name: "Sky News World", url: "https://feeds.skynews.com/feeds/rss/world.xml" },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss" },
  { name: "The Guardian Business", url: "https://www.theguardian.com/business/rss" },
  { name: "The Guardian Technology", url: "https://www.theguardian.com/uk/technology/rss" },

  // US major
  { name: "CNN Top Stories", url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
  { name: "NBC Top Stories", url: "http://feeds.nbcnews.com/feeds/topstories" },
  { name: "ABC News Top Stories", url: "http://feeds.abcnews.com/abcnews/topstories" },

  // NYT
  { name: "NYT World", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { name: "NYT Technology", url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml" },

  // NPR
  { name: "NPR World", url: "https://feeds.npr.org/1004/rss.xml" },

  // Tech
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "WIRED", url: "https://www.wired.com/rss/" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },

  // Science / Space (NASA)
  { name: "NASA Recently Published", url: "https://www.nasa.gov/feed/" },
  { name: "NASA News Releases", url: "https://www.nasa.gov/news-release/feed/" }
];

/**
 * Infer a coarse category from headline text
 */
function inferCategory(headline = "") {
  const text = headline.toLowerCase();

  if (/(ukraine|russia|nato|israel|gaza)/.test(text)) return "geopolitics";
  if (/(election|pm|president|minister)/.test(text)) return "politics";
  if (/(court|trial|sentence|arrested)/.test(text)) return "law";
  if (/(storm|flood|earthquake|landslide|fire)/.test(text)) return "disaster";
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
  if (isNaN(published)) return 0;

  const now = Date.now();
  const diffMinutes = (now - published) / (1000 * 60);

  if (diffMinutes <= 60) return 25;   // 1 hour
  if (diffMinutes <= 180) return 15;  // 3 hours
  if (diffMinutes <= 360) return 10;  // 6 hours

  return 0;
}

/**
 * Deterministic explainable scoring
 */
function computeInitialScore(headline = "", category = "", pubDate = null) {
  const text = headline.toLowerCase();
  let score = 0;

  // Violence / urgency
  if (/(kill|killed|dies|dead|attack|explosion|arrest)/.test(text)) {
    score += 30;
  }

  // Geopolitics
  if (/(ukraine|russia|china|israel|gaza|nato|iran)/.test(text)) {
    score += 20;
  }

  // Disasters
  if (/(storm|flood|landslide|earthquake|fire)/.test(text)) {
    score += 10;
  }

  // Category boost (non generic world)
  if (category && category !== "world") {
    score += 10;
  }

  // Time boost
  score += computeTimeBoost(pubDate);

  return score;
}

/* ===========================
   INTERNAL: INGEST ONE FEED
=========================== */
async function ingestOneFeed(pool, feedConfig) {
  const feed = await parser.parseURL(feedConfig.url);

  let inserted = 0;
  let skipped = 0;

  for (const item of feed.items.slice(0, 15)) {
    const headline = item.title?.trim();
    const summary = item.contentSnippet || "";
    const sourceUrl = item.link;
    const pubDate = item.pubDate || item.isoDate || null;

    if (!headline || !sourceUrl) {
      skipped++;
      continue;
    }

    const category = inferCategory(headline);
    const initialScore = computeInitialScore(headline, category, pubDate);

    // 🔥 STATUS TIERS
    let status = "new";

    if (initialScore >= 70) {
      status = "breaking";
    } else if (initialScore >= 55) {
      status = "published";
    } else if (initialScore >= 40) {
      status = "background";
    } else if (initialScore < 25) {
      status = "ignored";
    }

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
          feedConfig.name,
          sourceUrl,
          category,
          "rss",
          status,
          initialScore,
          contentHash,
          pubDate ? new Date(pubDate) : null
        ]
      );

      if (result.rowCount === 0) skipped++;
      else inserted++;
    } catch (err) {
      console.error(`❌ RSS insert failed (${feedConfig.name}):`, err.message);
      skipped++;
    }
  }

  return { inserted, skipped };
}

/**
 * ✅ NEW: Ingest ALL FEEDS (robust mode)
 */
export async function ingestAllFeeds(pool) {
  let inserted = 0;
  let skipped = 0;

  for (const feedConfig of FEEDS) {
    console.log(`🌍 Processing: ${feedConfig.name}`);

    try {
      const res = await ingestOneFeed(pool, feedConfig);
      inserted += res.inserted;
      skipped += res.skipped;
      console.log(`✅ Done: ${feedConfig.name} | inserted=${res.inserted} skipped=${res.skipped}`);
    } catch (err) {
      console.log(`⚠️ Failed feed: ${feedConfig.name} | ${err.message}`);
    }
  }

  return { inserted, skipped, feeds: FEEDS.length };
}

/**
 * ✅ BACKWARD COMPAT: your old function still works
 * (only BBC World)
 */
export async function ingestBBCWorldRSS(pool) {
  const BBC_WORLD_RSS = "http://feeds.bbci.co.uk/news/world/rss.xml";
  return ingestOneFeed(pool, { name: "BBC World", url: BBC_WORLD_RSS });
}
