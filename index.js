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
   CANDIDATES
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
   RSS INGEST (Manual Trigger)
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
   SERVER
=========================== */

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});

/* ===========================
   CRON
=========================== */

startCron(pool);
