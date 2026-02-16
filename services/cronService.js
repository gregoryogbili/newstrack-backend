import cron from "node-cron";
import { ingestAllFeeds } from "./rssIngest.js";

/**
 * Start automated RSS ingestion
 */
export function startCron(pool) {

  console.log("🕒 RSS Cron Service Started");

  // Run every 15 minutes
  cron.schedule("*/15 * * * *", async () => {

    console.log("⏱️ Running scheduled multi-feed ingestion...");

    try {
      // 1️⃣ Ingest fresh content
      const result = await ingestAllFeeds(pool);

      console.log(
        `✅ Ingestion complete | inserted=${result.inserted} skipped=${result.skipped}`
      );

      // 2️⃣ Cleanup old content (older than 7 days)
      const cleanup = await pool.query(`
        DELETE FROM candidates
        WHERE discovered_at < NOW() - INTERVAL '7 days'
      `);

      console.log(`🧹 Cleanup removed ${cleanup.rowCount} old rows`);

    } catch (err) {
      console.error("❌ RSS cron failed:", err.message);
    }

  });
}
