import Parser from "rss-parser";
import crypto from "crypto";

function normalizeSourceName(name = "") {
  const n = name.toLowerCase();

  if (n.includes("bbc")) return "BBC";
  if (n.includes("reuters")) return "Reuters";
  if (n.includes("cnn")) return "CNN";
  if (n.includes("nbc")) return "NBC";
  if (n.includes("abc")) return "ABC";
  if (n.includes("guardian")) return "Guardian";
  if (n.includes("new york times") || n.includes("nyt"))
    return "New York Times";
  if (n.includes("financial times")) return "Financial Times";
  if (n.includes("associated press") || n.includes("ap news"))
    return "Associated Press";
  if (n.includes("al jazeera")) return "Al Jazeera";
  if (n.includes("techcrunch")) return "TechCrunch";
  if (n.includes("wired")) return "WIRED";
  if (n.includes("verge")) return "The Verge";
  if (n.includes("bloomberg")) return "Bloomberg";
  if (n.includes("washington post")) return "Washington Post";
  if (n.includes("foreign policy")) return "Foreign Policy";
  if (n.includes("economist")) return "The Economist";
  if (n.includes("politico")) return "Politico";
  if (n.includes("axios")) return "Axios";
  if (n.includes("npr")) return "NPR";
  if (n.includes("sky")) return "Sky";
  if (n.includes("dw")) return "DW";
  if (n.includes("euronews")) return "Euronews";
  if (n.includes("france 24")) return "France 24";
  if (n.includes("al-monitor") || n.includes("al monitor")) return "Al-Monitor";
  if (n.includes("times of israel")) return "Times of Israel";
  if (n.includes("jerusalem post")) return "Jerusalem Post";
  if (n.includes("haaretz")) return "Haaretz";
  if (n.includes("middle east eye")) return "Middle East Eye";
  if (n.includes("arab news")) return "Arab News";
  if (n.includes("dawn")) return "Dawn";
  if (n.includes("hindu")) return "The Hindu";
  if (n.includes("economic times")) return "Economic Times India";
  if (n.includes("bangkok post")) return "Bangkok Post";
  if (n.includes("south china morning")) return "South China Morning Post";
  if (n.includes("straits times")) return "The Straits Times";
  if (n.includes("channel newsasia") || n.includes("cna"))
    return "Channel NewsAsia";
  if (n.includes("vnexpress")) return "VnExpress Vietnam";
  if (n.includes("akipress")) return "AkiPress Central Asia";
  if (n.includes("stuff")) return "Stuff NZ";
  if (n.includes("rnz")) return "RNZ New Zealand";
  if (n.includes("sbs")) return "SBS Australia";
  if (n.includes("vanguard")) return "Vanguard Nigeria";
  if (n.includes("premium times")) return "Premium Times (Nigeria)";
  if (n.includes("daily nation")) return "Daily Nation (Kenya)";
  if (n.includes("nation africa")) return "Nation Africa";
  if (n.includes("allafrica")) return "AllAfrica";
  if (n.includes("agencia brasil")) return "Agencia Brasil";
  if (n.includes("rio times")) return "Rio Times";
  if (n.includes("buenos aires")) return "Buenos Aires Herald";
  if (n.includes("merco")) return "Merco Press";
  if (n.includes("el comercio")) return "El Comercio Peru";
  if (n.includes("el pais") || n.includes("el país"))
    return "El País (English)";
  if (n.includes("prensa libre")) return "Prensa Libre Guatemala";
  if (n.includes("confidencial")) return "Confidencial Nicaragua";
  if (n.includes("national post")) return "National Post";
  if (n.includes("irish times")) return "Irish Times";
  if (n.includes("moscow times")) return "Moscow Times";
  if (n.includes("err")) return "ERR Estonia";
  if (n.includes("ukrinform")) return "Ukrinform";
  if (n.includes("civil georgia")) return "Civil Georgia";
  if (n.includes("trend")) return "Trend Azerbaijan";
  if (n.includes("evening standard")) return "Evening Standard";
  if (n.includes("euractiv")) return "Euractiv";
  if (n.includes("ars technica")) return "Ars Technica";
  if (n.includes("bleeping")) return "BleepingComputer";
  if (n.includes("science daily") || n.includes("sciencedaily"))
    return "ScienceDaily";
  if (n.includes("mit") && n.includes("review")) return "MIT Review";
  if (n.includes("diplomat")) return "The Diplomat";
  if (n.includes("crisis group")) return "Crisis Group";
  if (n.includes("relief web") || n.includes("reliefweb")) return "Relief Web";
  if (n.includes("ips")) return "IPS";
  if (n.includes("egypt independent")) return "Egypt Independent";
  if (n.includes("daily maverick")) return "Daily Maverick";
  if (n.includes("business day")) return "Business Day Nigeria";
  if (n.includes("vanguard")) return "Vanguard Nigeria";
  if (n.includes("dialogue chino") || n.includes("diálogo chino"))
    return "Dialogue Chino";
  if (n.includes("africa report")) return "The Africa Report";
  if (n.includes("sbs")) return "SBS Australia";
  if (n.includes("akipress")) return "AkiPress Central Asia";

  const cleaned = name
    .replace("Top Stories", "")
    .replace("World", "")
    .replace("Business", "")
    .replace("Technology", "")
    .replace("Markets", "")
    .replace("Politics", "")
    .replace("News", "")
    .trim();

  return cleaned || name;
}

console.log("🔥 RSS INGEST SERVICE FILE LOADED 🔥");

const parser = new Parser({
  requestOptions: {
    headers: {
      "User-Agent": "NewsTracBot/1.0 (+https://newstrac.org)",
    },
  },
});

/* ===========================
   SIGNAL FEEDS (Reddit Only)
   Separate from journalism feeds
=========================== */
const SIGNAL_FEEDS = [
  {
    name: "Reddit WorldNews",
    url: "https://www.reddit.com/r/worldnews/.rss",
    platform: "reddit",
  },
  {
    name: "Reddit Economics",
    url: "https://www.reddit.com/r/economics/.rss",
    platform: "reddit",
  },
  {
    name: "Reddit Technology",
    url: "https://www.reddit.com/r/technology/.rss",
    platform: "reddit",
  },
];

/* ===========================
   ROBUST FEED SET (~25)
   (high quality, stable)
=========================== */
const FEEDS = [
  /* =====================================================
     🌍 CORE GLOBAL BACKBONE (High Credibility / Wire)
  ===================================================== */

  {
    name: "BBC World",
    url: "http://feeds.bbci.co.uk/news/world/rss.xml",
    tier: "global",
  },
  {
    name: "BBC UK",
    url: "http://feeds.bbci.co.uk/news/uk/rss.xml",
    tier: "global",
  },
  {
    name: "Reuters World",
    url: "https://www.reutersagency.com/feed/?best-topics=world&post_type=best",
    tier: "global",
  },
  {
    name: "Reuters Business",
    url: "https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best",
    tier: "global",
  },
  { name: "Associated Press", url: "https://apnews.com/rss" },
  { name: "DW Top", url: "https://rss.dw.com/rdf/rss-en-top", tier: "global" },
  {
    name: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    tier: "global",
  },

  /* =====================================================
     🇺🇸 UNITED STATES
  ===================================================== */

  { name: "CNN Top Stories", url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
  { name: "NBC Top Stories", url: "http://feeds.nbcnews.com/feeds/topstories" },
  {
    name: "ABC News Top Stories",
    url: "http://feeds.abcnews.com/abcnews/topstories",
  },
  {
    name: "NYT World",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
  },
  {
    name: "NYT Technology",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
  },
  {
    name: "Washington Post World",
    url: "https://feeds.washingtonpost.com/rss/world",
  },
  { name: "Politico US", url: "https://www.politico.com/rss/politics08.xml" },
  { name: "Axios", url: "https://api.axios.com/feed/" },
  { name: "NPR World", url: "https://feeds.npr.org/1004/rss.xml" },

  /* =====================================================
     North America
  ===================================================== */

  { name: "CBC News", url: "https://www.cbc.ca/cmlink/rss-topstories" },
  {
    name: "Globe and Mail",
    url: "https://www.theglobeandmail.com/arc/outboundfeeds/rss/",
  },
  { name: "National Post", url: "https://nationalpost.com/feed/" },
  { name: "Macleans", url: "https://www.macleans.ca/feed/" },

  /* =====================================================
     🇬🇧 UNITED KINGDOM
  ===================================================== */

  {
    name: "Sky News World",
    url: "https://feeds.skynews.com/feeds/rss/world.xml",
  },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss" },
  {
    name: "The Guardian Business",
    url: "https://www.theguardian.com/business/rss",
  },
  {
    name: "The Guardian Technology",
    url: "https://www.theguardian.com/uk/technology/rss",
  },
  {
    name: "Financial Times",
    url: "https://www.ft.com/?format=rss",
    tier: "global",
  },
  { name: "The Independent", url: "https://www.independent.co.uk/rss" },
  { name: "Evening Standard", url: "https://www.standard.co.uk/rss" },

  /* =====================================================
     🇪🇺 EUROPE
  ===================================================== */

  {
    name: "Euronews",
    url: "https://www.euronews.com/rss?format=mrss&level=theme&name=news",
  },
  { name: "Politico Europe", url: "https://www.politico.eu/feed/" },
  {
    name: "Irish Times",
    url: "https://www.irishtimes.com/cmlink/news-1.1319192",
  },
  { name: "The Local Europe", url: "https://feeds.thelocal.com/rss/en" },
  { name: "Moscow Times", url: "https://www.themoscowtimes.com/rss/news" },
  { name: "Kyiv Post", url: "https://www.kyivpost.com/rss" },
  { name: "Ukrinform", url: "https://www.ukrinform.net/rss/block-lastnews" },
  { name: "Baltic Times", url: "https://www.baltictimes.com/rss/" },
  { name: "ERR News Estonia", url: "https://www.err.ee/rss" },
  { name: "LRT Lithuania", url: "https://www.lrt.lt/en/rss" },
  { name: "Radio Prague", url: "https://english.radio.cz/feed" },
  { name: "Emerging Europe", url: "https://emerging-europe.com/feed/" },
  { name: "Euractiv", url: "https://www.euractiv.com/feed/" },
  { name: "SwissInfo", url: "https://www.swissinfo.ch/eng/rss/homepage" },
  { name: "ANSA Italy", url: "https://www.ansa.it/sito/ansait/rss.html" },

  /* =====================================================
     🌍 AFRICA
  ===================================================== */

  {
    name: "AllAfrica",
    url: "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf",
    tier: "regional",
  },
  {
    name: "Daily Nation (Kenya)",
    url: "https://nation.africa/kenya/rss.xml",
    tier: "regional",
  },
  {
    name: "Premium Times (Nigeria)",
    url: "https://www.premiumtimesng.com/feed",
    tier: "regional",
  },
  { name: "Mail & Guardian", url: "https://mg.co.za/feed/", tier: "regional" },
  {
    name: "The East African",
    url: "https://www.theeastafrican.co.ke/tea/rss.xml",
    tier: "regional",
  },
  {
    name: "Vanguard Nigeria",
    url: "https://www.vanguardngr.com/feed/",
    tier: "regional",
  },
  {
    name: "Citi Newsroom Ghana",
    url: "https://citinewsroom.com/feed/",
    tier: "regional",
  },
  {
    name: "The Citizen Tanzania",
    url: "https://www.thecitizen.co.tz/feed/",
    tier: "regional",
  },
  {
    name: "New Vision Uganda",
    url: "https://www.newvision.co.ug/rss",
    tier: "regional",
  },
  {
    name: "Ethiopian Monitor",
    url: "https://www.ethiopianmonitor.com/feed/",
    tier: "regional",
  },
  { name: "EWN South Africa", url: "https://ewn.co.za/RSS", tier: "regional" },
  {
    name: "NewsDay Zimbabwe",
    url: "https://www.newsday.co.zw/feed/",
    tier: "regional",
  },
  {
    name: "Daily Maverick (SA)",
    url: "https://www.dailymaverick.co.za/feed/",
    tier: "regional",
  },
  {
    name: "BusinessDay Nigeria",
    url: "https://businessday.ng/feed/",
    tier: "regional",
  },

  /* =====================================================
     🌍 MIDDLE EAST
  ===================================================== */

  { name: "Arab News", url: "https://www.arabnews.com/rss.xml" },
  {
    name: "Jerusalem Post",
    url: "https://www.jpost.com/rss/rssfeedsfrontpage.aspx",
  },
  { name: "Middle East Eye", url: "https://www.middleeasteye.net/rss" },
  { name: "Times of Israel", url: "https://www.timesofisrael.com/feed/" },
  { name: "Al-Monitor", url: "https://www.al-monitor.com/rss" },
  { name: "Gulf News", url: "https://gulfnews.com/rss" },
  { name: "The National (UAE)", url: "https://www.thenationalnews.com/rss" },
  { name: "Daily Sabah (Turkey)", url: "https://www.dailysabah.com/rss" },
  { name: "Kurdistan 24", url: "https://www.kurdistan24.net/en/rss" },
  { name: "Rudaw (Iraq/Kurds)", url: "https://english.rudaw.net/rss" },
  { name: "Egypt Independent", url: "https://www.egyptindependent.com/feed/" },
  { name: "Jordan Times", url: "https://www.jordantimes.com/feed" },

  /* =====================================================
     🌏 SOUTH & EAST ASIA
  ===================================================== */

  { name: "The Hindu", url: "https://www.thehindu.com/feeder/default.rss" },
  { name: "Dawn Pakistan", url: "https://www.dawn.com/feeds/home" },
  { name: "South China Morning Post", url: "https://www.scmp.com/rss/91/feed" },
  { name: "Straits Times", url: "https://www.straitstimes.com/global/rss.xml" },
  { name: "Japan Times", url: "https://www.japantimes.co.jp/feed/" },
  { name: "Korea Herald", url: "http://www.koreaherald.com/rss/0200.xml" },
  { name: "Tribune Pakistan", url: "https://tribune.com.pk/feed" },
  {
    name: "The Daily Star Bangladesh",
    url: "https://www.thedailystar.net/rss.xml",
  },
  { name: "The Print India", url: "https://theprint.in/feed/" },
  {
    name: "Economic Times India",
    url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms",
  },
  {
    name: "Bangkok Post",
    url: "https://www.bangkokpost.com/rss/data/topstories.xml",
  },
  { name: "Jakarta Post", url: "https://www.thejakartapost.com/rss" },
  { name: "Rappler Philippines", url: "https://www.rappler.com/feed/" },
  { name: "Phnom Penh Post", url: "https://www.phnompenhpost.com/rss.xml" },
  { name: "VnExpress Vietnam", url: "https://e.vnexpress.net/rss/news.rss" },
  { name: "Colombo Gazette", url: "https://colombogazette.com/feed/" },
  {
    name: "My Republica Nepal",
    url: "https://myrepublica.nagariknetwork.com/rss",
  },

  /* =====================================================
     🌏 Central Asia & Caucasus 
  ===================================================== */

  { name: "Eurasianet", url: "https://eurasianet.org/rss.xml" },
  { name: "AkiPress Central Asia", url: "https://akipress.com/rss/" },
  { name: "Civil Georgia", url: "https://civil.ge/feed" },
  { name: "Agenda.ge", url: "https://agenda.ge/en/rss" },
  { name: "Trend News Azerbaijan", url: "https://en.trend.az/rss" },

  /* =====================================================
     🌎 LATIN AMERICA
  ===================================================== */

  { name: "Buenos Aires Herald", url: "https://buenosairesherald.com/feed" },
  { name: "Rio Times", url: "https://riotimesonline.com/feed/" },
  { name: "Merco Press", url: "https://en.mercopress.com/rss" },
  {
    name: "El País (English)",
    url: "https://feeds.elpais.com/mrss-s/pages/ep/site/english.elpais.com/portada",
  },
  {
    name: "Agencia Brasil",
    url: "https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml",
  },
  { name: "Infobae", url: "https://www.infobae.com/feeds/rss/" },
  { name: "Proceso Mexico", url: "https://www.proceso.com.mx/feed/" },
  { name: "El Comercio Peru", url: "https://www.elcomercio.com/rss" },
  {
    name: "El Espectador Colombia",
    url: "https://www.elespectador.com/arcio/rss/",
  },
  { name: "La Prensa Honduras", url: "https://www.laprensa.hn/feed/" },
  { name: "Prensa Libre Guatemala", url: "https://www.prensalibre.com/feed" },
  { name: "Confidencial Nicaragua", url: "https://confidencial.digital/feed/" },
  {
    name: "Dialogue Chino (China-LatAm)",
    url: "https://dialogochino.net/en/feed/",
  },

  /* =====================================================
     🌊 PACIFIC / OCEANIA
  ===================================================== */

  {
    name: "ABC Australia",
    url: "https://www.abc.net.au/news/feed/51120/rss.xml",
  },
  { name: "RNZ New Zealand", url: "https://www.rnz.co.nz/rss/news.xml" },
  {
    name: "NZ Herald",
    url: "https://www.nzherald.co.nz/arc/outboundfeeds/rss/?outputType=xml",
  },
  { name: "RNZ Pacific", url: "https://www.rnz.co.nz/rss/pacificnews.xml" },
  { name: "SBS Australia", url: "https://www.sbs.com.au/news/feed" },
  { name: "Stuff NZ", url: "https://www.stuff.co.nz/rss" },

  /* =====================================================
     🔬 TECHNOLOGY / SCIENCE / AI / MARKETS (Focus)
  ===================================================== */

  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "WIRED", url: "https://www.wired.com/rss/" },
  {
    name: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
  },
  {
    name: "MIT Technology Review",
    url: "https://www.technologyreview.com/feed/",
  },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  {
    name: "Bloomberg Markets",
    url: "https://feeds.bloomberg.com/markets/news.rss",
    tier: "global",
  },
  { name: "Nature News", url: "https://www.nature.com/nature.rss" },
  { name: "ScienceDaily", url: "https://www.sciencedaily.com/rss/all.xml" },
  { name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/" },

  /* =====================================================
      Global Specialist / Geopolitics 
  ===================================================== */

  { name: "Foreign Policy", url: "https://foreignpolicy.com/feed/" },
  { name: "The Diplomat", url: "https://thediplomat.com/feed/" },
  { name: "IPS News", url: "https://www.ipsnews.net/feed/" },
  { name: "Crisis Group", url: "https://www.crisisgroup.org/rss.xml" },
  { name: "Relief Web", url: "https://reliefweb.int/updates/rss.xml" },
  {
    name: "World Politics Review",
    url: "https://www.worldpoliticsreview.com/feed/",
  },
  {
    name: "Lowy Institute",
    url: "https://www.lowyinstitute.org/the-interpreter/rss.xml",
  },
  { name: "Open Democracy", url: "https://www.opendemocracy.net/en/rss.xml" },
];

/**
 * Infer a coarse category from headline text
 */
function inferCategory(headline = "", summary = "", source = "") {
  const text = (headline + " " + summary).toLowerCase();

  if (
    /(iran|israel|gaza|lebanon|houthi|hormuz|syria|iraq|saudi|gulf|middle east|persian|tehran|jerusalem|beirut)/.test(
      text,
    )
  )
    return "Middle East";

  if (
    /(ukraine|russia|moscow|kyiv|nato|poland|germany|france|britain|uk|europe|european|berlin|paris|london)/.test(
      text,
    )
  )
    return "Europe";

  if (
    /(china|taiwan|korea|japan|asia|india|pakistan|beijing|tokyo|seoul|hong kong|south china|xi jinping)/.test(
      text,
    )
  )
    return "Asia";

  if (
    /(trump|us |u\.s\.|america|united states|washington|congress|fed |federal reserve|wall street|pentagon|white house)/.test(
      text,
    )
  )
    return "Americas";

  if (
    /(africa|nigeria|kenya|ethiopia|sudan|ghana|egypt|cairo|south africa|sahel|somalia)/.test(
      text,
    )
  )
    return "Africa";

  if (
    /(un |united nations|global|worldwide|imf|world bank|g7|g20|wto|international)/.test(
      text,
    )
  )
    return "Global";

  return "World";
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

  if (diffMinutes <= 60) return 25; // 1 hour
  if (diffMinutes <= 180) return 15; // 3 hours
  if (diffMinutes <= 360) return 10; // 6 hours

  return 0;
}

/**
 * Deterministic explainable scoring
 */
function computeInitialScore(
  headline = "",
  category = "",
  pubDate = null,
  tier = "standard",
) {
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

  // Economics
  if (
    /(oil|inflation|interest rate|recession|tariff|trade war|sanctions|bond|currency|gdp|opec|federal reserve)/.test(
      text,
    )
  ) {
    score += 20;
  }

  // Category boost (non generic world)
  if (category && category !== "world") {
    score += 10;
  }

  // Time boost
  score += computeTimeBoost(pubDate);

  // Regional weight — local stories need high urgency to surface globally
  if (tier === "regional") {
    const isHighUrgency =
      /(kill|killed|dead|attack|explosion|coup|flood|earthquake|famine|war|crisis)/.test(
        text,
      );
    if (!isHighUrgency) {
      score = Math.round(score * 0.55);
    }
  }

  // Global tier boost — wire services get authority bonus
  if (tier === "global") {
    score += 10;
  }

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
    .filter(
      (word) =>
        word.length > 3 &&
        ![
          "with",
          "that",
          "this",
          "from",
          "have",
          "will",
          "they",
          "about",
          "there",
          "their",
          "after",
          "before",
        ].includes(word),
    );
}

function makeClusterKey(headline = "") {
  if (!headline) return null;

  const text = headline
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(" ")
    .filter(
      (word) =>
        word.length > 3 &&
        ![
          "with",
          "from",
          "that",
          "this",
          "have",
          "will",
          "about",
          "after",
          "over",
          "into",
          "under",
          "against",
          "amid",
          "says",
          "say",
          "said",
          "report",
          "reports",
          "update",
        ].includes(word),
    );

  return text.slice(0, 5).sort().join("-");
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

    const clusterKey = makeClusterKey(headline);

    let initialScore = computeInitialScore(
      headline,
      category,
      pubDate,
      feedConfig.tier,
    );

    // 🔥 cluster logic (counts similar stories)

    const clusterResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM candidates WHERE cluster_key = $1`,
      [clusterKey],
    );

    const clusterSize = (clusterResult.rows[0]?.count || 0) + 1;

    // boost score if many outlets report same story
    if (clusterSize >= 5) initialScore += 5;
    if (clusterSize >= 10) initialScore += 10;
    if (clusterSize >= 20) initialScore += 20;

    // 🔥 HEAT ENGINE START

    try {
      const keywords = extractKeywords(headline);

      if (keywords.length > 0) {
        const signalResult = await pool.query(
          `
      SELECT headline
      FROM signals
      WHERE published_at > NOW() - INTERVAL '6 hours'
      LIMIT 100
      `,
        );

        let heatMatches = 0;

        for (const row of signalResult.rows) {
          const signalWords = extractKeywords(row.headline);

          const overlap = keywords.filter((k) => signalWords.includes(k));

          if (overlap.length >= 2) {
            heatMatches++;
          }
        }

        const heatBoost = Math.min(heatMatches * 5, 20);

        initialScore += heatBoost;
      }
    } catch (err) {
      console.log("Heat engine error:", err.message);
    }

    // 🔥 HEAT ENGINE END

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
          cluster_Key,
          cluster_Size,
          published_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (content_hash) DO NOTHING
        `,
        [
          headline,
          summary,
          normalizeSourceName(feedConfig.name),
          sourceUrl,
          category,
          "rss",
          status,
          initialScore,
          contentHash,
          clusterKey,
          clusterSize,
          pubDate ? new Date(pubDate) : null,
        ],
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
          pubDate ? new Date(pubDate) : null,
        ],
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

  const UNIQUE_FEEDS = [
    ...new Map(FEEDS.map((f) => [String(f.url).trim(), f])).values(),
  ];

  for (const feedConfig of UNIQUE_FEEDS) {
    console.log(`🌍 Processing: ${feedConfig.name}`);

    try {
      const res = await ingestOneFeed(pool, feedConfig);
      inserted += res.inserted;
      skipped += res.skipped;
      console.log(
        `✅ Done: ${feedConfig.name} | inserted=${res.inserted} skipped=${res.skipped}`,
      );
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
