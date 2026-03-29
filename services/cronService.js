import cron from "node-cron";
import { ingestAllFeeds } from "./rssIngest.js";

export function startCron(pool) {
  console.log("🕒 RSS Cron Service Started");

  // ─── INGEST: every 15 minutes ───────────────────────────────────────────
  cron.schedule("*/15 * * * *", async () => {
    console.log("⏱️ Running scheduled ingestion...");
    try {
      const result = await ingestAllFeeds(pool);
      console.log(
        `✅ Ingestion complete | inserted=${result.inserted} skipped=${result.skipped}`,
      );
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

      // 5. Delete AI posts older than 7 days
      await pool.query(`
        DELETE FROM posts
        WHERE source_name = 'NewsTrac AI'
        AND created_at < NOW() - INTERVAL '7 days'
      `);

      console.log(
        `🧹 Cleanup: ${ignored.rowCount} ignored, ${collapsed.rowCount} collapsed, ${old.rowCount} old wiped`,
      );
    } catch (err) {
      console.error("❌ Cleanup failed:", err.message);
    }
  });

  // ─── AI LIVE POSTS: every 6 hours ────────────────────────────────────────
  cron.schedule("0 */6 * * *", async () => {
    console.log("🤖 Generating AI live posts...");
    try {
      console.log("📡 Querying clusters...");
      // 1. Get top 5 clusters from last 6 hours
      const clusters = await pool.query(`
      SELECT cluster_key, top_headline, article_count, avg_score
      FROM cluster_snapshots
      ORDER BY avg_score DESC, article_count DESC
      LIMIT 5
    `);

      if (!clusters.rows.length) {
        console.log("⚠️ No clusters found for AI posts");
        return;
      }

      for (const cluster of clusters.rows) {
        // 2. Get all articles in this cluster
        const articles = await pool.query(
          `
        SELECT headline, summary, source_name
        FROM candidates
        WHERE cluster_key = $1
        AND status != 'ignored'
        AND published_at > NOW() - INTERVAL '12 hours'
        LIMIT 10
      `,
          [cluster.cluster_key],
        );

        if (!articles.rows.length) {
          console.log(
            `⚠️ No articles found for cluster: ${cluster.cluster_key}`,
          );
          continue;
        }

        // 3. Build prompt
        const articleText = articles.rows
          .map((a) => `[${a.source_name}] ${a.headline}. ${a.summary || ""}`)
          .join("\n");

        const prompt = `You are a professional news journalist. Based on the following headlines and summaries from multiple sources covering the same story, write a concise 3-sentence news report in plain English. Be factual, neutral and clear. Do not mention source names in the report.

SOURCES:
${articleText}

Write only the news report, nothing else.`;

        // 4. Call Groq
        const groqRes = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              model: "llama3-70b-8192",
              messages: [{ role: "user", content: prompt }],
              max_tokens: 300,
              temperature: 0.4,
            }),
          },
        );

        const groqData = await groqRes.json();
        const report = groqData?.choices?.[0]?.message?.content?.trim();

        if (!report) continue;

        // 5. Save as post — check if one already exists for this cluster today
        const existing = await pool.query(
          `
        SELECT id FROM posts
        WHERE source_name = 'NewsTrac AI'
        AND headline = $1
        AND created_at > NOW() - INTERVAL '6 hours'
      `,
          [cluster.top_headline],
        );

        if (existing.rows.length) continue;

        await pool.query(
          `
        INSERT INTO posts (headline, description, author_id, source_name, is_external, views)
        VALUES ($1, $2, 1, 'NewsTrac AI', false, 0)
      `,
          [cluster.top_headline, report],
        );

        console.log(`✅ AI post created: ${cluster.top_headline}`);
      }
    } catch (err) {
      console.error("❌ AI live posts failed:", err.message, err.stack);
    }
  });
}
