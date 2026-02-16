import express from "express";
import pkg from "pg";
import dotenv from "dotenv";
import { startCron } from "./services/cronService.js";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ingestBBCWorldRSS } from "./services/rssIngest.js";

dotenv.config();
const { Pool } = pkg;

console.log("🔥 INDEX.JS LOADED — REAL ENTRYPOINT 🔥");

/* ===========================
   APP SETUP
=========================== */
const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT || 3000;

/* ===========================
   SECURITY MIDDLEWARE
=========================== */

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

/* ===========================
   CORS (LOCKED)
=========================== */

const ALLOWED_ORIGINS = [
  "https://newstrack-frontend.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002"
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    }
  })
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
  ssl: { rejectUnauthorized: false }
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
      timestamp: new Date().toISOString()
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
      [name.trim(), email.trim().toLowerCase(), password_hash]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch {
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const result = await pool.query(
    `SELECT * FROM users WHERE email=$1`,
    [email.trim().toLowerCase()]
  );

  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token });
});

/* ===========================
   CLEANUP JOB
=========================== */

setInterval(async () => {
  try {
    const result = await pool.query(`
      DELETE FROM candidates
      WHERE status = 'ignored'
      AND discovered_at < NOW() - INTERVAL '3 days'
    `);

    console.log(`🧹 Cleanup removed ${result.rowCount} old ignored rows`);
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}, 60 * 60 * 1000);

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
   ✅ FEED (PUBLIC)
   - We don’t rely on DB statuses like 'breaking/background' (not in your schema).
   - We compute a "bucket" in SQL:
       breaking   = last 2 hours AND score >= 55
       published  = status = 'published'
       background = everything else (new/queued/ignored older stuff)
=========================== */

app.get("/feed", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        headline,
        summary,
        source_name,
        source_url,
        category,
        status,
        initial_score,
        discovered_at,
        CASE
          WHEN discovered_at >= NOW() - INTERVAL '2 hours' AND initial_score >= 55 THEN 'breaking'
          WHEN status = 'published' THEN 'published'
          ELSE 'background'
        END AS feed_bucket
      FROM candidates
      ORDER BY
        CASE
          WHEN (discovered_at >= NOW() - INTERVAL '2 hours' AND initial_score >= 55) THEN 1
          WHEN status = 'published' THEN 2
          ELSE 3
        END,
        initial_score DESC,
        discovered_at DESC
      LIMIT 50
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Feed error:", err.message);
    res.status(500).json({ error: "Feed failed" });
  }
});

/* ===========================
   CANDIDATES (AUTH)
=========================== */

app.get("/candidates", requireAuth, async (req, res) => {
  const { status } = req.query;

  let query = `SELECT * FROM candidates`;
  const values = [];

  if (status) {
    query += ` WHERE status = $1`;
    values.push(status);
  }

  query += ` ORDER BY discovered_at DESC`;

  const result = await pool.query(query, values);
  res.json(result.rows);
});

/* ===========================
   RSS INGEST
=========================== */

app.post("/ingest/rss", async (req, res) => {
  try {
    const result = await ingestBBCWorldRSS(pool);
    res.json({
      status: "ok",
      inserted: result.inserted,
      skipped: result.skipped
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "RSS ingestion failed" });
  }
});

/* ===========================
   🔥 PUBLISH QUEUED ARTICLES (AUTH)
   NOTE: this is POST not GET, so "Cannot GET /publish" is expected.
=========================== */

app.post("/publish", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM candidates
      WHERE status = 'queued'
      ORDER BY initial_score DESC
      LIMIT 10
    `);

    let publishedCount = 0;

    for (const candidate of result.rows) {
      await pool.query(
        `
        INSERT INTO posts (headline, description, is_external)
        VALUES ($1, $2, true)
        `,
        [candidate.headline, candidate.summary]
      );

      await pool.query(
        `
        UPDATE candidates
        SET status = 'published'
        WHERE id = $1
        `,
        [candidate.id]
      );

      publishedCount++;
    }

    res.json({
      status: "ok",
      published: publishedCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Publish failed" });
  }
});

/* ===========================
   SERVER
=========================== */

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});

/* ===========================
   CRON
=========================== */

startCron(pool);
