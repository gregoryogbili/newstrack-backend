import express from "express";
import pkg from "pg";
import dotenv from "dotenv";
import { startCron } from "./services/cronService.js";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const port = 3000;

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
    req.user = payload; // { id, role, iat, exp }
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
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", database: "disconnected" });
  }
});

/* ===========================
   AUTH ROUTES
   =========================== */

app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        error: "name, email, and password are required"
      });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'journalist')
       RETURNING id, name, email, role, created_at`,
      [name.trim(), email.trim().toLowerCase(), password_hash]
    );

    res.status(201).json({
      message: "User registered",
      user: result.rows[0]
    });
  } catch (err) {
    if (String(err).includes("users_email_unique")) {
      return res.status(409).json({ error: "Email already exists" });
    }
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "email and password are required"
      });
    }

    const result = await pool.query(
      `SELECT id, name, email, role, password_hash
       FROM users
       WHERE email = $1`,
      [email.trim().toLowerCase()]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load user" });
  }
});

/* ===========================
   POSTS
   =========================== */

app.get("/posts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.headline,
        p.description,
        p.created_at,
        p.is_external,
        p.source_name,
        u.id AS author_id,
        u.name AS author_name
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
      ORDER BY p.created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

/* ===========================
   🟢 STAGE 21.5 — PROTECTED POST CREATION
   =========================== */
app.post("/posts", requireAuth, async (req, res) => {
  try {
    const { headline, description } = req.body;

    if (!headline || !headline.trim()) {
      return res.status(400).json({ error: "Headline is required" });
    }

    const result = await pool.query(
      `INSERT INTO posts (headline, description, is_external, author_id)
       VALUES ($1, $2, false, $3)
       RETURNING *`,
      [headline.trim(), description || "", req.user.id]
    );

    res.status(201).json({
      message: "Post created",
      post: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create post" });
  }
});

/* ===========================
   OTHER ROUTES (UNCHANGED)
   =========================== */

app.get("/trending", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.headline,
        p.description,
        p.created_at,
        COALESCE(SUM(
          CASE
            WHEN e.headline_viewed THEN 1
            WHEN e.description_opened THEN 5
            ELSE 0
          END
        ), 0) AS score
      FROM posts p
      LEFT JOIN post_engagement e ON p.id = e.post_id
      GROUP BY p.id
      ORDER BY score DESC, p.created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch trending posts" });
  }
});

app.get("/journalists/:id/posts", async (req, res) => {
  try {
    const journalistId = req.params.id;

    const result = await pool.query(`
      SELECT
        p.id,
        p.headline,
        p.created_at,
        COALESCE(SUM(
          CASE
            WHEN e.headline_viewed THEN 1
            WHEN e.description_opened THEN 5
            ELSE 0
          END
        ), 0) AS score
      FROM posts p
      LEFT JOIN post_engagement e ON p.id = e.post_id
      WHERE p.author_id = $1
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `, [journalistId]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch journalist posts" });
  }
});

app.get("/revenue/simulate", async (req, res) => {
  try {
    const totalRevenue = Number(req.query.total);

    if (!totalRevenue || totalRevenue <= 0) {
      return res.status(400).json({ error: "Provide a valid total revenue amount" });
    }

    const creatorPool = totalRevenue * 0.10;

    const journalistsResult = await pool.query(`
      SELECT u.id, u.name
      FROM users u
      JOIN posts p ON p.author_id = u.id
      WHERE p.is_external = false
      GROUP BY u.id
    `);

    const journalists = journalistsResult.rows;
    const journalistCount = journalists.length;

    if (journalistCount === 0) {
      return res.json({ message: "No active journalists", payouts: [] });
    }

    const equalPool = creatorPool * 0.20;
    const equalSharePerJournalist = equalPool / journalistCount;
    const performancePool = creatorPool * 0.80;

    const scoresResult = await pool.query(`
      SELECT
        u.id,
        u.name,
        COALESCE(SUM(
          CASE
            WHEN e.headline_viewed THEN 1
            WHEN e.description_opened THEN 5
            ELSE 0
          END
        ), 0) AS score
      FROM users u
      JOIN posts p ON p.author_id = u.id
      LEFT JOIN post_engagement e ON p.id = e.post_id
      WHERE p.is_external = false
      GROUP BY u.id
    `);

    const scores = scoresResult.rows;
    const totalScore = scores.reduce((sum, s) => sum + Number(s.score), 0);

    const payouts = scores.map(j => {
      const performanceShare =
        totalScore > 0
          ? (Number(j.score) / totalScore) * performancePool
          : 0;

      return {
        journalist_id: j.id,
        journalist_name: j.name,
        score: Number(j.score),
        payout: Number((equalSharePerJournalist + performanceShare).toFixed(2))
      };
    });

    res.json({
      total_revenue: totalRevenue,
      creator_pool: creatorPool,
      platform_keeps: totalRevenue - creatorPool,
      payout_model: "10% creators (20% equal, 80% performance)",
      payouts
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Revenue simulation failed" });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// ✅ RSS mining runs ONLY via cron
startCron(pool);
