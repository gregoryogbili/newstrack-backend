import Parser from "rss-parser";
import crypto from "crypto";

console.log("🔥 RSS INGEST SERVICE FILE LOADED 🔥");

const parser = new Parser({
  requestOptions: {
    headers: {
      "User-Agent": "NewsTracBot/1.0 (+https://newstrac.org)"
    }
  }
});

/* ===========================
   SIGNAL FEEDS (Reddit Only)
   Separate from journalism feeds
=========================== */
const SIGNAL_FEEDS = [
  { name: "Reddit WorldNews", url: "https://www.reddit.com/r/worldnews/.rss", platform: "reddit" },
  { name: "Reddit Economics", url: "https://www.reddit.com/r/economics/.rss", platform: "reddit" },
  { name: "Reddit Technology", url: "https://www.reddit.com/r/technology/.rss", platform: "reddit" }
];

/* ===========================
   ROBUST FEED SET (~25)
   (high quality, stable)
=========================== */
const FEEDS = [

  /* =====================================================
     🌍 CORE GLOBAL BACKBONE (High Credibility / Wire)
  ===================================================== */

  { name: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "BBC UK", url: "http://feeds.bbci.co.uk/news/uk/rss.xml" },
  { name: "Reuters World", url: "https://www.reutersagency.com/feed/?best-topics=world&post_type=best" },
  { name: "Reuters Business", url: "https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best" },
  { name: "Associated Press", url: "https://apnews.com/rss" },
  { name: "DW Top", url: "https://rss.dw.com/rdf/rss-en-top" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },

  /* =====================================================
     🇺🇸 UNITED STATES
  ===================================================== */

  { name: "CNN Top Stories", url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
  { name: "NBC Top Stories", url: "http://feeds.nbcnews.com/feeds/topstories" },
  { name: "ABC News Top Stories", url: "http://feeds.abcnews.com/abcnews/topstories" },
  { name: "NYT World", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { name: "NYT Technology", url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml" },
  { name: "Washington Post World", url: "https://feeds.washingtonpost.com/rss/world" },
  { name: "Politico US", url: "https://www.politico.com/rss/politics08.xml" },
  { name: "Axios", url: "https://api.axios.com/feed/" },
  { name: "NPR World", url: "https://feeds.npr.org/1004/rss.xml" },

  /* =====================================================
     🇬🇧 UNITED KINGDOM
  ===================================================== */

  { name: "Sky News World", url: "https://feeds.skynews.com/feeds/rss/world.xml" },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss" },
  { name: "The Guardian Business", url: "https://www.theguardian.com/business/rss" },
  { name: "The Guardian Technology", url: "https://www.theguardian.com/uk/technology/rss" },
  { name: "Financial Times", url: "https://www.ft.com/?format=rss" },
  { name: "The Independent", url: "https://www.independent.co.uk/rss" },
  { name: "Evening Standard", url: "https://www.standard.co.uk/rss" },

  /* =====================================================
     🇪🇺 EUROPE
  ===================================================== */

  { name: "Euronews", url: "https://www.euronews.com/rss?format=mrss&level=theme&name=news" },
  { name: "Politico Europe", url: "https://www.politico.eu/feed/" },
  { name: "Irish Times", url: "https://www.irishtimes.com/cmlink/news-1.1319192" },
  { name: "The Local Europe", url: "https://feeds.thelocal.com/rss/en" },
  { name: "Moscow Times", url: "https://www.themoscowtimes.com/rss/news" },

  /* =====================================================
     🌍 AFRICA
  ===================================================== */

  { name: "AllAfrica", url: "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf" },
  { name: "Daily Nation (Kenya)", url: "https://nation.africa/kenya/rss.xml" },
  { name: "Premium Times (Nigeria)", url: "https://www.premiumtimesng.com/feed" },
  { name: "Mail & Guardian", url: "https://mg.co.za/feed/" },
  { name: "The East African", url: "https://www.theeastafrican.co.ke/tea/rss.xml" },

  /* =====================================================
     🌍 MIDDLE EAST
  ===================================================== */

  { name: "Arab News", url: "https://www.arabnews.com/rss.xml" },
  { name: "Jerusalem Post", url: "https://www.jpost.com/rss/rssfeedsfrontpage.aspx" },
  { name: "Middle East Eye", url: "https://www.middleeasteye.net/rss" },
  { name: "Times of Israel", url: "https://www.timesofisrael.com/feed/" },

  /* =====================================================
     🌏 SOUTH & EAST ASIA
  ===================================================== */

  { name: "The Hindu", url: "https://www.thehindu.com/feeder/default.rss" },
  { name: "Dawn Pakistan", url: "https://www.dawn.com/feeds/home" },
  { name: "South China Morning Post", url: "https://www.scmp.com/rss/91/feed" },
  { name: "Straits Times", url: "https://www.straitstimes.com/global/rss.xml" },
  { name: "Japan Times", url: "https://www.japantimes.co.jp/feed/" },
  { name: "Korea Herald", url: "http://www.koreaherald.com/rss/0200.xml" },

  /* =====================================================
     🌎 LATIN AMERICA
  ===================================================== */

  { name: "Buenos Aires Herald", url: "https://buenosairesherald.com/feed" },
  { name: "Rio Times", url: "https://riotimesonline.com/feed/" },
  { name: "Merco Press", url: "https://en.mercopress.com/rss" },
  { name: "El País (English)", url: "https://feeds.elpais.com/mrss-s/pages/ep/site/english.elpais.com/portada" },

  /* =====================================================
     🌊 PACIFIC / OCEANIA
  ===================================================== */

  { name: "ABC Australia", url: "https://www.abc.net.au/news/feed/51120/rss.xml" },
  { name: "RNZ New Zealand", url: "https://www.rnz.co.nz/rss/news.xml" },

  /* =====================================================
     🔬 TECHNOLOGY / SCIENCE / AI / MARKETS (Focus)
  ===================================================== */

  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "WIRED", url: "https://www.wired.com/rss/" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { name: "Bloomberg Markets", url: "https://feeds.bloomberg.com/markets/news.rss" },
  { name: "Nature News", url: "https://www.nature.com/nature.rss" },
  { name: "ScienceDaily", url: "https://www.sciencedaily.com/rss/all.xml" },
  { name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/" }

];

/**
 * Infer a coarse category from headline text
 */
function inferCategory(headline = "", summary = "", source = "") {
  const text = (headline + " " + summary + " " + source).toLowerCase();
  const src = source.toLowerCase();

  // 🔥 FEED-BASED OVERRIDE
  if (src.includes("technology")) return "technology";
  if (src.includes("business")) return "economy";
  if (src.includes("economics")) return "economy";
  if (src.includes("politics")) return "politics";

  // ==========================
  // ECONOMY / BUSINESS
  // ==========================
  if (/(economy|economic|inflation|gdp|recession|stocks?|markets?|bank|finance|business|earnings|profit|oil prices?|trade|tariffs?|interest rates?)/.test(text)) {
    return "economy";
  }

  // ==========================
  // TECHNOLOGY
  // ==========================
  if (/(tech|technology|ai|artificial intelligence|robot|software|hardware|chip|cyber|hacker|data breach|google|microsoft|apple|meta|tesla)/.test(text)) {
  return "technology";
  }

  // ==========================
  // DOMESTIC POLITICS
  // ==========================
  if (/(election|president|prime minister|pm|minister|senate|congress|parliament|government|policy|bill|lawmakers?)/.test(text)) {
    return "politics";
  }

  // ==========================
  // GEOPOLITICS / WAR
  // ==========================
  if (/(ukraine|russia|china|nato|israel|gaza|iran|middle east|taiwan|military|war|conflict)/.test(text)) {
    return "world";
  }

  // ==========================
  // LAW / CRIME
  // ==========================
  if (/(court|trial|arrest|charged|sentence|convicted|crime|fraud)/.test(text)) {
    return "politics";
  }

  // ==========================
  // DISASTERS
  // ==========================
  if (/(storm|flood|earthquake|wildfire|hurricane|typhoon|explosion|plane crash|landslide)/.test(text)) {
    return "world";
  }

  // Default
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

  // Reddit baseline boost
  if (category === "technology" || category === "economy") {
    score += 15;
  }

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
   Helper Function
=========================== */
function extractKeywords(text = "") {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(word =>
      word.length > 3 &&
      !["with","that","this","from","have","will","they","about","there","their","after","before"].includes(word)
    );
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

    const category = inferCategory(headline, summary, feedConfig.name);
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

    const normalizedTitle = headline
     .toLowerCase()
     .replace(/[^a-z0-9]/g, "")
     .trim();

    const contentHash = crypto
     .createHash("sha256")
     .update(normalizedTitle)
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

/* ===========================
   SIGNAL INGEST (Reddit → signals table)
=========================== */
async function ingestSignalFeed(pool, feedConfig) {
  const feed = await parser.parseURL(feedConfig.url);

  let inserted = 0;

  for (const item of feed.items.slice(0, 20)) {
    const headline = item.title?.trim();
    const sourceUrl = item.link;
    const pubDate = item.pubDate || item.isoDate || null;

    if (!headline || !sourceUrl) continue;

    const normalizedTitle = headline
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .trim();

    const contentHash = crypto
      .createHash("sha256")
      .update(normalizedTitle)
      .digest("hex");

    try {
      const result = await pool.query(
        `
        INSERT INTO signals (
          headline,
          source_name,
          source_url,
          platform,
          content_hash,
          published_at
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (content_hash) DO NOTHING
        `,
        [
          headline,
          feedConfig.name,
          sourceUrl,
          feedConfig.platform,
          contentHash,
          pubDate ? new Date(pubDate) : null
        ]
      );

      if (result.rowCount > 0) inserted++;
    } catch (err) {
      console.log("Signal insert failed:", err.message);
    }
  }

  return inserted;
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

/* ===========================
   MASTER SIGNAL INGEST
=========================== */
export async function ingestAllSignals(pool) {
  let inserted = 0;

  for (const feedConfig of SIGNAL_FEEDS) {
    console.log(`📡 Signal: ${feedConfig.name}`);
    try {
      inserted += await ingestSignalFeed(pool, feedConfig);
    } catch (err) {
      console.log(`⚠️ Signal failed: ${feedConfig.name}`);
    }
  }

  return { inserted };
}

/**
 * ✅ BACKWARD COMPAT: your old function still works
 * (only BBC World)
 */
export async function ingestBBCWorldRSS(pool) {
  const BBC_WORLD_RSS = "http://feeds.bbci.co.uk/news/world/rss.xml";
  return ingestOneFeed(pool, { name: "BBC World", url: BBC_WORLD_RSS });
}
