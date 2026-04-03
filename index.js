import express from "express";
import pkg from "pg";
import dotenv from "dotenv";
import { startCron } from "./services/cronService.js";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ingestAllFeeds, ingestAllSignals } from "./services/rssIngest.js";

dotenv.config();
const { Pool } = pkg;

console.log("🔥 INDEX.JS LOADED — REAL ENTRYPOINT 🔥");

/* ===========================
   APP SETUP
=========================== */
const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT || 3001;

/* ===========================
   SECURITY MIDDLEWARE
=========================== */

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

/* ===========================
   CORS (LOCKED)
=========================== */

const ALLOWED_ORIGINS = [
  "https://newstrack-frontend.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "https://newstrac.org",
  "https://www.newstrac.org",
  "http://localhost:3002",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
  }),
);

app.use((err, req, res, next) => {
  if (err && String(err.message || "").startsWith("CORS blocked:")) {
    return res.status(403).json({ error: err.message });
  }
  next(err);
});

app.use(express.json());

/* ===========================
   DATABASE
=========================== */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ===========================
   AUTH MIDDLEWARE
=========================== */

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* ===========================
   HEALTH
=========================== */

app.get("/", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      service: "newstrack-backend",
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ status: "error" });
  }
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "healthy" });
  } catch {
    res.status(500).json({ status: "unhealthy" });
  }
});

/* ===========================
   AUTH ROUTES
=========================== */

app.post("/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "Missing fields" });

  const password_hash = await bcrypt.hash(password, 10);

  try {
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1,$2,$3,'journalist')
       RETURNING id,name,email,role,created_at`,
      [name.trim(), email.trim().toLowerCase(), password_hash],
    );
    res.status(201).json({ user: result.rows[0] });
  } catch {
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(`SELECT * FROM users WHERE email=$1`, [
      email.trim().toLowerCase(),
    ]);

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, role, created_at FROM users WHERE id = $1",
      [req.user.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error("Auth/me error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===========================
   OVERVIEW SNAPSHOT (for delta comparison)
=========================== */

const overviewSnapshots = []; // rolling 25h of hourly snapshots

setInterval(
  async () => {
    try {
      // Reuse the same query as /signals/overview to get current values
      const result = await pool.query(`
      SELECT headline, summary, published_at, source_name
      FROM candidates
      WHERE status != 'ignored'
      AND published_at > NOW() - INTERVAL '48 hours'
    `);
      const rows = result.rows || [];
      const now = new Date();
      const recentAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      let recentCount = 0;
      let econHits = 0;
      const ECON_SNAP = [
        "oil price",
        "crude",
        "brent",
        "inflation",
        "interest rate",
        "recession",
        "tariff",
        "trade war",
        "bond yield",
      ];

      for (const row of rows) {
        const pub = new Date(row.published_at);
        if (pub > recentAgo) {
          recentCount++;
          const text = (
            (row.headline || "") +
            " " +
            (row.summary || "")
          ).toLowerCase();
          if (ECON_SNAP.some((k) => text.includes(k))) econHits++;
        }
      }

      overviewSnapshots.push({
        time: now,
        velocityProxy: recentCount, // simple volume proxy
        econProxy: econHits,
      });

      // Keep only last 25 hours of snapshots
      const cutoff = new Date(now.getTime() - 25 * 60 * 60 * 1000);
      while (overviewSnapshots.length && overviewSnapshots[0].time < cutoff) {
        overviewSnapshots.shift();
      }

      console.log(
        `📸 Snapshot saved: ${recentCount} articles, ${econHits} econ hits`,
      );
    } catch (err) {
      console.error("Snapshot error:", err.message);
    }
  },
  60 * 60 * 1000,
); // every hour

/* ===========================
   PING RENDER
=========================== */
const BACKEND_URL =
  process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;

setInterval(
  async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/health`);
      console.log(`🏓 Keep-alive ping: ${res.status}`);
    } catch (err) {
      console.warn("Keep-alive ping failed:", err.message);
    }
  },
  10 * 60 * 1000,
);

/* ===========================
   POSTS
=========================== */

app.get("/posts", async (req, res) => {
  const result = await pool.query(`
    SELECT p.id, p.headline, p.description, p.views, p.created_at,
           p.region, p.country, p.source_name, u.name AS author_name
    FROM posts p
    LEFT JOIN users u ON p.author_id = u.id
    ORDER BY p.created_at DESC
  `);
  res.json(result.rows);
});

/* ===========================
   CREATE POST (Journalist)
=========================== */

app.post("/journalists/:id/posts", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { headline, content, region, country } = req.body;

  if (!headline || !content) {
    return res.status(400).json({ error: "Headline and content required" });
  }

  if (String(req.user.id) !== String(id)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO posts (headline, description, author_id, views, created_at, region, country)
      VALUES ($1, $2, $3, 0, NOW(), $4, $5)
      RETURNING *
      `,
      [
        headline.trim(),
        content.trim(),
        id,
        region || "Global",
        country?.trim() || "",
      ],
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Create post error:", err);
    res.status(500).json({ error: "Failed to create post" });
  }
});

/* ===========================
   GET JOURNALIST POSTS
=========================== */

app.get("/journalists/:id/posts", requireAuth, async (req, res) => {
  const { id } = req.params;

  if (String(req.user.id) !== String(id)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const result = await pool.query(
      `
      SELECT id, headline, description AS content, views, created_at, region, country
      FROM posts
      WHERE author_id = $1
      ORDER BY created_at DESC
      `,
      [id],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Get journalist posts error:", err);
    res.status(500).json({ error: "Failed to load posts" });
  }
});

/* ===========================
   DELETE POST (Journalist)
=========================== */

app.delete("/journalists/:id/posts/:postId", requireAuth, async (req, res) => {
  const { id, postId } = req.params;

  if (String(req.user.id) !== String(id)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const check = await pool.query(
      `SELECT id FROM posts WHERE id = $1 AND author_id = $2`,
      [postId, id],
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Post not found or not yours" });
    }

    await pool.query(`DELETE FROM posts WHERE id = $1`, [postId]);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete post error:", err);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

/* ===========================
   REVENUE SIMULATION
=========================== */

app.get("/revenue/simulate", requireAuth, async (req, res) => {
  const total = Number(req.query.total);

  if (!total || total <= 0) {
    return res.status(400).json({ error: "Invalid total revenue" });
  }

  try {
    // Simple prototype split logic
    const journalistShare = total * 0.7;
    const platformShare = total * 0.3;

    res.json({
      total_revenue: total,
      journalist_share: journalistShare,
      platform_share: platformShare,
    });
  } catch (err) {
    console.error("Revenue simulation error:", err);
    res.status(500).json({ error: "Revenue simulation failed" });
  }
});

/* ===========================
   TRENDING POSTS
   (Moved ABOVE dynamic route)
=========================== */

app.get("/posts/trending", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *,
      (
        views * 3 +
        EXTRACT(EPOCH FROM (NOW() - created_at)) * -0.00005
      ) AS score
      FROM posts
      ORDER BY score DESC
      LIMIT 6
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Trending error:", err);
    res.status(500).json({ error: "Failed to fetch trending posts" });
  }
});

/* ===========================
   GET SINGLE POST + TRACK VIEW
=========================== */

app.get("/posts/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("UPDATE posts SET views = views + 1 WHERE id=$1", [id]);

    const result = await pool.query(
      `
      SELECT p.*, u.name AS author_name
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.id = $1
      `,
      [id],
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Single post error:", err);
    res.status(500).json({ error: "Failed to fetch post" });
  }
});

/* ===========================
   INCREMENT POST VIEWS
=========================== */

app.post("/posts/:id/view", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      UPDATE posts
      SET views = COALESCE(views, 0) + 1
      WHERE id = $1
      RETURNING id, views
      `,
      [id],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Post not found" });
    }

    res.json({ ok: true, post: result.rows[0] });
  } catch (err) {
    console.error("Increment views error:", err);
    res.status(500).json({ error: "Failed to increment views" });
  }
});

/* ===========================
   JOURNALIST METRICS (Views → Earnings)
=========================== */

const DEFAULT_RPM_GBP = 3.5;

app.get("/journalists/:id/metrics", requireAuth, async (req, res) => {
  const { id } = req.params;

  // Only allow user to see their own metrics
  if (String(req.user.id) !== String(id)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const postsResult = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_posts,
        COALESCE(SUM(COALESCE(views, 0)), 0)::int AS total_views
      FROM posts
      WHERE author_id = $1
      `,
      [id],
    );

    const total_posts = postsResult.rows[0]?.total_posts ?? 0;
    const total_views = postsResult.rows[0]?.total_views ?? 0;

    const rpm = DEFAULT_RPM_GBP;
    const estimated_earnings = Number(((total_views / 1000) * rpm).toFixed(2));

    res.json({
      journalist_id: String(id),
      total_posts,
      total_views,
      rpm_gbp: rpm,
      estimated_earnings_gbp: estimated_earnings,
    });
  } catch (err) {
    console.error("Journalist metrics error:", err);
    res.status(500).json({ error: "Failed to load metrics" });
  }
});

let cachedFeed = null;
let cachedFeedTime = 0;
let cachedFeedBreaking = false;

/* ===========================
   FEED (Cluster-Aware, Preserves Scoring Logic)
=========================== */

app.get("/feed", async (req, res) => {
  const cacheAge = Date.now() - cachedFeedTime;
  const cacheLimit = cachedFeedBreaking ? 60 * 1000 : 5 * 60 * 1000;
  if (cachedFeed && cacheAge < cacheLimit) {
    return res.json(cachedFeed);
  }

  try {
    // 1️⃣ Keep ORIGINAL ranking logic intact
    const result = await pool.query(`
      SELECT *,
      (
        initial_score * 0.7 +
        GREATEST(
          0,
          24 - (EXTRACT(EPOCH FROM (NOW() - published_at)) / 3600.0)
        )
      ) AS ranking_score
      FROM candidates
      WHERE status != 'ignored'
      AND published_at IS NOT NULL
      AND published_at > NOW() - INTERVAL '36 hours'
      ORDER BY ranking_score DESC
      LIMIT 80;
    `);

    const rows = result.rows || [];

    // 2️⃣ Preserve Reddit filtering
    const filtered = rows.filter(
      (r) => !String(r.source_name || "").includes("Reddit"),
    );

    // 3️⃣ Cluster by narrative similarity (using your existing helpers)
    const clusters = {};

    for (const row of filtered) {
      let key =
        makeClusterKey(row.headline) || row.headline.toLowerCase().slice(0, 60);

      // Try merging into closest existing cluster
      if (!clusters[key]) {
        const best = findBestExistingClusterKey(row.headline, clusters);
        if (best) key = best;
      }

      if (!clusters[key]) {
        clusters[key] = {
          topArticle: row,
          totalScore: row.ranking_score || 0,
          clusterCount: 1,
          _tokens: tokenSetForHeadline(row.headline),
        };
      } else {
        clusters[key].clusterCount += 1;
        clusters[key].totalScore += row.ranking_score || 0;

        // Keep highest ranked article as representative
        if (
          (row.ranking_score || 0) >
          (clusters[key].topArticle.ranking_score || 0)
        ) {
          clusters[key].topArticle = row;
        }
      }
    }

    // 4️⃣ Rank clusters (not individual articles)
    const clusteredFeed = Object.values(clusters)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((c) => ({
        ...c.topArticle,
        clusterCount: c.clusterCount,
        narrativeLabel: c.topArticle.category || null,
      }))
      .slice(0, 100);

    cachedFeed = clusteredFeed;
    cachedFeedTime = Date.now();
    cachedFeedBreaking = clusteredFeed.some(
      (a) => (a.ranking_score || 0) >= 70,
    );

    res.json(clusteredFeed);
  } catch (err) {
    console.error("Feed CLUSTER error:");
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ===========================
   helper function
=========================== */

function findDivergent(articles) {
  if (!articles || articles.length < 3) return [];

  const tokenMap = new Map();

  for (const article of articles) {
    const words = (article.headline || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(" ")
      .filter((w) => w.length > 4);

    for (const w of words) {
      tokenMap.set(w, (tokenMap.get(w) || 0) + 1);
    }
  }

  const commonWords = [...tokenMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map((entry) => entry[0]);

  const divergent = [];

  for (const article of articles) {
    const words = new Set(
      (article.headline || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(" "),
    );

    const overlap = commonWords.filter((w) => words.has(w)).length;

    if (overlap <= 1) {
      divergent.push({
        headline: article.headline,
        source: article.source,
        reason: "Low keyword overlap",
      });
    }
  }

  return divergent.slice(0, 3);
}

function divergenceScore(articles) {
  if (!articles || articles.length < 2) return 0;

  const sets = articles
    .map((a) => tokenSetForHeadline(a.headline || ""))
    .filter((s) => s.size > 0);

  if (sets.length < 2) return 0;

  let sum = 0;
  let pairs = 0;

  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const score = jaccardSimilarity(sets[i], sets[j]);
      sum += score;
      pairs++;
    }
  }

  const avgSim = pairs ? sum / pairs : 0;
  const div = 1 - avgSim;

  return Math.round(div * 100);
}

function extractGeo(title, articles) {
  const text = [title, ...articles.map((a) => a.headline)]
    .join(" ")
    .toLowerCase();

  const places = [
    "united states",
    "usa",
    "greenland",
    "denmark",
    "china",
    "taiwan",
    "russia",
    "ukraine",
    "israel",
    "pakistan",
    "india",
    "uk",
    "england",
    "europe",
  ];

  const found = [];

  for (const place of places) {
    if (text.includes(place) && !found.includes(place)) {
      found.push(place);
    }
  }

  const formatted = found.map((p) =>
    p
      .split(" ")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" "),
  );

  return {
    regions: formatted,
    primaryRegion: formatted[0] || "Unknown",
  };
}

function normalizeRegionFromText(headline = "", summary = "", sourceName = "") {
  const text = (headline + " " + (summary || "")).toLowerCase();

  // Source-based region inference — catches local stories that don't name their own country
  const src = sourceName.toLowerCase();
  if (
    /vanguard|premium times|businessday nigeria|day nigeria|citi newsroom/.test(
      src,
    )
  )
    return "Africa";
  if (
    /daily nation|east african|mail.*guardian|ewn|ethiopian monitor|newsday zimbabwe|daily maverick/.test(
      src,
    )
  )
    return "Africa";
  if (
    /dawn pakistan|tribune pakistan|daily star bangladesh|the print/.test(src)
  )
    return "Asia";
  if (
    /bangkok post|jakarta post|rappler|vnexpress|phnom penh|colombo|my republica/.test(
      src,
    )
  )
    return "Asia";
  if (/south china morning|straits times|japan times|korea herald/.test(src))
    return "Asia";
  if (
    /buenos aires|rio times|merco press|agencia brasil|el comercio|el espectador|prensa libre|confidencial|infobae|proceso/.test(
      src,
    )
  )
    return "Latin America";
  if (/stuff nz|rnz|nz herald|sbs australia|abc australia/.test(src))
    return "Oceania";
  if (
    /ukrinform|kyiv post|moscow times|baltic times|err.*estonia|lrt.*lithuania|radio prague|civil georgia|trend.*azerbaijan|akipress/.test(
      src,
    )
  )
    return "Europe";
  if (
    /arab news|gulf news|jordan times|daily sabah|kurdistan|rudaw|egypt independent/.test(
      src,
    )
  )
    return "Middle East";
  if (
    /euractiv|euronews|politico europe|swissinfo|ansa italy|emerging europe/.test(
      src,
    )
  )
    return "Europe";
  if (/cbc|globe and mail|national post|macleans/.test(src))
    return "North America";

  // Canonical buckets (simple prototype)
  const RULES = [
    {
      region: "Middle East",
      keys: [
        "israel",
        "iran",
        "gaza",
        "saudi",
        "yemen",
        "lebanon",
        "syria",
        "iraq",
        "qatar",
        "uae",
        "middle east",
      ],
    },
    {
      region: "Europe",
      keys: [
        "uk",
        "england",
        "france",
        "germany",
        "italy",
        "spain",
        "europe",
        "eu",
        "poland",
        "sweden",
        "norway",
        "ukraine",
        "russia",
      ],
    },
    {
      region: "North America",
      keys: [
        "united states",
        "usa",
        "canada",
        "mexico",
        "washington",
        "new york",
        "california",
      ],
    },
    {
      region: "Asia",
      keys: [
        "china",
        "taiwan",
        "japan",
        "korea",
        "india",
        "pakistan",
        "philippines",
        "indonesia",
        "thailand",
        "asia",
      ],
    },
    {
      region: "Africa",
      keys: [
        "africa",
        "nigeria",
        "ghana",
        "kenya",
        "ethiopia",
        "egypt",
        "south africa",
        "sudan",
      ],
    },
    {
      region: "Latin America",
      keys: [
        "brazil",
        "argentina",
        "chile",
        "colombia",
        "peru",
        "mexico",
        "latin america",
      ],
    },
    { region: "Oceania", keys: ["australia", "new zealand", "oceania"] },
  ];

  for (const rule of RULES) {
    if (rule.keys.some((k) => text.includes(k))) return rule.region;
  }

  return "Other";
}

function misinfoHeuristic(cluster) {
  const flags = [];
  const sources = new Set(cluster.articles.map((a) => a.source)).size;

  const text = (cluster.title || "").toLowerCase();

  const sensational = [
    "shocking",
    "exposed",
    "secret",
    "hoax",
    "conspiracy",
    "miracle",
    "they dont want you",
  ];

  if (sensational.some((w) => text.includes(w))) {
    flags.push("Sensational language");
  }

  if (sources <= 1 && cluster.articles.length <= 1) {
    flags.push("Single-source cluster");
  }

  if (cluster.ratio >= 2 && sources <= 1) {
    flags.push("Spike without corroboration");
  }

  let score = 15;

  if (flags.includes("Sensational language")) score += 25;
  if (flags.includes("Single-source cluster")) score += 35;
  if (flags.includes("Spike without corroboration")) score += 15;

  if (sources >= 3) score -= 20;

  score = Math.max(0, Math.min(100, score));

  return { score, flags };
}

function makeClusterKey(headline) {
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

  // take top 5 strongest words
  return text.slice(0, 5).sort().join("-");
}

function tokenSetForHeadline(headline = "") {
  const stop = new Set([
    "the",
    "a",
    "an",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "and",
    "or",
    "at",
    "by",
    "from",
    "after",
    "before",
    "as",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "will",
    "would",
    "can",
    "could",
    "should",
    "may",
    "might",
    "says",
    "say",
    "said",
    "new",
    "live",
    "latest",
    "update",
  ]);

  const cleaned = headline
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned
    .split(" ")
    .filter((t) => t.length >= 4 && !stop.has(t)); // >=4 makes it stricter + cleaner

  return new Set(tokens);
}

function jaccardSimilarity(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function findBestExistingClusterKey(headline, clusters) {
  const currentTokens = tokenSetForHeadline(headline);
  if (currentTokens.size === 0) return null;

  let bestKey = null;
  let bestScore = 0;

  // Scan existing clusters and find the closest match
  for (const [key, c] of Object.entries(clusters)) {
    if (!c || !c._tokens) continue;

    const score = jaccardSimilarity(currentTokens, c._tokens);

    // threshold: 0.60 is a strong "same story" signal
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  return bestScore >= 0.6 ? bestKey : null;
}

/* ===========================
   Simple Prototype Clustering
=========================== */

let cachedClusters = null;
let cachedClustersTime = 0;

app.get("/clusters", async (req, res) => {
  if (cachedClusters && Date.now() - cachedClustersTime < 120000) {
    return res.json(cachedClusters);
  }

  try {
    const result = await pool.query(`
      SELECT headline, summary, source_name, published_at, initial_score
      FROM candidates
      WHERE status != 'ignored'
      AND published_at > NOW() - INTERVAL '12 hours'
    `);

    const rows = result.rows;
    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    // Basic keyword clustering
    const clusters = {};

    for (const row of rows) {
      let key =
        makeClusterKey(row.headline) || row.headline.toLowerCase().slice(0, 60);

      // If this key isn't seen yet, try merging into an existing cluster by similarity
      if (!clusters[key]) {
        const best = findBestExistingClusterKey(row.headline, clusters);
        if (best) key = best;
      }

      if (!clusters[key]) {
        clusters[key] = {
          title: row.headline,
          sources: new Set(),
          articles: 0,
          totalScore: 0,
          recent: 0,
          previous: 0,
          _tokens: tokenSetForHeadline(row.headline), // store signature for future merges
        };
      }

      clusters[key].sources.add(row.source_name);
      clusters[key].articles += 1;
      clusters[key].totalScore += row.initial_score || 0;

      const published = new Date(row.published_at);

      if (published > sixHoursAgo) {
        clusters[key].recent += 1;
      } else {
        clusters[key].previous += 1;
      }
    }

    function mergeSimilarClusters(clusterMap) {
      const keys = Object.keys(clusterMap);
      const merged = {};

      for (let i = 0; i < keys.length; i++) {
        let baseKey = keys[i];

        if (!clusterMap[baseKey]) continue;

        merged[baseKey] = clusterMap[baseKey];

        for (let j = i + 1; j < keys.length; j++) {
          const compareKey = keys[j];
          if (!clusterMap[compareKey]) continue;

          const baseTokens = baseKey.split("-");
          const compareTokens = compareKey.split("-");

          const overlap = baseTokens.filter((t) =>
            compareTokens.includes(t),
          ).length;

          if (overlap >= 2) {
            // merge clusters
            merged[baseKey].articles += clusterMap[compareKey].articles;
            merged[baseKey].recent += clusterMap[compareKey].recent;
            merged[baseKey].previous += clusterMap[compareKey].previous;

            clusterMap[compareKey] = null;
          }
        }
      }

      return merged;
    }

    const mergedClusters = mergeSimilarClusters(clusters);

    const formatted = Object.entries(mergedClusters)
      .map(([key, value]) => {
        const velocity = value.recent;
        const baseline = value.previous || 1; // prevent divide by zero
        const ratio = velocity / baseline;

        let momentum = "stable";

        if (velocity >= 2 && ratio >= 2) {
          momentum = "accelerating";
        } else if (ratio >= 1.3) {
          momentum = "rising";
        } else if (ratio < 0.7) {
          momentum = "falling";
        } else if (velocity === 0) {
          momentum = "cooling";
        }

        const signalStrength =
          value.recent * 3 +
          value.previous +
          ratio * 4 +
          (momentum === "accelerating" ? 6 : 0) +
          (momentum === "rising" ? 3 : 0);

        const sourceCount = value.sources.size;
        const sourceDiversity = Math.round(
          (sourceCount / value.articles) * 100,
        );

        // Basic divergence detection
        const articlesForCheck = rows
          .filter((r) => {
            const k =
              makeClusterKey(r.headline) ||
              r.headline.toLowerCase().slice(0, 60);
            return k === key;
          })
          .map((r) => ({
            headline: r.headline,
            source: r.source_name,
          }));

        const divergent = findDivergent(articlesForCheck);
        const divScore = divergenceScore(articlesForCheck);

        // safest: score drives the flag, but keep old logic as fallback
        const hasDivergence = divScore >= 60 && sourceCount >= 2;

        return {
          slug: key.replace(/[^a-z0-9]+/g, "-"),
          title: value.title,
          sources: sourceCount,
          sourceCount: sourceCount,
          sourceDiversity: sourceDiversity,
          articles: value.articles,
          avgScore: Math.round(value.totalScore / value.articles),
          recent: value.recent,
          previous: value.previous,
          ratio: Number(ratio.toFixed(2)),
          signalStrength,
          momentum,
          divergenceScore: divScore,
          hasDivergence,
        };
      })
      .sort((a, b) => b.signalStrength - a.signalStrength)
      .slice(0, 20);

    cachedClusters = formatted;
    cachedClustersTime = Date.now();

    res.json(formatted);
  } catch (err) {
    console.error("Cluster error:", err);
    res.status(500).json({ error: "Cluster failed" });
  }
});

/* ===========================
   CLUSTER DETAIL
=========================== */

app.get("/clusters/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const result = await pool.query(`
      SELECT id, headline, summary, source_name, source_url, published_at, initial_score
      FROM candidates
      WHERE status != 'ignored'
      AND published_at > NOW() - INTERVAL '12 hours'
    `);

    const rows = result.rows;
    const clusters = {};
    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    for (const row of rows) {
      const key =
        makeClusterKey(row.headline) || row.headline.toLowerCase().slice(0, 60);

      const keySlug = key.replace(/[^a-z0-9]+/g, "-");

      if (!clusters[keySlug]) {
        clusters[keySlug] = {
          title: row.headline,
          articles: [],
          recent: 0,
          previous: 0,
        };
      }

      clusters[keySlug].articles.push({
        id: row.id,
        headline: row.headline,
        summary: row.summary,
        source: row.source_name,
        url: row.source_url,
        published_at: row.published_at,
        score: row.initial_score,
      });

      const published = new Date(row.published_at);

      if (published > sixHoursAgo) {
        clusters[keySlug].recent += 1;
      } else {
        clusters[keySlug].previous += 1;
      }
    }

    const cluster = clusters[slug];

    if (!cluster) {
      return res.status(404).json({ error: "Cluster not found" });
    }

    const velocity = cluster.recent;
    const baseline = cluster.previous || 1;
    const ratio = velocity / baseline;

    let momentum = "stable";

    if (velocity >= 2 && ratio >= 2) {
      momentum = "accelerating";
    } else if (ratio >= 1.3) {
      momentum = "rising";
    } else if (ratio < 0.7) {
      momentum = "falling";
    } else if (velocity === 0) {
      momentum = "cooling";
    }

    const signalStrength =
      velocity * 3 +
      cluster.previous +
      ratio * 4 +
      (momentum === "accelerating" ? 6 : 0) +
      (momentum === "rising" ? 3 : 0);

    function buildNarrativeSummary(cluster) {
      const sources = new Set(cluster.articles.map((a) => a.source)).size;
      const newest = cluster.articles[0];
      const oldest = cluster.articles[cluster.articles.length - 1];

      const timeSpan =
        newest?.published_at && oldest?.published_at
          ? `${new Date(oldest.published_at).toISOString().slice(11, 16)}–${new Date(newest.published_at).toISOString().slice(11, 16)}Z`
          : "";

      // Simple, deterministic summary (no AI yet)
      return `This cluster groups ${cluster.articles.length} related reports from ${sources} source(s) ${timeSpan ? `(${timeSpan})` : ""}. It centers on: ${cluster.title}.`;
    }

    function buildKeyPoints(cluster) {
      // Take top 3 distinct headlines (avoid repeats)
      const seen = new Set();
      const pts = [];
      for (const a of cluster.articles) {
        const h = (a.headline || "").trim();
        const k = h.toLowerCase();
        if (!h || seen.has(k)) continue;
        seen.add(k);
        pts.push(h);
        if (pts.length >= 4) break;
      }
      return pts;
    }

    cluster.ratio = Number(ratio.toFixed(2));
    cluster.momentum = momentum;
    cluster.signalStrength = signalStrength;

    cluster.sourceCount = new Set(cluster.articles.map((a) => a.source)).size;

    cluster.sourceDiversity = Math.round(
      (cluster.sourceCount / cluster.articles.length) * 100,
    );

    cluster.articles.sort(
      (a, b) => new Date(b.published_at) - new Date(a.published_at),
    );

    cluster.narrativeSummary = buildNarrativeSummary(cluster);
    cluster.keyPoints = buildKeyPoints(cluster);
    cluster.confidence =
      new Set(cluster.articles.map((a) => a.source)).size >= 3 &&
      cluster.articles.length >= 3
        ? "high"
        : cluster.articles.length >= 2
          ? "medium"
          : "low";

    cluster.divergent = findDivergent(cluster.articles);

    cluster.divergenceScore = divergenceScore(cluster.articles);
    cluster.hasDivergence =
      cluster.divergenceScore >= 60 && cluster.sourceCount >= 2;

    const geo = extractGeo(cluster.title, cluster.articles);
    cluster.regions = geo.regions;
    cluster.primaryRegion = geo.primaryRegion;

    const risk = misinfoHeuristic(cluster);
    cluster.misinfoRisk = risk.score;
    cluster.misinfoFlags = risk.flags;

    res.json(cluster);
  } catch (err) {
    console.error("Cluster detail error:", err);
    res.status(500).json({ error: "Cluster detail failed" });
  }
});

const overviewCache = {};
const overviewCacheTime = {};
const OVERVIEW_TTL = 2 * 60 * 1000; // 2 minutes per window

/* ===========================
   SIGNALS OVERVIEW (MACRO INTELLIGENCE)
   + Dynamic window support (6h / 24h / 72h)
   + Keeps full NPI/MacroRisk/Geo/Strategic logic
=========================== */

app.get("/signals/overview", async (req, res) => {
  try {
    // 🟢 Window control (default 24h)
    const windowParam = String(req.query.window || "24h").toLowerCase();

    // Serve from cache if fresh
    if (
      overviewCache[windowParam] &&
      Date.now() - overviewCacheTime[windowParam] < OVERVIEW_TTL
    ) {
      return res.json(overviewCache[windowParam]);
    }

    // "Recent" window used for velocity/acceleration
    let recentHours = 24;
    if (windowParam === "6h") recentHours = 6;
    if (windowParam === "72h") recentHours = 72;

    // IMPORTANT: Always fetch enough history to compute "previous" + baselines.
    // If you fetch only 6h, previous becomes 0 and ratios blow up.
    // So we keep a stable lookback (3 days) and apply the window in logic.
    const fetchIntervalSQL = `${recentHours * 2} hours`; // 6h->12h, 24h->48h, 72h->144h

    const result = await pool.query(`
      SELECT headline, summary, published_at, source_name
      FROM candidates
      WHERE status != 'ignored'
      AND published_at > NOW() - INTERVAL '${fetchIntervalSQL}'
    `);

    const rows = result.rows || [];
    const now = new Date();

    // Recent window boundary (dynamic)
    const recentWindowAgo = new Date(
      now.getTime() - recentHours * 60 * 60 * 1000,
    );

    const previousWindowAgo = new Date(
      now.getTime() - recentHours * 2 * 60 * 60 * 1000,
    );

    // -----------------------------
    // 24H STRUCTURAL BASELINE (kept as you wrote it)
    // -----------------------------
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    let total24h = 0;

    for (const row of rows) {
      const published = new Date(row.published_at);
      if (published > twentyFourHoursAgo) total24h++;
    }

    const clusters = {};

    // Build a fast lookup: clusterKey -> list of rows (for divergence + strategic scoring)
    const rowsByCluster = new Map();
    for (const row of rows) {
      const key = makeClusterKey(row.headline || "");
      if (!rowsByCluster.has(key)) rowsByCluster.set(key, []);
      rowsByCluster.get(key).push(row);
    }

    const regionCounts = {};

    // Geo detection places (as in your code)
    const places = [
      // North America
      "united states",
      "usa",
      "canada",
      "mexico",
      // Latin America
      "brazil",
      "argentina",
      "chile",
      "colombia",
      "peru",
      // Europe
      "united kingdom",
      "britain",
      "england",
      "france",
      "germany",
      "italy",
      "spain",
      "ukraine",
      "russia",
      // Middle East
      "israel",
      "iran",
      "saudi arabia",
      "saudi",
      // Asia
      "china",
      "taiwan",
      "india",
      "pakistan",
      "japan",
      // Africa
      "nigeria",
      "kenya",
      "ghana",
      "south africa",
      "ethiopia",
      "egypt",
      // Arctic
      "greenland",
      "denmark",
    ];

    // Canonical naming (define once)
    const CANON = {
      usa: "United States",
      "united states": "United States",
      uk: "UK",
      "united kingdom": "UK",
      britain: "UK",
      england: "UK",
      "south africa": "South Africa",
      "saudi arabia": "Saudi Arabia",
    };

    // Count regions + compute recent/previous per cluster
    for (const row of rows) {
      const key =
        makeClusterKey(row.headline) || row.headline.toLowerCase().slice(0, 60);

      const text = (
        String(row.headline || "") +
        " " +
        String(row.summary || "")
      ).toLowerCase();

      for (const place of places) {
        const escaped = place.replace(/\s+/g, "\\s+");
        const regex = new RegExp(`\\b${escaped}\\b`, "i");
        if (!regex.test(text)) continue;

        const formatted =
          CANON[place] ||
          place
            .split(" ")
            .map((w) => w[0].toUpperCase() + w.slice(1))
            .join(" ");

        regionCounts[formatted] = (regionCounts[formatted] || 0) + 1;
      }

      if (!clusters[key]) {
        clusters[key] = { recent: 0, previous: 0 };
      }

      const published = new Date(row.published_at);

      // ✅ This is now window-aware
      if (published > recentWindowAgo) {
        clusters[key].recent += 1; // last X hours
      } else if (published > previousWindowAgo) {
        clusters[key].previous += 1; // the X hours before that
      } else {
        // older than 2X window — ignore (shouldn't happen because SQL already filters)
      }
    }

    const strongClusters = [];

    for (const key of Object.keys(clusters)) {
      const c = clusters[key];
      const totalArticles = c.recent + c.previous;

      if (totalArticles < 2) continue;

      const baseline = c.previous || 1;
      const ratio = c.recent / baseline;

      // compute divergence for this cluster
      const clusterRows = rowsByCluster.get(key) || [];
      const divScore = divergenceScore(
        clusterRows.map((r) => ({ headline: r.headline })),
      );

      const clusterTitle = clusterRows[0]?.headline || key;

      strongClusters.push({
        key,
        title: clusterTitle,
        recent: c.recent,
        previous: c.previous,
        ratio,
        divergenceScore: divScore,
      });
    }

    let totalRecent = 0;
    let totalRatio = 0;
    let acceleratingCount = 0;

    for (const c of strongClusters) {
      const baseline = c.previous || 1;
      const ratio = c.recent / (baseline + 2);

      totalRecent += c.recent;
      totalRatio += ratio;

      if (c.recent >= 2 && ratio >= 2) acceleratingCount += 1;
    }

    // Normalize recent count by window size
    const windowFactor = recentHours / 24; // 24h = 1, 72h = 3
    const normalizedRecent = Math.min(totalRecent / windowFactor, 50);

    const avgRatio =
      strongClusters.length > 0 ? totalRatio / strongClusters.length : 0;

    // Weight acceleration ratio more heavily; volume is secondary
    let velocityIndex =
      avgRatio * 20 + acceleratingCount * 8 + normalizedRecent * 0.5;
    velocityIndex = Math.round(Math.max(0, Math.min(100, velocityIndex)));

    // Economic Risk Pulse — scored from full headline/summary content
    const ECON_HIGH = [
      "oil price",
      "crude oil",
      "brent",
      "wti",
      "opec",
      "interest rate",
      "rate hike",
      "rate cut",
      "federal reserve",
      "inflation",
      "recession",
      "bond yield",
      "currency crisis",
      "devaluation",
      "debt default",
      "sovereign debt",
    ];
    const ECON_MED = [
      "tariff",
      "trade war",
      "sanction",
      "banking crisis",
      "market crash",
      "stock market",
      "nasdaq",
      "ftse",
      "gdp",
      "energy price",
      "gas price",
      "supply chain",
      "unemployment",
      "trade deficit",
      "central bank",
    ];
    const CREDIBLE_SOURCES = [
      "Reuters",
      "BBC",
      "Financial Times",
      "Bloomberg",
      "Associated Press",
      "Wall Street Journal",
    ];

    // Score each article in the already-fetched rows array (no extra DB query)
    // Window-aware: only count articles within the active window
    let econRaw = 0;
    for (const row of rows) {
      const published = new Date(row.published_at);
      if (published <= recentWindowAgo) continue; // only score within active window
      const text = (
        (row.headline || "") +
        " " +
        (row.summary || "")
      ).toLowerCase();
      let hit = 0;
      for (const kw of ECON_HIGH) {
        if (text.includes(kw)) {
          hit = 3;
          break;
        }
      }
      if (!hit)
        for (const kw of ECON_MED) {
          if (text.includes(kw)) {
            hit = 1;
            break;
          }
        }
      if (hit) {
        const credBoost = CREDIBLE_SOURCES.includes(row.source_name) ? 1.5 : 1;
        econRaw += hit * credBoost;
      }
    }

    // Keep cluster-level econ acceleration as a secondary signal
    const econClusters = strongClusters.filter((c) =>
      /inflation|rate|trade|tariff|oil|gas|market|bank|sanction|recession|currency|bond|economy/.test(
        c.key,
      ),
    );
    const econAccelerating = econClusters.filter(
      (c) => c.recent >= 2 && c.recent / (c.previous || 1) >= 2,
    ).length;

    // Normalise to 0-100: article content (max 55) + cluster acceleration (max 45)
    let riskScore =
      Math.min(55, econRaw * 1.2) +
      econAccelerating * 15 +
      (econClusters.length > 0 ? 5 : 0);
    riskScore = Math.round(Math.max(0, Math.min(100, riskScore)));

    // REGION COORDS (kept)
    const REGION_COORDS = {
      // North America
      "United States": { lat: 39.8283, lng: -98.5795 },
      USA: { lat: 39.8283, lng: -98.5795 },
      US: { lat: 39.8283, lng: -98.5795 },
      America: { lat: 39.8283, lng: -98.5795 },
      Canada: { lat: 45.4215, lng: -75.6972 },
      Mexico: { lat: 19.4326, lng: -99.1332 },

      // South America
      Brazil: { lat: -15.7939, lng: -47.8828 },
      Argentina: { lat: -34.6037, lng: -58.3816 },
      Chile: { lat: -33.4489, lng: -70.6693 },
      Colombia: { lat: 4.711, lng: -74.0721 },
      Peru: { lat: -12.0464, lng: -77.0428 },
      Venezuela: { lat: 6.4238, lng: -66.5897 },
      Ecuador: { lat: -1.8312, lng: -78.1834 },
      Bolivia: { lat: -16.2902, lng: -63.5887 },
      Paraguay: { lat: -23.4425, lng: -58.4438 },
      Uruguay: { lat: -32.5228, lng: -55.7658 },

      // Europe
      UK: { lat: 51.5074, lng: -0.1278 },
      "United Kingdom": { lat: 51.5074, lng: -0.1278 },
      Britain: { lat: 51.5074, lng: -0.1278 },
      England: { lat: 51.5074, lng: -0.1278 },
      Scotland: { lat: 56.4907, lng: -4.2026 },
      Wales: { lat: 52.1307, lng: -3.7837 },
      France: { lat: 48.8566, lng: 2.3522 },
      Germany: { lat: 52.52, lng: 13.405 },
      Italy: { lat: 41.9028, lng: 12.4964 },
      Spain: { lat: 40.4168, lng: -3.7038 },
      Portugal: { lat: 38.7223, lng: -9.1393 },
      Netherlands: { lat: 52.3676, lng: 4.9041 },
      Belgium: { lat: 50.8503, lng: 4.3517 },
      Switzerland: { lat: 46.8182, lng: 8.2275 },
      Austria: { lat: 47.5162, lng: 14.5501 },
      Sweden: { lat: 60.1282, lng: 18.6435 },
      Norway: { lat: 60.472, lng: 8.4689 },
      Denmark: { lat: 56.2639, lng: 9.5018 },
      Finland: { lat: 61.9241, lng: 25.7482 },
      Poland: { lat: 52.2297, lng: 21.0122 },
      Ukraine: { lat: 50.4501, lng: 30.5234 },
      Russia: { lat: 55.7558, lng: 37.6173 },
      Turkey: { lat: 39.9334, lng: 32.8597 },
      Greece: { lat: 39.0742, lng: 21.8243 },
      Romania: { lat: 45.9432, lng: 24.9668 },
      Hungary: { lat: 47.1625, lng: 19.5033 },
      Czech: { lat: 49.8175, lng: 15.473 },
      Serbia: { lat: 44.0165, lng: 21.0059 },

      // Middle East
      Israel: { lat: 31.7683, lng: 35.2137 },
      Iran: { lat: 35.6892, lng: 51.389 },
      Saudi: { lat: 24.7136, lng: 46.6753 },
      "Saudi Arabia": { lat: 24.7136, lng: 46.6753 },
      "Middle East": { lat: 33, lng: 44 },
      Iraq: { lat: 33.3152, lng: 44.3661 },
      Syria: { lat: 34.8021, lng: 38.9968 },
      Lebanon: { lat: 33.8547, lng: 35.8623 },
      Yemen: { lat: 15.5527, lng: 48.5164 },
      Jordan: { lat: 30.5852, lng: 36.2384 },
      Qatar: { lat: 25.3548, lng: 51.1839 },
      UAE: { lat: 23.4241, lng: 53.8478 },
      "United Arab Emirates": { lat: 23.4241, lng: 53.8478 },
      Kuwait: { lat: 29.3117, lng: 47.4818 },
      Bahrain: { lat: 26.0667, lng: 50.5577 },
      Oman: { lat: 21.4735, lng: 55.9754 },

      // Asia
      China: { lat: 39.9042, lng: 116.4074 },
      Taiwan: { lat: 25.033, lng: 121.5654 },
      India: { lat: 28.6139, lng: 77.209 },
      Pakistan: { lat: 33.6844, lng: 73.0479 },
      Japan: { lat: 35.6762, lng: 139.6503 },
      "South Korea": { lat: 37.5665, lng: 126.978 },
      Korea: { lat: 37.5665, lng: 126.978 },
      "North Korea": { lat: 39.0392, lng: 125.7625 },
      Indonesia: { lat: -6.2088, lng: 106.8456 },
      Malaysia: { lat: 4.2105, lng: 101.9758 },
      Philippines: { lat: 12.8797, lng: 121.774 },
      Vietnam: { lat: 14.0583, lng: 108.2772 },
      Thailand: { lat: 15.87, lng: 100.9925 },
      Bangladesh: { lat: 23.685, lng: 90.3563 },
      Afghanistan: { lat: 33.9391, lng: 67.7099 },
      Myanmar: { lat: 21.9162, lng: 95.956 },
      Singapore: { lat: 1.3521, lng: 103.8198 },
      "Sri Lanka": { lat: 7.8731, lng: 80.7718 },
      Nepal: { lat: 28.3949, lng: 84.124 },
      Kazakhstan: { lat: 48.0196, lng: 66.9237 },
      Australia: { lat: -25.2744, lng: 133.7751 },
      "New Zealand": { lat: -40.9006, lng: 174.886 },

      // Africa
      Nigeria: { lat: 9.0765, lng: 7.3986 },
      Kenya: { lat: -1.2921, lng: 36.8219 },
      Ghana: { lat: 5.6037, lng: -0.187 },
      "South Africa": { lat: -25.7479, lng: 28.2293 },
      Egypt: { lat: 30.0444, lng: 31.2357 },
      Ethiopia: { lat: 9.145, lng: 40.4897 },
      Sudan: { lat: 12.8628, lng: 30.2176 },
      Tanzania: { lat: -6.369, lng: 34.8888 },
      Uganda: { lat: 1.3733, lng: 32.2903 },
      Mozambique: { lat: -18.6657, lng: 35.5296 },
      Zimbabwe: { lat: -19.0154, lng: 29.1549 },
      Zambia: { lat: -13.1339, lng: 27.8493 },
      Angola: { lat: -11.2027, lng: 17.8739 },
      Cameroon: { lat: 7.3697, lng: 12.3547 },
      Somalia: { lat: 5.1521, lng: 46.1996 },
      Libya: { lat: 26.3351, lng: 17.2283 },
      Algeria: { lat: 28.0339, lng: 1.6596 },
      Morocco: { lat: 31.7917, lng: -7.0926 },
      Tunisia: { lat: 33.8869, lng: 9.5375 },
      Mali: { lat: 17.5707, lng: -3.9962 },
      Niger: { lat: 17.6078, lng: 8.0817 },
      Senegal: { lat: 14.4974, lng: -14.4524 },
      Congo: { lat: -4.0383, lng: 21.7587 },
      Rwanda: { lat: -1.9403, lng: 29.8739 },
    };

    const regionalSpread = Object.entries(regionCounts)
      .map(([region, count]) => {
        const coords = REGION_COORDS[region];
        if (!coords) return null;
        return { region, count, lat: coords.lat, lng: coords.lng };
      })
      .filter(Boolean);

    // =============================
    // STRATEGIC INTENSITY RANKING (kept)
    // =============================

    const strategicScoreByCountry = Object.create(null);

    function titleCase(s) {
      return s
        .split(" ")
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ");
    }

    for (const c of strongClusters) {
      const isAccelerating = (c.ratio || 0) >= 2 && (c.recent || 0) >= 2;
      const isDivergent = (c.divergenceScore || 0) >= 60;
      if (!isAccelerating) continue;

      const clusterRows = rowsByCluster.get(c.key) || [];
      if (clusterRows.length === 0) continue;

      const volumeW = Math.min(20, clusterRows.length);
      const accelW = isAccelerating ? Math.min(4, c.ratio || 1) : 1;
      const divW = 1 + Math.min(1, (c.divergenceScore || 0) / 100);

      const clusterWeight = volumeW * accelW * divW;

      // Determine the cluster's primary region
      const clusterRegion = normalizeRegionFromText(
        clusterRows[0]?.headline || "",
        clusterRows[0]?.summary || "",
        clusterRows[0]?.source_name || "",
      );

      for (const row of clusterRows) {
        const headline = String(row.headline || "").toLowerCase();

        for (const place of places.filter((p) => p !== "greenland")) {
          if (!headline.includes(place)) continue;

          const escaped = place.replace(/\s+/g, "\\s+");
          const regex = new RegExp(`\\b${escaped}\\b`, "i");
          if (!regex.test(headline)) continue;

          // Gate: only score countries that belong to the cluster's region
          const placeRegion = normalizeRegionFromText(place, "", "");
          if (placeRegion !== "Other" && placeRegion !== clusterRegion)
            continue;

          const formatted = CANON[place] || titleCase(place);

          strategicScoreByCountry[formatted] =
            (strategicScoreByCountry[formatted] || 0) + clusterWeight;
        }
      }
    }

    const strategicIntensityRanking = Object.entries(strategicScoreByCountry)
      .map(([country, score]) => ({ country, score: Math.round(score) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    // -----------------------------
    // NARRATIVE PRESSURE INDEX (NPI) (kept)
    // -----------------------------
    // Normalize components

    const volumeScore = Math.min(25, Math.log(total24h + 1) * 8);
    const accelerationScore = Math.min(25, avgRatio * 10);
    const accelerationDensity = Math.min(25, acceleratingCount * 5);
    const geoSpreadScore = Math.min(25, regionalSpread.length * 3);

    let npi =
      volumeScore + accelerationScore + accelerationDensity + geoSpreadScore;

    npi = Math.round(Math.max(0, Math.min(100, npi)));

    let stabilizedVelocity =
      volumeScore * 0.4 + accelerationScore * 0.3 + accelerationDensity * 0.3;

    stabilizedVelocity = Math.round(
      Math.max(0, Math.min(100, stabilizedVelocity)),
    );

    let macroRisk =
      npi * 0.6 + acceleratingCount * 5 + regionalSpread.length * 4;
    macroRisk = Math.round(Math.max(0, Math.min(100, macroRisk)));

    const geopoliticalPressure = regionalSpread
      .map((r) => {
        const baseVolume = r.count;

        const narrativePressure = Math.round(
          baseVolume * 0.6 + velocityIndex * 0.2,
        );
        const riskPressure = Math.round(
          baseVolume * 0.5 + acceleratingCount * 3,
        );
        const strategicPressure = Math.round(
          baseVolume * 0.5 + (strongClusters[0]?.divergenceScore || 0) * 0.3,
        );
        const marketPressure = Math.round(baseVolume * 0.4 + riskScore * 2);

        return {
          region: r.region,
          narrativePressure,
          riskPressure,
          strategicPressure,
          marketPressure,
        };
      })
      .sort((a, b) => b.narrativePressure - a.narrativePressure);

    function generateNarrativeSummary(regions, velocityIndex) {
      if (!regions || regions.length === 0) {
        return "No significant regional narrative concentration detected.";
      }

      const top = regions[0];
      const second = regions[1];

      let sentence = `Current narrative pressure is concentrated in ${top.region}`;
      if (second)
        sentence += `, with secondary activity observed in ${second.region}`;
      sentence += `. `;

      if (velocityIndex >= 50) {
        sentence += "Signal acceleration suggests escalating developments.";
      } else if (velocityIndex >= 20) {
        sentence +=
          "Narratives are building steadily across monitored regions.";
      } else {
        sentence += "Overall signal velocity remains contained.";
      }

      return sentence;
    }

    const narrativeSummary = generateNarrativeSummary(
      geopoliticalPressure,
      velocityIndex,
    );

    // 🔥 Build narrative breakdown
    const narrativeMap = {};

    strongClusters.forEach((c) => {
      const text = (c.title || c.key).toLowerCase();
      let label = "Global";

      if (
        /iran|israel|gaza|middle east|lebanon|houthi|hormuz|syria|iraq/.test(
          text,
        )
      )
        label = "Middle East";
      else if (
        /ukraine|russia|nato|europe|poland|germany|france|uk|britain/.test(text)
      )
        label = "Europe";
      else if (
        /china|taiwan|korea|japan|asia|india|pakistan|beijing/.test(text)
      )
        label = "Asia";
      else if (
        /trump|us|america|united states|washington|congress|fed/.test(text)
      )
        label = "Americas";
      else if (/africa|nigeria|kenya|ethiopia|sudan|ghana|egypt/.test(text))
        label = "Africa";

      if (!narrativeMap[label]) {
        narrativeMap[label] = 0;
      }

      narrativeMap[label] += c.recent + c.previous;
    });

    const narrativeBreakdown = Object.entries(narrativeMap)
      .map(([label, score]) => ({ label, score }))
      .sort((a, b) => b.score - a.score);

    // Find snapshot from ~24h ago for delta comparison
    const now24 = new Date();
    const target24h = new Date(now24.getTime() - 24 * 60 * 60 * 1000);
    const snap24 = overviewSnapshots.find(
      (s) => Math.abs(s.time - target24h) < 60 * 60 * 1000,
    );

    const velocityDelta = snap24
      ? Math.round(
          ((totalRecent - snap24.velocityProxy) /
            Math.max(1, snap24.velocityProxy)) *
            100,
        )
      : null;

    const econArticleCount = econClusters.length;

    const econDelta = snap24
      ? Math.round(
          ((econArticleCount - snap24.econProxy) /
            Math.max(1, snap24.econProxy)) *
            100,
        )
      : null;

    // ── Narrative Watch: find stories absent from major blocs ──
    const WATCH_BLOC_MAP = {
      BBC: "Western",
      CNN: "Western",
      NBC: "Western",
      ABC: "Western",
      "New York Times": "Western",
      "Washington Post": "Western",
      Guardian: "Western",
      "Financial Times": "Western",
      Reuters: "Western",
      "Associated Press": "Western",
      Sky: "Western",
      Independent: "Western",
      Axios: "Western",
      NPR: "Western",
      DW: "Western",
      "Al Jazeera": "Gulf",
      "Arab News": "Gulf",
      "Gulf News": "Gulf",
      "Times of Israel": "Gulf",
      "Jerusalem Post": "Gulf",
      "Al-Monitor": "Gulf",
      RT: "Eastern",
      "Moscow Times": "Eastern",
      Xinhua: "Eastern",
      "South China Morning Post": "Eastern",
      Ukrinform: "Eastern",
      "The Hindu": "Asian",
      Dawn: "Asian",
      "Bangkok Post": "Asian",
      "Japan Times": "Asian",
      "Korea Herald": "Asian",
      AllAfrica: "African",
      "Vanguard Nigeria": "African",
      "Daily Nation (Kenya)": "African",
      "Premium Times (Nigeria)": "African",
    };

    const narrativeWatch = [];
    const clusterBlocMap = new Map();

    for (const row of rows) {
      const published = new Date(row.published_at);
      if (published <= recentWindowAgo) continue;
      const key = makeClusterKey(row.headline || "");
      if (!key) continue;
      const bloc = WATCH_BLOC_MAP[row.source_name] || null;
      if (!bloc) continue;
      if (!clusterBlocMap.has(key))
        clusterBlocMap.set(key, { title: row.headline, blocs: {} });
      const entry = clusterBlocMap.get(key);
      entry.blocs[bloc] = (entry.blocs[bloc] || 0) + 1;
    }

    for (const [key, entry] of clusterBlocMap.entries()) {
      const blocs = entry.blocs;
      const total = Object.values(blocs).reduce((s, v) => s + v, 0);
      if (total < 3) continue;
      const dominantBloc = Object.entries(blocs).sort((a, b) => b[1] - a[1])[0];
      const missingBlocs = [
        "Western",
        "Gulf",
        "Eastern",
        "Asian",
        "African",
      ].filter((b) => !blocs[b]);
      if (dominantBloc[1] >= 3 && missingBlocs.length >= 2) {
        narrativeWatch.push({
          title: entry.title,
          dominantBloc: dominantBloc[0],
          dominantCount: dominantBloc[1],
          missingBlocs,
          suppressionScore: Math.round((missingBlocs.length / 5) * 100),
        });
      }
    }

    narrativeWatch.sort((a, b) => b.suppressionScore - a.suppressionScore);
    const narrativeWatchTop = narrativeWatch.slice(0, 5);

    // Global Tension Index
    const globalTensionIndex = Math.round(
      Math.min(
        100,
        velocityIndex * 0.3 +
          npi * 0.3 +
          riskScore * 0.2 +
          acceleratingCount * 4,
      ),
    );

    // Source Trust Layer — top outlets by volume + category focus
    const sourceTrustMap = {};
    for (const row of rows) {
      const published = new Date(row.published_at);
      if (published <= recentWindowAgo) continue;
      const src = row.source_name;
      if (!src) continue;
      if (!sourceTrustMap[src]) sourceTrustMap[src] = { count: 0 };
      sourceTrustMap[src].count++;
    }
    const sourceTrust = Object.entries(sourceTrustMap)
      .map(([name, d]) => ({ name, count: d.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Save to cache before responding
    const overviewPayload = {
      window: windowParam,
      velocityIndex,
      stabilizedVelocity,
      acceleratingCount,
      clusterCount: strongClusters.length,
      economicRisk: riskScore,
      macroRisk,
      npi,
      globalTensionIndex,
      regionalSpread,
      geopoliticalPressure,
      strategicIntensityRanking,
      narrativeSummary,
      narrativeBreakdown,
      narrativeWatch: narrativeWatchTop,
      sourceTrust,
      delta: {
        velocity: velocityDelta,
        econ: econDelta,
      },
    };
    overviewCache[windowParam] = overviewPayload;
    overviewCacheTime[windowParam] = Date.now();

    res.json(overviewPayload);
  } catch (err) {
    console.error("Signals overview error:", err);
    res.status(500).json({ error: "Signals overview failed" });
  }
});

/* ===========================
   SIGNALS FEED
=========================== */

app.get("/signals", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM signals
      WHERE published_at > NOW() - INTERVAL '12 hours'
      ORDER BY published_at DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Signals error:", err.message);
    res.status(500).json({ error: "Signals failed" });
  }
});

/* ===========================
   DEBUG REDDIT
=========================== */
app.get("/debug/reddit", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT source_name, headline, category, status, initial_score, discovered_at
      FROM candidates
      WHERE source_name ILIKE '%Reddit%'
      ORDER BY discovered_at DESC
      LIMIT 20;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Reddit debug error:", err);
    res.status(500).json({ error: "Debug failed" });
  }
});

/* ===========================
   DEBUG BBC
=========================== */
app.get("/debug/bbc", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT source_name, headline, category, initial_score
      FROM candidates
      WHERE source_name ILIKE '%BBC%'
      ORDER BY discovered_at DESC
      LIMIT 20;
    `);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Debug failed" });
  }
});

/* ===========================
   RSS INGEST ROUTE (MANUAL TRIGGER)
=========================== */

app.post("/ingest/rss", async (req, res) => {
  try {
    // 1️⃣ Journalism pipeline
    const newsResult = await ingestAllFeeds(pool);

    // 2️⃣ Signal pipeline (Reddit → signals table)
    const signalResult = await ingestAllSignals(pool);

    res.json({
      status: "ok",
      news: {
        inserted: newsResult.inserted,
        skipped: newsResult.skipped,
        feedsProcessed: newsResult.feeds,
      },
      signals: {
        inserted: signalResult.inserted,
      },
    });
  } catch (err) {
    console.error("RSS ingest failed:", err);
    res.status(500).json({ error: "RSS ingest failed" });
  }
});

/* ===========================
   REGION INTELLIGENCE DETAIL (24H)
=========================== */

function categoryWeight(cat = "") {
  const c = String(cat).toLowerCase();

  if (c.includes("geopolit") || c.includes("politic")) return 1.4;
  if (c.includes("econom")) return 1.3;
  if (c.includes("war") || c.includes("conflict") || c.includes("security"))
    return 1.6;
  if (c.includes("tech") || c.includes("cyber")) return 1.2;

  return 1.0;
}

const ECON_TRIGGERS = [
  "inflation",
  "interest rate",
  "rates",
  "bond",
  "yield",
  "oil",
  "gas",
  "brent",
  "wti",
  "opec",
  "sanction",
  "tariff",
  "currency",
  "devalue",
  "recession",
  "default",
  "bank",
  "banking",
  "stock",
  "market",
  "dow",
  "nasdaq",
  "ftse",
];

const regionDetailCache = new Map();

app.get("/signals/region/:region", async (req, res) => {
  const cacheKey = req.params.region.toLowerCase();
  const cached = regionDetailCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 3 * 60 * 1000) {
    return res.json(cached.data);
  }
  try {
    const regionName = req.params.region.toLowerCase();

    const result = await pool.query(`
      SELECT headline, summary, source_name, published_at, category
      FROM candidates
      WHERE status != 'ignored'
      AND published_at > NOW() - INTERVAL '24 hours'
    `);

    const rows = result.rows;

    const regionArticles = rows.filter((r) =>
      (r.headline + " " + (r.summary || "")).toLowerCase().includes(regionName),
    );

    const articleCount = regionArticles.length;

    let economicHits = 0;

    for (const r of regionArticles) {
      const text = (r.headline + " " + (r.summary || "")).toLowerCase();

      if (ECON_TRIGGERS.some((k) => text.includes(k))) {
        economicHits += 1;
      }
    }

    const economicTriggerLevel =
      economicHits >= 15
        ? "HIGH"
        : economicHits >= 6
          ? "ELEVATED"
          : economicHits >= 2
            ? "LOW"
            : "NONE";

    // Cluster logic reuse
    const clusters = {};
    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    for (const row of regionArticles) {
      const key =
        makeClusterKey(row.headline) || row.headline.toLowerCase().slice(0, 60);

      if (!clusters[key]) {
        clusters[key] = {
          articles: 0,
          recent: 0,
          previous: 0,
          sources: new Set(),
        };
      }

      clusters[key].articles += 1;
      clusters[key].sources.add(row.source_name);

      const published = new Date(row.published_at);

      if (published > sixHoursAgo) {
        clusters[key].recent += 1;
      } else {
        clusters[key].previous += 1;
      }
    }

    const clusterList = Object.values(clusters);

    const clusterCount = clusterList.length;

    const acceleratingClusters = clusterList.filter((c) => {
      const baseline = c.previous || 1;
      const ratio = c.recent / baseline;
      return c.recent >= 2 && ratio >= 2;
    }).length;

    const averageSourceDiversity =
      clusterList.length > 0
        ? Math.round(
            clusterList.reduce((sum, c) => sum + c.sources.size, 0) /
              clusterList.length,
          )
        : 0;

    // Hourly trend data (24 hours)
    const hourlyTrend = [];

    for (let i = 23; i >= 0; i--) {
      const start = new Date(now.getTime() - i * 60 * 60 * 1000);
      const end = new Date(start.getTime() + 60 * 60 * 1000);

      let count = 0;

      for (const r of regionArticles) {
        const published = new Date(r.published_at);
        if (published >= start && published < end) {
          count += categoryWeight(r.category);
        }
      }

      count = Math.round(count);

      hourlyTrend.push({
        hour: start.getHours(),
        count,
      });
    }

    // Volatility Score (0–100)
    const counts = hourlyTrend.map((h) => h.count || 0);
    const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
    const max = Math.max(0, ...counts);

    let volatilityScore = 0;

    if (avg > 0) {
      const spikeRatio = max / avg;
      volatilityScore = Math.round(
        Math.min(100, Math.max(0, (spikeRatio - 1) * 35)),
      );
    }

    const payload = {
      region: req.params.region,
      articleCount,
      clusterCount,
      acceleratingClusters,
      averageSourceDiversity,
      hourlyTrend,
      volatilityScore,
      economicHits,
      economicTriggerLevel,
    };

    regionDetailCache.set(cacheKey, { data: payload, time: Date.now() });
    res.json(payload);
  } catch (err) {
    console.error("Region detail error:", err);
    res.status(500).json({ error: "Region detail failed" });
  }
});

/* ===========================
   SERVER
=========================== */

app.get("/articles/search", async (req, res) => {
  const sort_by = ["initial_score", "published_at"].includes(req.query.sort_by)
    ? req.query.sort_by
    : "initial_score";
  const order = req.query.order === "asc" ? "ASC" : "DESC";
  const hours = parseInt(req.query.hours) || 24;
  const limit = Math.min(parseInt(req.query.limit) || 20, 200);
  const keyword = req.query.keyword;

  try {
    const result = await pool.query(`
      SELECT id, headline, summary, source_name, source_url,
             published_at, initial_score, category, cluster_key
      FROM candidates
      WHERE status != 'ignored'
      AND published_at > NOW() - INTERVAL '${hours} hours'
      ${keyword ? `AND (headline ILIKE '%${keyword}%' OR summary ILIKE '%${keyword}%')` : ""}
      ORDER BY ${sort_by} ${order}
      LIMIT ${limit}
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  if (!q) return res.json([]);
  try {
    const result = await pool.query(
      `
      SELECT id, headline, summary, source_name, source_url,
             published_at, initial_score, ranking_score, category, cluster_key
      FROM candidates
      WHERE status != 'ignored'
      AND (headline ILIKE $1 OR summary ILIKE $1)
      ORDER BY ranking_score DESC
      LIMIT 20
    `,
      [`%${q}%`],
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});

let cachedRegions = null;
let cachedRegionsTime = 0;

app.get("/regions", async (req, res) => {
  if (cachedRegions && Date.now() - cachedRegionsTime < 3 * 60 * 1000) {
    return res.json(cachedRegions);
  }
  try {
    const result = await pool.query(`
      SELECT id, headline, summary, source_name, source_url, published_at, initial_score, category
      FROM candidates
      WHERE status != 'ignored'
      AND published_at > NOW() - INTERVAL '36 hours'
      ORDER BY initial_score DESC, discovered_at DESC
      LIMIT 800;
    `);

    const rows = result.rows || [];

    // Build region -> clusters
    const regionMap = {};

    for (const r of rows) {
      const region = normalizeRegionFromText(
        r.headline,
        r.summary,
        r.source_name,
      );

      if (!regionMap[region]) regionMap[region] = {};

      // cluster key (reuse your existing clustering signature)
      const key =
        makeClusterKey(r.headline) || r.headline.toLowerCase().slice(0, 60);

      const slug = key.replace(/[^a-z0-9]+/g, "-");

      if (!regionMap[region][slug]) {
        regionMap[region][slug] = {
          slug,
          title: r.headline,
          articles: [],
          totalScore: 0,
        };
      }

      regionMap[region][slug].articles.push({
        id: r.id,
        headline: r.headline,
        summary: r.summary,
        source_name: r.source_name,
        source_url: r.source_url,
        published_at: r.published_at,
        score: r.initial_score,
      });

      regionMap[region][slug].totalScore += r.initial_score || 0;
    }

    // Format response
    const regions = Object.entries(regionMap).map(([region, clustersObj]) => {
      const clusters = Object.values(clustersObj)
        .map((c) => {
          // sort articles inside cluster by score desc, then time desc
          c.articles.sort((a, b) => (b.score || 0) - (a.score || 0));
          c.signalStrength = Math.round(
            c.totalScore / (c.articles.length || 1),
          );
          return c;
        })
        .sort((a, b) => (b.signalStrength || 0) - (a.signalStrength || 0));

      // simple momentum label (prototype)
      const avgStrength =
        clusters.reduce((s, c) => s + (c.signalStrength || 0), 0) /
        (clusters.length || 1);

      const momentum =
        avgStrength >= 70 ? "Rising" : avgStrength >= 45 ? "Active" : "Calm";

      const narrativeStructure =
        clusters.length >= 10
          ? "Fragmented"
          : clusters.length >= 5
            ? "Mixed"
            : "Concentrated";

      return {
        region,
        momentum,
        narrativeStructure,
        clusterCount: clusters.length,
        clusters,
      };
    });

    // Order regions by “importance”
    regions.sort((a, b) => {
      // Always push Other to the end
      if (a.region === "Other") return 1;
      if (b.region === "Other") return -1;
      return (b.clusterCount || 0) - (a.clusterCount || 0);
    });

    cachedRegions = regions;
    cachedRegionsTime = Date.now();
    res.json(regions);
  } catch (err) {
    console.error("Regions error:", err);
    res.status(500).json({ error: "Regions failed" });
  }
});

/* ===========================
   CRON
=========================== */

startCron(pool);
