import Parser from "rss-parser";

const parser = new Parser();

/**
 * Fetch latest items from an RSS feed
 */
export async function fetchRSS() {
  const feedUrl = "http://feeds.bbci.co.uk/news/rss.xml";

  const feed = await parser.parseURL(feedUrl);

  return feed.items.slice(0, 5).map(item => ({
    headline: item.title,
    description: item.contentSnippet || "",
    source_name: "BBC News",
    source_url: item.link
  }));
}
