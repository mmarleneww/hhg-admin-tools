// PropertyGuru uses Next.js - we call their /_next/data/ JSON API
// This returns structured JSON without needing JS rendering or ScraperAPI

const PG_BASE = "https://www.propertyguru.com.sg";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.propertyguru.com.sg/",
  "Cache-Control": "no-cache",
};

let cachedBuildId = null;
let cacheTime = 0;

async function getBuildId() {
  const now = Date.now();
  if (cachedBuildId && now - cacheTime < 3600000) return cachedBuildId;
  try {
    const resp = await fetch(`${PG_BASE}/property-for-rent`, { headers: HEADERS });
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
    const buildId = await getBuildId();
    if (!buildId) return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, error: "Could not get PG buildId", blocked: true, searchUrl }) };

    const jsonUrl = `${PG_BASE}/_next/data/${buildId}/${pgPage}.json?${qp.toString()}`;
    let jsonResp = await fetch(jsonUrl, { headers: { ...HEADERS, "Accept": "application/json" }, redirect: "follow" });

    if (!jsonResp.ok) {
      // buildId stale - refresh and retry
      cachedBuildId = null;
      const freshId = await getBuildId();
      if (freshId) {
        jsonResp = await fetch(`${PG_BASE}/_next/data/${freshId}/${pgPage}.json?${qp.toString()}`, { headers: { ...HEADERS, "Accept": "application/json" } });
      }
      if (!jsonResp.ok) return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, error: `API returned ${jsonResp.status}`, blocked: true, searchUrl }) };
    }

    const jsonData = await jsonResp.json();
    const props = jsonData?.pageProps || {};
    const rawListings = props.listings || props.data?.listings || [];
    const total = props.total || props.totalListings || props.data?.total || rawListings.length;

    // If no listings found, return debug info
    if (rawListings.length === 0) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        success: true, total: 0, page, totalPages: 0, listings: [], searchUrl,
        _debug: { propKeys: Object.keys(props).slice(0, 20), buildId }
      })};
    }

    const listings = rawListings.slice(0, 10).map(r => formatListing(r, listingType));

    // Enrich with agent phone from listing pages (parallel)
    const enriched = await Promise.all(listings.map(l => enrichAgent(l)));

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      success: true, total, page, totalPages: Math.ceil(total / 10), listings: enriched, searchUrl, blocked: false
    })};

  } catch (err) {
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, error: err.message || "Server error", searchUrl }) };
  }
};

function formatListing(r, listingType) {
  const priceRaw = r.asking_price_cents ? Math.round(r.asking_price_cents / 100) : (r.price || r.asking_price || 0);
  const beds = r.bedrooms ?? r.bedroom_count ?? null;
  const baths = r.bathrooms ?? r.bathroom_count ?? null;
  const areaSqft = r.floor_area ?? r.land_area ?? null;
  const address = r.project_name || r.name || r.address_name || r.formatted_address || "";
  const listingId = r.id || r.listing_id || "";
  const link = r.url
    ? (r.url.startsWith("http") ? r.url : PG_BASE + r.url)
    : (listingId ? `${PG_BASE}/listing/${listingId}` : "");

  const mrtData = r.mrt_stations?.[0] || r.nearest_mrt;
  const mrt = mrtData
    ? `${mrtData.distance_in_meters || mrtData.distance}m (${mrtData.walk_time_in_minutes || mrtData.walk_time}mins) from ${mrtData.mrt_station || mrtData.name}`
    : (r.mrt_description || "");

  const furnishMap = { fully_furnished: "Fully Furnished", partial_furnished: "Partial Furnished", unfurnished: "Unfurnished" };
  const furnishing = furnishMap[r.furnishing?.toLowerCase?.()] || r.furnishing_description || r.furnishing || "";
  const availability = r.availability_date_display || r.available_from || r.availability || "";
  const listedDate = r.listing_date_display || r.listing_date || r.listed_on || "";

  return {
    link,
    address,
    streetAddress: r.street || r.address || "",
    priceRaw,
    priceDisplay: priceRaw ? (listingType === "rent" ? `$${Number(priceRaw).toLocaleString()}/mo` : `$${Number(priceRaw).toLocaleString()}`) : "",
    beds, baths, areaSqft,
    areaDisplay: areaSqft ? `${Number(areaSqft).toLocaleString()} sqft` : "",
    furnishing, availability, mrt, listedDate,
    propertyType: r.property_type_name || r.property_type || "",
    tenure: r.tenure || "",
    leaseTerm: r.lease_term || r.minimum_lease || "",
    agent: {
      name: r.agent_name || r.agent?.name || "",
      phone: r.agent_phone || r.agent?.phone || r.agent?.mobile || "",
      agency: r.agent_company || r.agent?.company || r.agency_name || "",
      cea: r.agent_cea || r.agent?.cea_number || r.agent?.registration_number || "",
      blocked: false,
    },
  };
}

async function enrichAgent(listing) {
  if (!listing.link) return listing;
  // Skip if we already have phone from JSON data
  if (listing.agent?.phone) return listing;
  try {
    const resp = await fetch(listing.link, { headers: HEADERS, redirect: "follow" });
    if (!resp.ok) return listing;
    const html = await resp.text();
    const phoneMatch = html.match(/"\+65(\d{8})"/);
    if (phoneMatch) listing.agent.phone = "+65" + phoneMatch[1];
    const ceaMatch = html.match(/R\d{7}[A-Z]/);
    if (ceaMatch && !listing.agent.cea) listing.agent.cea = ceaMatch[0];
    if (!listing.agent.name) {
      const titleMatch = html.match(/<title>[^<]*by ([^,<]+),\s*\d+/i);
      if (titleMatch) listing.agent.name = titleMatch[1].trim();
    }
    if (!listing.furnishing) {
      const furnishMatch = html.match(/(Fully [Ff]urnished|Partial(?:ly)? [Ff]urnished|Unfurnished)/i);
      if (furnishMatch) listing.furnishing = furnishMatch[1];
    }
  } catch {}
  return listing;
}
