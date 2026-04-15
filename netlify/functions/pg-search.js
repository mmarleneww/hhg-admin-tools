const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Referer": "https://www.propertyguru.com.sg/",
};

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { listingType = "rent", freetext = "", bedrooms = [], propertyTypes = [], minPrice, maxPrice, page = 1 } = body;

  // Build PG search URL
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

  // Property type codes
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
    // Step 1: Fetch search results page
    const searchResp = await fetch(searchUrl, { headers: HEADERS, redirect: "follow" });

    if (!searchResp.ok) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, error: `PG search returned ${searchResp.status}`, blocked: true }) };
    }

    const html = await searchResp.text();

    if (html.includes("cf-browser-verification") || html.includes("Just a moment") || html.includes("Cloudflare")) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ success: false, error: "Blocked by Cloudflare", blocked: true }) };
    }

    // Step 2: Parse listings from HTML
    const listings = parseListings(html, listingType);
    const total = parseTotal(html);
    const totalPages = Math.ceil(total / 10);

    // Step 3: Fetch agent details for each listing (parallel, with timeout)
    const enriched = await Promise.all(
      listings.map(listing => fetchAgentDetails(listing))
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, total, page, totalPages, listings: enriched, searchUrl, blocked: false }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: err.message || "Server error", blocked: false }),
    };
  }
};

function parseTotal(html) {
  const m = html.match(/(\d[\d,]+)\s+(?:Listings?|Homes?|Houses?|Properties?|Apartments?)/i);
  if (m) return parseInt(m[1].replace(/,/g, ""), 10);
  return 0;
}

function parseListings(html, listingType) {
  const listings = [];

  // Extract listing links - these are the most reliable anchor
  const linkPattern = /href="(\/listing\/[^"]+?)"/g;
  const seen = new Set();
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const path = match[1];
    // Skip media/floorplan anchors
    if (path.includes("#") || path.includes("media")) continue;
    const fullLink = "https://www.propertyguru.com.sg" + path;
    if (seen.has(fullLink)) continue;
    seen.add(fullLink);

    // Extract listing ID from URL
    const idMatch = path.match(/(\d{6,})$/);
    if (!idMatch) continue;
    const listingId = idMatch[1];

    // Find context around this link in HTML (300 chars before/after)
    const idx = html.indexOf(match[0]);
    const ctx = html.substring(Math.max(0, idx - 500), idx + 1500);

    const listing = extractFromContext(ctx, fullLink, listingType);
    if (listing.price || listing.address) {
      listings.push(listing);
    }

    if (listings.length >= 10) break;
  }

  return listings;
}

function extractFromContext(ctx, link, listingType) {
  // Strip HTML tags for text extraction
  const text = ctx.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  const listing = { link, agent: {} };

  // Address / project name
  const addrMatch = text.match(/(?:for[- ](?:rent|sale)[- ][^$\d]{3,60}?)(?=\s*S?\$|\s*\d+ Bed)/i) ||
                    text.match(/([A-Z][A-Za-z\s']+(?:Residences?|Park|Hill|Green|View|Heights?|Gardens?|Place|Court|Lodge|Ville|Tower|One|The [A-Z][a-z]+)?)\s+(?:\d|S\$)/);
  if (addrMatch) listing.address = addrMatch[1]?.trim().replace(/^for[- ](?:rent|sale)[- ]/i, "").trim();

  // Price
  const priceMatch = text.match(/S\$\s*([\d,]+)\s*\/?\s*(?:mo(?:nth)?)?/i);
  if (priceMatch) {
    listing.priceRaw = parseInt(priceMatch[1].replace(/,/g, ""), 10);
    listing.priceDisplay = listingType === "rent"
      ? `$${Number(listing.priceRaw).toLocaleString()}/mo`
      : `$${Number(listing.priceRaw).toLocaleString()}`;
  }

  // Beds
  const bedsMatch = text.match(/(\d+)\s*Bed/i);
  if (bedsMatch) listing.beds = parseInt(bedsMatch[1], 10);

  // Baths
  const bathsMatch = text.match(/(\d+)\s*Bath/i);
  if (bathsMatch) listing.baths = parseInt(bathsMatch[1], 10);

  // Area
  const areaMatch = text.match(/([\d,]+)\s*sqft/i);
  if (areaMatch) {
    listing.areaSqft = parseInt(areaMatch[1].replace(/,/g, ""), 10);
    listing.areaDisplay = `${listing.areaSqft.toLocaleString()} sqft`;
  }

  // Availability
  const availMatch = text.match(/Available\s+from\s+(\d{1,2}\s+\w+\s+\d{4}|\w+\s+\d{1,2})/i) ||
                     text.match(/(Ready to move in|Immediately)/i);
  if (availMatch) listing.availability = availMatch[1] || availMatch[0];

  // MRT
  const mrtMatch = text.match(/(\d+)\s*m\s*\((\d+)\s*mins?\)\s*from\s*([^\n,<]{5,50}(?:MRT|LRT))/i);
  if (mrtMatch) listing.mrt = `${mrtMatch[1]}m (${mrtMatch[2]}mins) from ${mrtMatch[3].trim()}`;

  // Listed date
  const listedMatch = text.match(/Listed\s+on\s+(\d{1,2}\s+\w+\s+\d{4})/i);
  if (listedMatch) listing.listedDate = listedMatch[1];

  // Property type
  const typeMatch = text.match(/(Condominium|HDB|Apartment|Landed|Semi-detached|Terraced|Detached|Bungalow)/i);
  if (typeMatch) listing.propertyType = typeMatch[1];

  return listing;
}

async function fetchAgentDetails(listing) {
  if (!listing.link) return listing;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(listing.link, {
      headers: HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      listing.agent = { blocked: true };
      return listing;
    }

    const html = await resp.text();

    // Agent name from page title: "..., by Will Lee, 500106468"
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      const agentFromTitle = titleMatch[1].match(/by ([^,]+),\s*\d+/i);
      if (agentFromTitle) listing.agent.name = agentFromTitle[1].trim();

      // Also extract address from title if not already set
      if (!listing.address) {
        const addrFromTitle = titleMatch[1].split(",")[0]?.trim();
        if (addrFromTitle) listing.address = addrFromTitle;
      }
    }

    // Phone: "+6591234567" pattern in HTML source
    const phoneMatch = html.match(/"\+65(\d{8})"/);
    if (phoneMatch) listing.agent.phone = "+65" + phoneMatch[1];

    // CEA number
    const ceaMatch = html.match(/R\d{7}[A-Z]/);
    if (ceaMatch) listing.agent.cea = ceaMatch[0];

    // Agency from agent card text
    const agencyMatch = html.match(/(ERA\s+REALTY|PROPNEX|ORANGETEE[^"<]{0,20}|HUTTONS[^"<]{0,20}|KNIGHT\s+FRANK|SAVILLS|SLP[^"<]{0,20}|NAVIS[^"<]{0,20}|REMAX|Dennis\s+WENGE[^"<]{0,20}|C2[^"<]{0,20}REALTY)/i);
    if (agencyMatch) listing.agent.agency = agencyMatch[1].trim();

    // Furnishing (more reliable from detail page)
    const furnishMatch = html.match(/(Fully [Ff]urnished|Partial(?:ly)? [Ff]urnished|Unfurnished)/i);
    if (furnishMatch) listing.furnishing = furnishMatch[1];

    // Floor level
    const floorMatch = html.match(/(High|Mid(?:dle)?|Low|Upper|Ground)\s+[Ff]loor/i);
    if (floorMatch) listing.floor = floorMatch[0];

    // Tenure
    const tenureMatch = html.match(/(Freehold|Leasehold\s*\d*)/i);
    if (tenureMatch) listing.tenure = tenureMatch[1];

    // Lease term
    const leaseMatch = html.match(/(\d+)\s+years?\s+lease/i);
    if (leaseMatch) listing.leaseTerm = leaseMatch[0];

    // Availability - more detailed from detail page
    if (!listing.availability) {
      const availMatch = html.match(/Available\s+from\s+(\d{1,2}\s+\w+(?:\s+\d{4})?)/i) ||
                         html.match(/(Ready to move in|Immediately available)/i);
      if (availMatch) listing.availability = availMatch[1] || availMatch[0];
    }

    return listing;
  } catch (err) {
    listing.agent = { blocked: true, error: err.message };
    return listing;
  }
}
