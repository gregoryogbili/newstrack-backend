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

/* ===========================
   APP SETUP
   =========================== */
const app = express();
const port = process.env.PORT || 3000;

/* ===========================
   CORS CONFIG (LOCKED)
   =========================== */
const ALLOWED_ORIGINS = [
  "https://newstrack-frontend.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002"
];

/* ===========================
   RATE LIMITING
   =========================== */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(apiLimiter);

/* ===========================
   CORS
   =========================== */
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

/* ===========================
   HELMET
   =========================== */
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

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

  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* ===========================
   ✅ CANDIDATE STATUS HELPER
   =========================== */
function isValidCandidateStatus(status) {
  return ["new", "queued", "ignored"].includes(status);
}

/* ===========================
   HEALTH CHECK
   =========================== */
app.get("/", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      service: "newstrack-backend",
      database: "connected",
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
       VALUES ($1, $2, $3, 'journalist')
       RETURNING id, name, email, role, created_at`,
      [name.trim(), email.trim().toLowerCase(), password_hash]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (String(err).includes("users_email_unique")) {
      return res.status(409).json({ error: "Email already exists" });
    }
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const result = await pool.query(
    `SELECT id, name, email, role, password_hash
     FROM users WHERE email = $1`,
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

  res.json({ token, user });
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
  const result = await pool.query(
    `SELECT * FROM candidates ORDER BY created_at DESC`
  );
  res.json(result.rows);
});

/* ===========================
   ✅ UPDATE CANDIDATE STATUS
   =========================== */
app.patch("/candidates/:id/status", requireAuth, async (req, res) => {
  const candidateId = Number(req.params.id);
  const { status } = req.body;

  if (!candidateId) {
    return res.status(400).json({ error: "Invalid candidate id" });
  }

  if (!isValidCandidateStatus(status)) {
    return res.status(400).json({
      error: "Invalid status. Allowed: new, queued, ignored"
    });
  }

  const result = await pool.query(
    `UPDATE candidates
     SET status = $1
     WHERE id = $2 AND status != 'published'
     RETURNING *`,
    [status, candidateId]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({
      error: "Candidate not found or already published"
    });
  }

  res.json({
    message: "Candidate status updated",
    candidate: result.rows[0]
  });
});

app.post("/ingest/rss", async (req, res) => {
  try {
    const result = await ingestBBCWorldRSS(pool);
    res.json({
      status: "ok",
      source: "BBC World RSS",
      inserted: result.inserted,
      skipped: result.skipped
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "RSS ingestion failed"
    });
  }
});

/* ===========================
   SERVER
   =========================== */
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});

startCron(pool);
