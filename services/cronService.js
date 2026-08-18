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
        AND created_at < NOW() - INTERVAL '24 hours'
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
    console.log("🤖 Generating AI intelligence posts...");
    try {
      // 1. Get top cluster per category for topic diversity
      const clusters = await pool.query(`
      SELECT DISTINCT ON (category) cluster_key,
        MIN(headline) as top_headline,
        category,
        COUNT(*) as article_count,
        ROUND(AVG(initial_score)) as avg_score
      FROM candidates
      WHERE status != 'ignored'
      AND published_at > NOW() - INTERVAL '48 hours'
      AND cluster_key IS NOT NULL
      AND category IS NOT NULL
      GROUP BY cluster_key, category
      HAVING COUNT(*) >= 2
      ORDER BY category, avg_score DESC
      LIMIT 5
    `);

      if (!clusters.rows.length) {
        console.log("⚠️ No clusters found for AI posts");
        return;
      }

      // 2. Source bloc mapping for narrative context
      const BLOC_MAP = {
        BBC: "Western/UK",
        CNN: "Western/US",
        NBC: "Western/US",
        ABC: "Western/US",
        "New York Times": "Western/US",
        "Washington Post": "Western/US",
        Guardian: "Western/UK",
        "Financial Times": "Western/UK",
        Reuters: "Western/Wire",
        "Associated Press": "Western/Wire",
        Sky: "Western/UK",
        "Al Jazeera": "Gulf/Qatar",
        "Arab News": "Gulf/Saudi",
        "Gulf News": "Gulf/UAE",
        "Times of Israel": "Israeli",
        "Jerusalem Post": "Israeli",
        "Al-Monitor": "Middle East Independent",
        RT: "Russian State",
        "Moscow Times": "Russian Independent",
        Ukrinform: "Ukrainian State",
        "Kyiv Post": "Ukrainian Independent",
        Xinhua: "Chinese State",
        "South China Morning Post": "Chinese/HK",
        "The Hindu": "Indian",
        Dawn: "Pakistani",
        Vanguard: "African/Nigeria",
        AllAfrica: "African",
        "Daily Nation": "African/Kenya",
        "Al Jazeera": "Gulf/Qatar",
        TechCrunch: "Tech/US",
        "The Verge": "Tech/US",
        Bloomberg: "Financial/US",
        "Foreign Policy": "US Policy",
        "The Diplomat": "Asia Policy",
      };

      for (const cluster of clusters.rows) {
        // 3. Fetch articles with source names
        const articles = await pool.query(
          `SELECT headline, summary, source_name
         FROM candidates
         WHERE cluster_key = $1
         AND status != 'ignored'
         AND published_at > NOW() - INTERVAL '48 hours'
         LIMIT 10`,
          [cluster.cluster_key],
        );

        if (!articles.rows.length) continue;

        // 4. Build source-tagged article text with bloc labels
        const articleText = articles.rows
          .map((a) => {
            const bloc = BLOC_MAP[a.source_name] || "Independent";
            return `[${a.source_name} — ${bloc}]\nHeadline: ${a.headline}\nSummary: ${a.summary || "No summary available"}`;
          })
          .join("\n\n");

        // 5. Intelligence prompt
        const prompt = `You are a senior geopolitical intelligence analyst with deep expertise in international relations, military strategy, economics, and global media analysis. You have comprehensive knowledge of history, geopolitics, and current affairs up to your training cutoff. Use both the provided articles AND your own knowledge.

Analyse the following news coverage of a single event from multiple global media sources. Each source is tagged with its geopolitical bloc/alignment.

Your task is to produce a structured intelligence brief. Return ONLY a valid JSON object with these exact fields — no markdown, no code blocks, no preamble:

{
  "headline": "A precise, factual one-line event summary",
  "strategic_sentiment": "One of exactly: Escalatory | Diplomatic | Defensive | Threatening | Neutral | Economic",
  "intelligence_brief": "4-5 sentences of expert analyst-level insight. Cover: what happened, the strategic significance, historical context or precedent, likely implications for key actors, and what this means for the broader regional or global picture",
  "divergence": "How different media blocs are framing this event differently — note specific contrasts between Western, Eastern, Gulf, African or other perspectives. If all sources align, write null",
  "who_benefits": "Which actor or actors benefit most from this situation or from the dominant narrative being pushed, and why",
  "watch_signal": "The single most important indicator to monitor in the next 24-72 hours that will signal how this situation develops"
}

NEWS SOURCES:
${articleText}

Return only the JSON object.`;

        // 6. Call Groq
        const groqRes = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              model: "openai/gpt-oss-120b",
              messages: [{ role: "user", content: prompt }],
              max_tokens: 1000,
              temperature: 0.3,
            }),
          },
        );

        // 6a. Surface API failures — a non-2xx returns an error body with no
        // choices array, which used to fall straight through to `continue`
        if (!groqRes.ok) {
          const errBody = await groqRes.text().catch(() => "<unreadable body>");
          console.error(
            `❌ Groq API ${groqRes.status} ${groqRes.statusText} for cluster ${cluster.cluster_key}: ${errBody.slice(0, 500)}`,
          );
          continue;
        }

        const groqData = await groqRes.json();
        const raw = groqData?.choices?.[0]?.message?.content?.trim();
        if (!raw) {
          console.warn(
            `⚠️ Groq returned no content for cluster ${cluster.cluster_key} (finish_reason=${groqData?.choices?.[0]?.finish_reason ?? "none"})`,
          );
          continue;
        }

        // 7. Parse JSON response
        let intelligence;
        try {
          intelligence = JSON.parse(raw.replace(/```json|```/g, "").trim());
        } catch {
          console.warn(
            `⚠️ Failed to parse JSON for cluster: ${cluster.cluster_key}`,
          );
          continue;
        }

        // 8. Check for duplicate
        const existing = await pool.query(
          `SELECT id FROM posts
         WHERE source_name = 'NewsTrac AI'
         AND description LIKE $1
         AND created_at > NOW() - INTERVAL '24 hours'`,
          [`%${cluster.cluster_key}%`],
        );

        if (existing.rows.length) continue;

        // 9. Store intelligence as JSON in description
        await pool.query(
          `INSERT INTO posts (headline, description, author_id, source_name, is_external, views)
         VALUES ($1, $2, 1, 'NewsTrac AI', false, 0)`,
          [
            intelligence.headline || cluster.top_headline,
            JSON.stringify({ ...intelligence, cluster_key: cluster.cluster_key }),
          ],
        );

        console.log(`✅ Intelligence post created: ${intelligence.headline}`);
      }
    } catch (err) {
      console.error("❌ AI intelligence posts failed:", err.message);

      // pg attaches the offending relation/column and a character offset into
      // the statement — without these a schema error is unattributable
      if (err.code) {
        console.error(
          `   pg code=${err.code} routine=${err.routine ?? "?"} position=${err.position ?? "?"} schema=${err.schema ?? "?"} table=${err.table ?? "?"} column=${err.column ?? "?"} detail=${err.detail ?? "none"}`,
        );
      }

      // 42703 = undefined_column. The column exists when checked by hand, so
      // log what this connection actually resolves names against.
      if (err.code === "42703") {
        try {
          const ctx = await pool.query(
            `SELECT current_database() AS db, current_schema() AS schema,
                    current_setting('search_path') AS search_path,
                    to_regclass('posts')::text AS posts_resolves_to`,
          );
          console.error("   connection context:", ctx.rows[0]);

          const cols = await pool.query(
            `SELECT table_schema, string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns
             FROM information_schema.columns
             WHERE table_name = 'posts'
             GROUP BY table_schema`,
          );
          console.error("   posts columns by schema:", cols.rows);
        } catch (probeErr) {
          console.error("   schema probe failed:", probeErr.message);
        }
      }

      console.error(err.stack);
    }
  });
}
