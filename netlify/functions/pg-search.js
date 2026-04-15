const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Referer": "https://www.propertyguru.com.sg/",
};

async function fetchWithFallback(url) {
  // Try direct fetch first
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
  const key = process.env.SCRAPER_API_KEY;
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

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { listingType = "rent", freetext = "", bedrooms = [], propertyTypes = [], minPrice, maxPrice, page = 1, _debug = false } = body;

  const baseUrl = listingType === "rent"
    ? "https://www.propertyguru.com.sg/property-for-rent"
    : "https://www.propertyguru.com.sg/property-for-sale";

  const params = new URLSearchParams();
  if (freetext) params.set("freetext", freetext);
  if (bedrooms.length > 0) params.set("bedrooms", bedrooms.join(","));
  if (minPrice) params.set("minPrice", minPrice);
  if (maxPrice) params.set("maxPrice", maxPrice);
  if (listingType === "rent") params.set("listingType", "rent");
  params.set("isCommercial", "false");
  params.set("sort", "date");
  params.set("order", "desc");
  params.set("locale", "en");
  if (page > 1) params.set("page", page);

  if (propertyTypes.length > 0) {
    params.set("propertyTypeGroup", "N");
    for (const t of propertyTypes) {
      if (t === "CONDO") { params.append("propertyTypeCode", "CONDO"); params.append("propertyTypeCode", "APT"); }
      else if (t === "LANDED") { params.append("propertyTypeCode", "TERRA"); params.append("propertyTypeCode", "DETAC"); params.append("propertyTypeCode", "SEMI"); }
      else if (t === "HDB") { params.append("propertyTypeCode", "HDB"); }
    }
  }

  const searchUrl = `${baseUrl}?${params.toString()}`;

  try {
    const { html, blocked, reason } = await fetchWithFallback(searchUrl);

    if (blocked) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        success: false,
        error: reason === "no_proxy" ? "PG blocked. Set SCRAPER_API_KEY in Netlify env vars." : `Blocked (${reason})`,
        blocked: true, searchUrl
      })};
    }

    const listings = parseListings(html, listingType);
    const total = parseTotal(html);
    const totalPages = Math.ceil(total / 10);

    if (_debug) {
      const links = (html.match(/href="\/listing\/[^"]+"/g) || []).slice(0, 5);
      const hasListingText = html.includes('/listing/');
      const htmlLen = html.length;
      const sample = html.substring(0, 500);
      return { statusCode: 200, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true, total, listingsFound: listings.length, links, hasListingText, htmlLen, sample, searchUrl }) };
    }

    const enriched = await Promise.all(listings.map(l => fetchAgentDetails(l)));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, total, page, totalPages, listings: enriched, searchUrl, blocked: false }),
    };
  } catch (err) {
    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: err.message || "Server error" }) };
  }
};

function parseTotal(html) {
  const m = html.match(/(\d[\d,]+)\s+(?:Listings?|Homes?|Houses?|Properties?|Apartments?|Condominiums?)/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
}

function parseListings(html, listingType) {
  const listings = [];
  const seen = new Set();
  const linkPattern = /href="(\/listing\/[^"#]+?)"/g;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const path = match[1];
    if (path.includes("media") || path.includes("floor")) continue;
    const fullLink = "https://www.propertyguru.com.sg" + path;
    if (seen.has(fullLink)) continue;
    seen.add(fullLink);

    const idMatch = path.match(/(\d{6,})$/);
    if (!idMatch) continue;

    const idx = html.indexOf(match[0]);
    const ctx = html.substring(Math.max(0, idx - 500), idx + 2000);
    const listing = extractFromContext(ctx, fullLink, listingType);
    if (listing.priceRaw || listing.address) listings.push(listing);
    if (listings.length >= 10) break;
  }
  return listings;
}

function extractFromContext(ctx, link, listingType) {
  const text = ctx.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const listing = { link, agent: {} };

  // Address from title tag in context
  const titleM = ctx.match(/title="([^"]{3,80})"/);
  const h2M = ctx.match(/<h2[^>]*>([^<]{3,80})<\/h2>/i);
  if (titleM) listing.address = titleM[1].trim();
  else if (h2M) listing.address = h2M[1].trim();

  // Price S$3,700
  const priceM = text.match(/S\$\s*([\d,]+)\s*\/?(mo)?/i);
  if (priceM) {
    listing.priceRaw = parseInt(priceM[1].replace(/,/g, ""), 10);
    listing.priceDisplay = listingType === "rent" ? `$${listing.priceRaw.toLocaleString()}/mo` : `$${listing.priceRaw.toLocaleString()}`;
  }

  // Beds/Baths
  const bedsM = text.match(/(\d+)\s*Bed/i);
  const bathsM = text.match(/(\d+)\s*Bath/i);
  if (bedsM) listing.beds = parseInt(bedsM[1], 10);
  if (bathsM) listing.baths = parseInt(bathsM[1], 10);

  // Area
  const areaM = text.match(/([\d,]+)\s*sqft/i);
  if (areaM) { listing.areaSqft = parseInt(areaM[1].replace(/,/g,""),10); listing.areaDisplay = `${listing.areaSqft.toLocaleString()} sqft`; }

  // MRT
  const mrtM = text.match(/(\d+)\s*m\s*\((\d+)\s*mins?\)\s*from\s*([^\n,<]{5,50}(?:MRT|LRT))/i);
  if (mrtM) listing.mrt = `${mrtM[1]}m (${mrtM[2]}mins) from ${mrtM[3].trim()}`;

  // Availability
  const availM = text.match(/Available\s+from\s+(\d{1,2}\s+\w+(?:\s+\d{4})?)/i) || text.match(/(Ready to move in)/i);
  if (availM) listing.availability = availM[1];

  // Listed date
  const listedM = text.match(/Listed\s+on\s+(\d{1,2}\s+\w+\s+\d{4})/i);
  if (listedM) listing.listedDate = listedM[1];

  // Property type
  const typeM = text.match(/(Condominium|HDB|Apartment|Landed|Terraced|Detached|Bungalow|Semi-detached)/i);
  if (typeM) listing.propertyType = typeM[1];

  return listing;
}

async function fetchAgentDetails(listing) {
  if (!listing.link) return listing;
  try {
    const { html, blocked } = await fetchWithFallback(listing.link);
    if (blocked || !html) { listing.agent = { blocked: true }; return listing; }

    const titleM = html.match(/<title>([^<]+)<\/title>/i);
    if (titleM) {
      const agentM = titleM[1].match(/by ([^,]+),\s*\d+/i);
      if (agentM) listing.agent.name = agentM[1].trim();
      if (!listing.address) listing.address = titleM[1].split(",")[0]?.trim();
    }

    const phoneM = html.match(/"+65(\d{8})"/);
    if (phoneM) listing.agent.phone = "+65" + phoneM[1];

    const ceaM = html.match(/R\d{7}[A-Z]/);
    if (ceaM) listing.agent.cea = ceaM[0];

    const agencyM = html.match(/(ERA\s+REALTY|PROPNEX|ORANGETEE[^"<]{0,20}|HUTTONS[^"<]{0,20}|KNIGHT\s+FRANK|SAVILLS|SLP|NAVIS|ERA)/i);
    if (agencyM) listing.agent.agency = agencyM[1].trim();

    const furnishM = html.match(/(Fully [Ff]urnished|Partial(?:ly)? [Ff]urnished|Unfurnished)/i);
    if (furnishM) listing.furnishing = furnishM[1];

    const floorM = html.match(/(High|Mid(?:dle)?|Low|Upper|Ground)\s+[Ff]loor/i);
    if (floorM) listing.floor = floorM[0];

    const tenureM = html.match(/(Freehold|Leasehold\s*\d*)/i);
    if (tenureM) listing.tenure = tenureM[1];

    const leaseM = html.match(/(\d+)\s+years?\s+lease/i);
    if (leaseM) listing.leaseTerm = leaseM[0];

    if (!listing.availability) {
      const availM = html.match(/Available\s+from\s+(\d{1,2}\s+\w+(?:\s+\d{4})?)/i) || html.match(/(Ready to move in)/i);
      if (availM) listing.availability = availM[1] || availM[0];
    }

    return listing;
  } catch (err) {
    listing.agent = { blocked: true, error: err.message };
    return listing;
  }
}
