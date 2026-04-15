const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Referer": "https://www.propertyguru.com.sg/",
};

// Wrap URL with ScraperAPI if key is configured
function scraperUrl(url) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) return url;
  return `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}&render=false`;
}

async function fetchWithFallback(url) {
  // Try direct fetch first (fast, free)
  try {
    const r = await fetch(url, { headers: HEADERS, redirect: "follow" });
    if (r.ok) {
      const html = await r.text();
      if (!html.includes("cf-browser-verification") && !html.includes("Just a moment")) {
        return { html, blocked: false };
      }
    }
  } catch {}

  // Fallback: ScraperAPI
  const key = process.env.SCRAPE_API_KEY;
  if (!key) return { html: null, blocked: true, reason: "no_proxy" };

  try {
    const proxyUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}&render=false`;
    const r2 = await fetch(proxyUrl, { headers: { "Accept": "text/html" } });
    if (r2.ok) {
      const html = await r2.text();
      return { html, blocked: false };
    }
    return { html: null, blocked: true, reason: `scraperapi_${r2.status}` };
  } catch (e) {
    return { html: null, blocked: true, reason: e.message };
  }
}