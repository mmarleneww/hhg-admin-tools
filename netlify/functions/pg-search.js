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

  const { listingType="rent", freetext="", bedrooms=[], propertyTypes=[], minPrice, maxPrice, page=1, _extractUrl } = body;

  // Single URL extraction mode
  if (_extractUrl) {
    try {
      const resp = await scraperFetch(_extractUrl);
      if (!resp.ok) return json({ success: false, error: `Listing page returned ${resp.status}` });
      const html = await resp.text();

      // Extract from page title
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const title = titleMatch?.[1] || '';
      const agentFromTitle = title.match(/by ([^,]+),\s*\d+/i)?.[1]?.trim() || '';
      const addressFromTitle = title.split(',')[0]?.trim() || '';

      // Extract fields
      const phoneMatch = html.match(/"\+65(\d{8})"/);
      const phone = phoneMatch ? '+65' + phoneMatch[1] : '';
      const ceaMatch = html.match(/R\d{7}[A-Z]/);
      const cea = ceaMatch?.[0] || '';
      const agencyMatch = html.match(/(ERA\s+REALTY|PROPNEX[^"<]{0,20}|ORANGETEE[^"<]{0,20}|HUTTONS[^"<]{0,20}|KNIGHT\s+FRANK|SAVILLS|SLP[^"<]{0,20}|NAVIS[^"<]{0,20})/i);
      const agency = agencyMatch?.[1]?.trim() || '';
      const priceMatch = html.match(/S\$\s*([\d,]+)\s*\/?\s*mo/i) || html.match(/S\$\s*([\d,]+)/);
      const priceRaw = priceMatch ? parseInt(priceMatch[1].replace(/,/g,'')) : 0;
      const bedsMatch = html.match(/(\d+)\s*Bed/i);
      const bathsMatch = html.match(/(\d+)\s*Bath/i);
      const areaMatch = html.match(/([\d,]+)\s*sqft/i);
      const areaSqft = areaMatch ? parseInt(areaMatch[1].replace(/,/g,'')) : null;
      const furnishMatch = html.match(/(Fully [Ff]urnished|Partial(?:ly)? [Ff]urnished|Unfurnished)/i);
      const availMatch = html.match(/Available\s+from\s+([\d\w\s]+?)(?:\n|<)/i) || html.match(/(Ready to move in)/i);
      const mrtMatch = html.match(/(\d+)\s*m\s*\((\d+)\s*mins?\)\s*from\s*([^\n<]{5,50}(?:MRT|LRT))/i);
      const tenureMatch = html.match(/(Freehold|Leasehold\s*\d*)/i);
      const leaseMatch = html.match(/(\d+)\s+years?\s+lease/i);

      const listing = {
        link: _extractUrl,
        address: addressFromTitle,
        priceRaw,
        priceDisplay: priceRaw ? `$${Number(priceRaw).toLocaleString()}` : '',
        beds: bedsMatch ? parseInt(bedsMatch[1]) : null,
        baths: bathsMatch ? parseInt(bathsMatch[1]) : null,
        areaSqft,
        areaDisplay: areaSqft ? `${areaSqft.toLocaleString()} sqft` : '',
        furnishing: furnishMatch?.[1] || '',
        availability: availMatch?.[1] || '',
        mrt: mrtMatch ? `${mrtMatch[1]}m (${mrtMatch[2]}mins) from ${mrtMatch[3].trim()}` : '',
        tenure: tenureMatch?.[1] || '',
        leaseTerm: leaseMatch?.[0] || '',
        agent: { name: agentFromTitle, phone, cea, agency, blocked: false },
      };
      return json({ success: true, listing });
    } catch (err) {
      return json({ success: false, error: err.message });
    }
  }

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

    // Client-side price filter as backup (PG sometimes returns results outside range)
    const filtered = rawListings.filter(r => {
      const price = r.price?.value || 0;
      if (minPrice && price < Number(minPrice)) return false;
      if (maxPrice && price > Number(maxPrice)) return false;
      return true;
    });

    const listings = filtered.map(r => formatListing(r, listingType));

    // Enrich phone from listing detail pages (parallel, best-effort)
    const enriched = await Promise.all(listings.map(l => enrichPhone(l)));
    const filteredTotal = total; // keep original total for pagination

    return json({ success: true, total: filteredTotal, page, totalPages, listings: enriched, searchUrl, blocked: false });

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
