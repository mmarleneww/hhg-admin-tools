// PropertyGuru Next.js JSON API
// Data path: pageProps.pageData.data.listingsData (object with numeric keys)
// Each entry: { listingData: { id, price, agent, agency, mrt, ... } }

const PG_BASE = "https://www.propertyguru.com.sg";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.propertyguru.com.sg/",
};

// BuildId cache (per Lambda instance, ~1hr)
let cachedBuildId = null;
let cacheTime = 0;

async function getBuildId() {
  const now = Date.now();
  if (cachedBuildId && now - cacheTime < 3600000) return cachedBuildId;
  // Fetch PG page via ScraperAPI (direct fetch is 403)
  const key = process.env.SCRAPER_API_KEY;
  const targetUrl = `${PG_BASE}/property-for-rent`;
  const fetchUrl = key
    ? `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(targetUrl)}&render=false`
    : targetUrl;
  try {
    const resp = await fetch(fetchUrl, { headers: HEADERS });
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
    // Step 1: Get buildId (cached)
    let buildId = await getBuildId();
    if (!buildId) {
      return json({ success: false, error: "Could not get PG buildId — check SCRAPER_API_KEY", blocked: true, searchUrl });
    }

    // Step 2: Fetch JSON data API
    const jsonUrl = `${PG_BASE}/_next/data/${buildId}/${pgPage}.json?${qp.toString()}`;
    let resp = await fetch(jsonUrl, { headers: { ...HEADERS, "Accept": "application/json" } });

    // If stale buildId, refresh and retry once
    if (!resp.ok) {
      cachedBuildId = null;
      buildId = await getBuildId();
      if (buildId) {
        resp = await fetch(`${PG_BASE}/_next/data/${buildId}/${pgPage}.json?${qp.toString()}`, { headers: { ...HEADERS, "Accept": "application/json" } });
      }
      if (!resp || !resp.ok) return json({ success: false, error: `JSON API ${resp?.status}`, blocked: true, searchUrl });
    }

    const raw = await resp.json();

    // Step 3: Extract listings from correct path
    const pageData = raw?.pageProps?.pageData?.data;
    const listingsObj = pageData?.listingsData || {};
    const paginationData = pageData?.paginationData || {};

    const rawListings = Object.values(listingsObj).map(item => item.listingData).filter(Boolean);
    const total = paginationData.totalCount || paginationData.total || rawListings.length;
    const totalPages = paginationData.totalPages || Math.ceil(total / 10);

    if (rawListings.length === 0) {
      return json({ success: true, total: 0, page, totalPages: 0, listings: [], searchUrl });
    }

    // Step 4: Format listings (agent phone fetched separately)
    const listings = rawListings.map(r => formatListing(r, listingType));

    // Step 5: Enrich with phone from listing detail pages (parallel, best-effort)
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
  // Price
  const priceRaw = r.price?.value || 0;
  const priceDisplay = priceRaw
    ? (listingType === "rent" ? `$${Number(priceRaw).toLocaleString()}/mo` : `$${Number(priceRaw).toLocaleString()}`)
    : "";

  // Beds/baths from listingFeatures array
  let beds = null, baths = null;
  if (r.listingFeatures) {
    const feats = Array.isArray(r.listingFeatures) ? r.listingFeatures.flat() : [];
    feats.forEach(f => {
      if (f.dataAutomationId === "listing-card-v2-bedrooms") beds = parseInt(f.text) || null;
      if (f.dataAutomationId === "listing-card-v2-bathrooms") baths = parseInt(f.text) || null;
    });
  }

  // Area from listingFeatures
  let areaSqft = null;
  if (r.listingFeatures) {
    const feats = Array.isArray(r.listingFeatures) ? r.listingFeatures.flat() : [];
    const areaFeat = feats.find(f => f.text?.includes("sqft") || f.iconName?.includes("area"));
    if (areaFeat) areaSqft = parseInt(areaFeat.text?.replace(/[^\d]/g, "")) || null;
  }

  // Address
  const address = r.fullAddress?.split(",")[0]?.trim() || r.localizedTitle?.split(",")[0]?.trim() || "";

  // MRT
  const mrt = r.mrt?.nearbyText || "";

  // Availability
  const availability = r.availabilityInfo || "";

  // Listed date
  const listedDate = r.recency?.text?.replace("Listed on ", "").replace(" ago", "") || "";

  // Furnishing — from description or later from detail page
  const furnishing = r.furnishing || "";

  // Agent (no phone yet — fetched separately)
  const agent = {
    name: r.agent?.name || "",
    cea: r.agent?.license || "",
    agency: r.agency?.name || "",
    phone: "",
    blocked: false,
  };

  return {
    link: r.url || "",
    address,
    priceRaw,
    priceDisplay,
    beds,
    baths,
    areaSqft,
    areaDisplay: areaSqft ? `${areaSqft.toLocaleString()} sqft` : "",
    furnishing,
    availability,
    mrt,
    listedDate,
    propertyType: r.typeText || "",
    tenure: r.tenure || "",
    leaseTerm: "",
    agent,
  };
}

async function enrichPhone(listing) {
  if (!listing.link) return listing;
  try {
    const resp = await fetch(listing.link, { headers: HEADERS, redirect: "follow" });
    if (!resp.ok) return listing;
    const html = await resp.text();
    const phoneMatch = html.match(/"\+65(\d{8})"/);
    if (phoneMatch) listing.agent.phone = "+65" + phoneMatch[1];
    if (!listing.furnishing) {
      const furnMatch = html.match(/(Fully [Ff]urnished|Partial(?:ly)? [Ff]urnished|Unfurnished)/i);
      if (furnMatch) listing.furnishing = furnMatch[1];
    }
    if (!listing.areaSqft) {
      const areaMatch = html.match(/([\d,]+)\s*sqft/i);
      if (areaMatch) {
        listing.areaSqft = parseInt(areaMatch[1].replace(/,/g, ""));
        listing.areaDisplay = `${listing.areaSqft.toLocaleString()} sqft`;
      }
    }
    const leaseMatch = html.match(/(\d+)\s+years?\s+lease/i);
    if (leaseMatch) listing.leaseTerm = leaseMatch[0];
    const tenureMatch = html.match(/(Freehold|Leasehold\s*\d*)/i);
    if (tenureMatch) listing.tenure = tenureMatch[1];
  } catch {}
  return listing;
}
