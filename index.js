import express from "express";
import pkg from "pg";
import dotenv from "dotenv";
import { startCron } from "./services/cronService.js";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ingestAllFeeds } from "./services/rssIngest.js";

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
  "https://newstrac.org",
  "https://www.newstrac.org",
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

  try {
    const result = await pool.query(
      `SELECT * FROM users WHERE email=$1`,
      [email.trim().toLowerCase()]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
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
    await pool.query(
      "UPDATE posts SET views = views + 1 WHERE id=$1",
      [id]
    );

    const result = await pool.query(
      `
      SELECT p.*, u.name AS author_name
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.id = $1
      `,
      [id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Single post error:", err);
    res.status(500).json({ error: "Failed to fetch post" });
  }
});

/* ===========================
   FEED
=========================== */

app.get("/feed", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM candidates
      WHERE status != 'ignored'
      ORDER BY initial_score DESC, discovered_at DESC
      LIMIT 150;
    `);

    const rows = result.rows;

    // Separate Reddit and others
    const reddit = rows.filter(r => r.source_name.includes("Reddit"));
    const others = rows.filter(r => !r.source_name.includes("Reddit"));

    // Limit Reddit to max 5
    const selectedReddit = reddit.slice(0, 5);

    // Fill rest with non-Reddit
    const selectedOthers = others.slice(0, 95);

    const balanced = [...selectedOthers, ...selectedReddit];

    res.json(balanced);

  } catch (err) {
    console.error("Feed error:", err.message);
    res.status(500).json({ error: "Feed failed" });
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
    const result = await ingestAllFeeds(pool);
    res.json({
      status: "ok",
      inserted: result.inserted,
      skipped: result.skipped,
      feedsProcessed: result.feeds
    });
  } catch (err) {
    console.error("RSS ingest failed:", err);
    res.status(500).json({ error: "RSS ingest failed" });
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
