import express from "express";
import pkg from "pg";
import dotenv from "dotenv";
import { startCron } from "./services/cronService.js";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

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
   RATE LIMITING (BASIC)
   =========================== */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per IP per window
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
      // Allow server-to-server, Postman, cron, curl
      if (!origin) return cb(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) {
        return cb(null, true);
      }

      return cb(new Error("CORS blocked: " + origin));
    }
  })
);

/* ✅ Friendly CORS error response */
app.use((err, req, res, next) => {
  if (err && String(err.message || "").startsWith("CORS blocked:")) {
    return res.status(403).json({ error: err.message });
  }
  next(err);
});

/* ===========================
   HELMET (SECURE HEADERS)
   =========================== */
app.use(
  helmet({
    // Keep things compatible while you’re still building
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
    req.user = payload; // { id, role }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
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
  } catch (err) {
    res.status(500).json({
      status: "error",
      service: "newstrack-backend",
      database: "disconnected",
      timestamp: new Date().toISOString()
    });
  }
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "healthy" });
  } catch {
    res.status(500).json({ status: "unhealthy" });
  }
});

/* ===========================
   AUTH ROUTES
   =========================== */
app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, password required" });
    }

    const password_hash = await bcrypt.hash(password, 10);

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
  try {
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
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/auth/me", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, email, role, created_at FROM users WHERE id = $1`,
    [req.user.id]
  );
  res.json({ user: result.rows[0] });
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

app.post("/posts", requireAuth, async (req, res) => {
  const { headline, description } = req.body;

  if (!headline?.trim()) {
    return res.status(400).json({ error: "Headline required" });
  }

  const result = await pool.query(
    `INSERT INTO posts (headline, description, is_external, author_id)
     VALUES ($1, $2, false, $3)
     RETURNING *`,
    [headline.trim(), description || "", req.user.id]
  );

  res.status(201).json({ post: result.rows[0] });
});

/* ===========================
   SERVER
   =========================== */
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});

// ✅ Cron only (no HTTP exposure)
startCron(pool);
