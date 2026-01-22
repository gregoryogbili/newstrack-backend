import cron from "node-cron";
import { fetchRSS } from "./rssService.js";

/**
 * Start RSS mining on a schedule
 */
export function startCron(pool) {
  // Runs every 30 minutes
  cron.schedule("*/30 * * * *", async () => {
    console.log("⏱️ Running scheduled RSS mining...");

    try {
      const items = await fetchRSS();

      for (const item of items) {
        await pool.query(
          `INSERT INTO candidates
           (headline, description, source_platform, source_name, source_url)
           VALUES ($1, $2, 'rss', $3, $4)
           ON CONFLICT (source_url) DO NOTHING`,
          [
            item.headline,
            item.description,
            item.source_name, // e.g. "BBC News"
            item.source_url   // article link
          ]
        );
      }

      console.log(`✅ RSS mining complete (${items.length} items)`);
    } catch (err) {
      console.error("❌ RSS cron failed:", err.message);
    }
  });
}
