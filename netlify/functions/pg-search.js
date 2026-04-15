const PG_BASE = "https://www.propertyguru.com.sg";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.propertyguru.com.sg/",
};

let cachedBuildId = null;
let cacheTime = 0;

async function scraperFetch(url, wantJson = false) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) throw new Error("SCRAPER_API_KEY not configured");
  const proxyUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}&render=false`;
  const resp = await fetch(proxyUrl, { headers: wantJson ? { "Accept": "application/json" } : HEADERS });
  return resp;
}

async function getBuildId() {
  const now = Date.now();
  if (cachedBuildId && now - cacheTime < 3600000) return cachedBuildId;
  try {
    const resp = await scraperFetch(`${PG_BASE}/property-for-rent`);
    if (!resp.ok) return null;
    const html = await resp.text();
    const match = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (match) { cachedBuildId = match[1]; cacheTime = now; return cachedBuildId; }
  } catch {}
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { listingType="rent", freetext="", bedrooms=[], propertyTypes=[], minPrice, maxPrice, page=1 } = body;

  const qp = new URLSearchParams();
  if (freetext) qp.set("freetext", freetext);
  if (bedrooms.length > 0) qp.set("bedrooms", bedrooms.join(","));
  if (minPrice) qp.set("minPrice", String(minPrice));
  if (maxPrice) qp.set("maxPrice", String(maxPrice));
  if (listingType === "rent") qp.set("listingType", "rent");
  qp.set("isCommercial", "false");
  qp.set("sort", "date");
  qp.set("order", "desc");
  qp.set("locale", "en");
  if (page > 1) qp.set("page", String(page));
  if (propertyTypes.length > 0) {
    qp.set("propertyTypeGroup", "N");
    for (const t of propertyTypes) {
      if (t === "CONDO") { qp.append("propertyTypeCode", "CONDO"); qp.append("propertyTypeCode", "APT"); }
      else if (t === "LANDED") { qp.append("propertyTypeCode", "TERRA"); qp.append("propertyTypeCode", "DETAC"); qp.append("propertyTypeCode", "SEMI"); }
      else if (t === "HDB") qp.append("propertyTypeCode", "HDB");
    }
  }

  const pgPage = listingType === "rent" ? "property-for-rent" : "property-for-sale";
  const searchUrl = `${PG_BASE}/${pgPage}?${qp.toString()}`;

  try {
    // Step 1: Get buildId via ScraperAPI
    let buildId = await getBuildId();
    if (!buildId) return json({ success: false, error: "Could not get PG buildId", blocked: true, searchUrl });

    // Step 2: Fetch Next.js JSON API via ScraperAPI
    const jsonUrl = `${PG_BASE}/_next/data/${buildId}/${pgPage}.json?${qp.toString()}`;
    let resp = await scraperFetch(jsonUrl, true);

    // If stale buildId, refresh once
    if (!resp.ok) {
      cachedBuildId = null;
      buildId = await getBuildId();
      if (buildId) resp = await scraperFetch(`${PG_BASE}/_next/data/${buildId}/${pgPage}.json?${qp.toString()}`, true);
      if (!resp || !resp.ok) return json({ success: false, error: `API ${resp?.status}`, blocked: true, searchUrl });
    }

    const raw = await resp.json();
    const pageData = raw?.pageProps?.pageData?.data;
    const listingsObj = pageData?.listingsData || {};
    const paginationData = pageData?.paginationData || {};

    const rawListings = Object.values(listingsObj).map(item => item.listingData).filter(Boolean);
    const total = paginationData.totalCount || paginationData.total || rawListings.length;
    const totalPages = paginationData.totalPages || Math.ceil(total / 10);

    if (rawListings.length === 0) return json({ success: true, total: 0, page, totalPages: 0, listings: [], searchUrl });

    const listings = rawListings.map(r => formatListing(r, listingType));

    // Step 3: Enrich phone from listing detail pages (via ScraperAPI, parallel)
    const enriched = await Promise.all(listings.map(l => enrichPhone(l)));

    return json({ success: true, total, page, totalPages, listings: enriched, searchUrl, blocked: false });

  } catch (err) {
    return json({ success: false, error: err.message || "Server error", searchUrl });
  }
};

function json(obj) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function formatListing(r, listingType) {
  const priceRaw = r.price?.value || 0;
  const priceDisplay = priceRaw ? (listingType === "rent" ? `$${Number(priceRaw).toLocaleString()}/mo` : `$${Number(priceRaw).toLocaleString()}`) : "";

  let beds = null, baths = null, areaSqft = null;
  if (r.listingFeatures) {
    const feats = Array.isArray(r.listingFeatures) ? r.listingFeatures.flat() : [];
    feats.forEach(f => {
      if (f.dataAutomationId === "listing-card-v2-bedrooms") beds = parseInt(f.text) || null;
      if (f.dataAutomationId === "listing-card-v2-bathrooms") baths = parseInt(f.text) || null;
      if (f.text?.includes("sqft")) areaSqft = parseInt(f.text.replace(/[^\d]/g, "")) || null;
    });
  }

  const address = r.fullAddress?.split(",")[0]?.trim() || r.localizedTitle?.split(",")[0]?.trim() || "";
  const mrt = r.mrt?.nearbyText || "";
  const availability = r.availabilityInfo || "";
  const listedDate = r.recency?.text?.replace("Listed on ", "") || "";

  return {
    link: r.url || "",
    address,
    priceRaw, priceDisplay,
    beds, baths, areaSqft,
    areaDisplay: areaSqft ? `${areaSqft.toLocaleString()} sqft` : "",
    furnishing: "", availability, mrt, listedDate,
    propertyType: r.typeText || "",
    tenure: "", leaseTerm: "",
    agent: {
      name: r.agent?.name || "",
      cea: r.agent?.license || "",
      agency: r.agency?.name || "",
      phone: "",
      blocked: false,
    },
  };
}

async function enrichPhone(listing) {
  if (!listing.link) return listing;
  try {
    const resp = await scraperFetch(listing.link);
    if (!resp.ok) return listing;
    const html = await resp.text();
    const phoneMatch = html.match(/"\+65(\d{8})"/);
    if (phoneMatch) listing.agent.phone = "+65" + phoneMatch[1];
    if (!listing.furnishing) {
      const fm = html.match(/(Fully [Ff]urnished|Partial(?:ly)? [Ff]urnished|Unfurnished)/i);
      if (fm) listing.furnishing = fm[1];
    }
    if (!listing.areaSqft) {
      const am = html.match(/([\d,]+)\s*sqft/i);
      if (am) { listing.areaSqft = parseInt(am[1].replace(/,/g,"")); listing.areaDisplay = `${listing.areaSqft.toLocaleString()} sqft`; }
    }
    const lm = html.match(/(\d+)\s+years?\s+lease/i);
    if (lm) listing.leaseTerm = lm[0];
    const tm = html.match(/(Freehold|Leasehold\s*\d*)/i);
    if (tm) listing.tenure = tm[1];
  } catch {}
  return listing;
}
