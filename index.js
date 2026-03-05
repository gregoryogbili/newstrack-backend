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
   CLEANUP JOB
=========================== */

setInterval(
  async () => {
    try {
      const result = await pool.query(`
      DELETE FROM candidates
      WHERE status = 'ignored'
      AND discovered_at < NOW() - INTERVAL '3 days'
    `);

      await pool.query(`
        DELETE FROM candidates
        WHERE published_at < NOW() - INTERVAL '5 days'
      `);

      console.log(`🧹 Cleanup removed ${result.rowCount} old ignored rows`);
    } catch (err) {
      console.error("Cleanup error:", err);
    }
  },
  60 * 60 * 1000,
);

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
    SELECT p.*, u.name AS author_name
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
  const { headline, content } = req.body;

  if (!headline || !content) {
    return res.status(400).json({ error: "Headline and content required" });
  }

  if (String(req.user.id) !== String(id)) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO posts (headline, description, author_id, views, created_at)
      VALUES ($1, $2, $3, 0, NOW())
      RETURNING *
      `,
      [headline.trim(), content.trim(), id],
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
      SELECT id, headline, description AS content, views, created_at
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

/* ===========================
   FEED (Cluster-Aware, Preserves Scoring Logic)
=========================== */

app.get("/feed", async (req, res) => {
  if (cachedFeed && Date.now() - cachedFeedTime < 5 * 60 * 1000) {
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
      }))
      .slice(0, 100);

    cachedFeed = clusteredFeed;
    cachedFeedTime = Date.now();

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

function normalizeRegionFromText(headline = "", summary = "") {
  const text = (headline + " " + (summary || "")).toLowerCase();

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
        const hasDivergence = divScore >= 35 || divergent.length > 0;

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
    cluster.hasDivergence = cluster.divergenceScore >= 35;

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

/* ===========================
   SIGNALS OVERVIEW (MACRO INTELLIGENCE)
   + Dynamic window support (6h / 24h / 72h)
   + Keeps full NPI/MacroRisk/Geo/Strategic logic
=========================== */

app.get("/signals/overview", async (req, res) => {
  try {
    // 🟢 Window control (default 24h)
    const windowParam = String(req.query.window || "24h").toLowerCase();

    // "Recent" window used for velocity/acceleration
    let recentHours = 24;
    if (windowParam === "6h") recentHours = 6;
    if (windowParam === "72h") recentHours = 72;

    // IMPORTANT: Always fetch enough history to compute "previous" + baselines.
    // If you fetch only 6h, previous becomes 0 and ratios blow up.
    // So we keep a stable lookback (3 days) and apply the window in logic.
    const fetchIntervalSQL = `${recentHours * 2} hours`; // 6h->12h, 24h->48h, 72h->144h

    const result = await pool.query(`
      SELECT headline, summary, published_at
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
      "uk",
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
      england: "UK",
      "south africa": "South Africa",
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

      strongClusters.push({
        key,
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
    const normalizedRecent = totalRecent / windowFactor;

    const avgRatio =
      strongClusters.length > 0 ? totalRatio / strongClusters.length : 0;

    let velocityIndex =
      normalizedRecent * 2 + avgRatio * 10 + acceleratingCount * 5;
    velocityIndex = Math.round(Math.max(0, Math.min(100, velocityIndex)));

    // Economic Risk Pulse (V1) (kept)
    let riskScore = 0;
    riskScore += velocityIndex * 0.6;
    riskScore += acceleratingCount * 8;
    if (acceleratingCount === 0) riskScore -= 10;
    riskScore = Math.round(Math.max(0, Math.min(100, riskScore)));

    // REGION COORDS (kept)
    const REGION_COORDS = {
      "United States": { lat: 39.8283, lng: -98.5795 },
      USA: { lat: 39.8283, lng: -98.5795 },
      Canada: { lat: 45.4215, lng: -75.6972 },
      Mexico: { lat: 19.4326, lng: -99.1332 },

      Brazil: { lat: -15.7939, lng: -47.8828 },
      Argentina: { lat: -34.6037, lng: -58.3816 },
      Chile: { lat: -33.4489, lng: -70.6693 },
      Colombia: { lat: 4.711, lng: -74.0721 },
      Peru: { lat: -12.0464, lng: -77.0428 },

      UK: { lat: 51.5074, lng: -0.1278 },
      England: { lat: 51.5074, lng: -0.1278 },
      France: { lat: 48.8566, lng: 2.3522 },
      Germany: { lat: 52.52, lng: 13.405 },
      Italy: { lat: 41.9028, lng: 12.4964 },
      Spain: { lat: 40.4168, lng: -3.7038 },
      Ukraine: { lat: 50.4501, lng: 30.5234 },
      Russia: { lat: 55.7558, lng: 37.6173 },

      Israel: { lat: 31.7683, lng: 35.2137 },
      Iran: { lat: 35.6892, lng: 51.389 },
      Saudi: { lat: 24.7136, lng: 46.6753 },
      "Middle East": { lat: 33, lng: 44 },

      China: { lat: 39.9042, lng: 116.4074 },
      Taiwan: { lat: 25.033, lng: 121.5654 },
      India: { lat: 28.6139, lng: 77.209 },
      Pakistan: { lat: 33.6844, lng: 73.0479 },
      Japan: { lat: 35.6762, lng: 139.6503 },

      Nigeria: { lat: 9.0765, lng: 7.3986 },
      Kenya: { lat: -1.2921, lng: 36.8219 },
      Ghana: { lat: 5.6037, lng: -0.187 },
      "South Africa": { lat: -25.7479, lng: 28.2293 },
      Egypt: { lat: 30.0444, lng: 31.2357 },
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
      const isDivergent = (c.divergenceScore || 0) >= 35;
      if (!isAccelerating && !isDivergent) continue;

      const clusterRows = rowsByCluster.get(c.key) || [];
      if (clusterRows.length === 0) continue;

      const volumeW = Math.min(20, clusterRows.length);
      const accelW = isAccelerating ? Math.min(4, c.ratio || 1) : 1;
      const divW = 1 + Math.min(1, (c.divergenceScore || 0) / 100);

      const clusterWeight = volumeW * accelW * divW;

      for (const row of clusterRows) {
        const headline = String(row.headline || "").toLowerCase();

        for (const place of places.filter((p) => p !== "greenland")) {
          if (!headline.includes(place)) continue;

          const escaped = place.replace(/\s+/g, "\\s+");
          const regex = new RegExp(`\\b${escaped}\\b`, "i");
          if (!regex.test(headline)) continue;

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

    res.json({
      window: windowParam,
      velocityIndex, // legacy
      stabilizedVelocity, // upgraded velocity
      acceleratingCount,
      clusterCount: strongClusters.length,
      economicRisk: riskScore, // legacy
      macroRisk, // upgraded macro risk
      npi, // Narrative Pressure Index
      regionalSpread,
      geopoliticalPressure,
      strategicIntensityRanking,
      narrativeSummary,
    });
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
      SELECT id, headline, summary, source_name, source_url, published_at, initial_score
      FROM candidates
      WHERE status != 'ignored'
      AND published_at > NOW() - INTERVAL '36 hours'
      ORDER BY initial_score DESC, discovered_at DESC
      LIMIT 250;
    `);

    const rows = result.rows || [];

    // Build region -> clusters
    const regionMap = {};

    for (const r of rows) {
      const region = normalizeRegionFromText(r.headline, r.summary);

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
    regions.sort((a, b) => (b.clusterCount || 0) - (a.clusterCount || 0));

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
