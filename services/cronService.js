import cron from "node-cron";
import { ingestAllFeeds } from "./rssIngest.js";

export function startCron(pool) {
  console.log("🕒 RSS Cron Service Started");

  // ─── INGEST: every 15 minutes ───────────────────────────────────────────
  cron.schedule("*/15 * * * *", async () => {
    console.log("⏱️ Running scheduled ingestion...");
    try {
      const result = await ingestAllFeeds(pool);
      console.log(`✅ Ingestion complete | inserted=${result.inserted} skipped=${result.skipped}`);
    } catch (err) {
      console.error("❌ Ingestion failed:", err.message);
    }
  });

  // ─── CLUSTER BUILD: every 5 minutes ─────────────────────────────────────
  // Builds a shared cluster table so all routes read from one source
  // instead of each recomputing clustering independently
  cron.schedule("*/5 * * * *", async () => {
    try {
      await pool.query(`
        INSERT INTO cluster_snapshots (cluster_key, title, article_count, source_count, avg_score, top_headline, snapshot_at)
        SELECT
          cluster_key,
          MIN(headline)                          AS title,
          COUNT(*)::int                          AS article_count,
          COUNT(DISTINCT source_name)::int       AS source_count,
          ROUND(AVG(initial_score))::int         AS avg_score,
          MIN(headline)                          AS top_headline,
          NOW()                                  AS snapshot_at
        FROM candidates
        WHERE status != 'ignored'
          AND published_at > NOW() - INTERVAL '36 hours'
          AND cluster_key IS NOT NULL
        GROUP BY cluster_key
        HAVING COUNT(*) >= 2
        ON CONFLICT (cluster_key)
        DO UPDATE SET
          article_count = EXCLUDED.article_count,
          source_count  = EXCLUDED.source_count,
          avg_score     = EXCLUDED.avg_score,
          top_headline  = EXCLUDED.top_headline,
          snapshot_at   = EXCLUDED.snapshot_at
      `);
      console.log("📊 Cluster snapshot updated");
    } catch (err) {
      // Table may not exist yet on first run — log but don't crash
      console.warn("⚠️ Cluster snapshot skipped:", err.message);
    }
  });

  // ─── CLEANUP: every hour ─────────────────────────────────────────────────
  cron.schedule("0 * * * *", async () => {
    try {
      // 1. Remove ignored rows older than 3 days
      const ignored = await pool.query(`
        DELETE FROM candidates
        WHERE status = 'ignored'
        AND discovered_at < NOW() - INTERVAL '3 days'
      `);

      // 2. After 48h keep only top scorer per cluster, delete the rest
      const collapsed = await pool.query(`
        DELETE FROM candidates
        WHERE published_at < NOW() - INTERVAL '48 hours'
        AND published_at > NOW() - INTERVAL '7 days'
        AND id NOT IN (
          SELECT DISTINCT ON (cluster_key) id
          FROM candidates
          WHERE published_at < NOW() - INTERVAL '48 hours'
          AND published_at > NOW() - INTERVAL '7 days'
          AND cluster_key IS NOT NULL
          ORDER BY cluster_key, initial_score DESC
        )
        AND cluster_key IS NOT NULL
      `);

      // 3. Hard wipe anything older than 7 days
      const old = await pool.query(`
        DELETE FROM candidates
        WHERE published_at < NOW() - INTERVAL '7 days'
      `);

      // 4. Wipe stale cluster snapshots older than 48h
      await pool.query(`
        DELETE FROM cluster_snapshots
        WHERE snapshot_at < NOW() - INTERVAL '48 hours'
      `);

      console.log(`🧹 Cleanup: ${ignored.rowCount} ignored, ${collapsed.rowCount} collapsed, ${old.rowCount} old wiped`);
    } catch (err) {
      console.error("❌ Cleanup failed:", err.message);
    }
  });
}