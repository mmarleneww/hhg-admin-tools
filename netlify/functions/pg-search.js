const PG_BASE = "https://www.propertyguru.com.sg";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.propertyguru.com.sg/",
};

let cachedBuildId = null;
let cacheTime = 0;

// ─── MRT Station Code Lookup ─────────────────────────────────────────────────
const MRT_LOOKUP = {
  // EWL
  "pasir ris":["EW1"],"tampines":["EW2","DT32"],"simei":["EW3"],"tanah merah":["EW4"],
  "bedok":["EW5"],"kembangan":["EW6"],"eunos":["EW7"],"paya lebar":["EW8","CC9"],
  "aljunied":["EW9"],"kallang":["EW10"],"lavender":["EW11"],"bugis":["EW12","DT14"],
  "city hall":["EW13","NS25"],"raffles place":["EW14","NS26"],"tanjong pagar":["EW15"],
  "outram park":["EW16","NE3","TE17"],"tiong bahru":["EW17"],"redhill":["EW18"],
  "queenstown":["EW19"],"commonwealth":["EW20"],"buona vista":["EW21","CC22"],
  "dover":["EW22"],"clementi":["EW23"],"jurong east":["EW24","NS1"],
  "chinese garden":["EW25"],"lakeside":["EW26"],"boon lay":["EW27"],
  "pioneer":["EW28"],"joo koon":["EW29"],"gul circle":["EW30"],
  "tuas crescent":["EW31"],"tuas west road":["EW32"],"tuas link":["EW33"],
  "expo":["EW34","CG1"],"changi airport":["CG2"],
  // NSL
  "bukit batok":["NS2"],"bukit gombak":["NS3"],"choa chu kang":["NS4"],
  "yew tee":["NS5"],"kranji":["NS7"],"marsiling":["NS8"],
  "woodlands":["NS9","TE2"],"admiralty":["NS10"],"sembawang":["NS11"],
  "canberra":["NS12"],"yishun":["NS13"],"khatib":["NS14"],"yio chu kang":["NS15"],
  "ang mo kio":["NS16"],"bishan":["NS17","CC15"],"braddell":["NS18"],
  "toa payoh":["NS19"],"novena":["NS20"],"newton":["NS21","DT11"],
  "orchard":["NS22","TE14"],"somerset":["NS23"],"dhoby ghaut":["NS24","NE6","CC1"],
  "city hall":["NS25","EW13"],"raffles place":["NS26","EW14"],
  "marina bay":["NS27","CE2","TE20"],"marina south pier":["NS28"],
  // NEL
  "harbourfront":["NE1","CC29"],"outram park":["NE3","EW16","TE17"],
  "chinatown":["NE4","DT19"],"clarke quay":["NE5"],"dhoby ghaut":["NE6","NS24","CC1"],
  "little india":["NE7","DT12"],"farrer park":["NE8"],"boon keng":["NE9"],
  "potong pasir":["NE10"],"woodleigh":["NE11"],"serangoon":["NE12","CC13"],
  "kovan":["NE13"],"hougang":["NE14"],"buangkok":["NE15"],
  "sengkang":["NE16"],"punggol":["NE17"],
  // CCL
  "bayfront":["CE1","DT16"],"promenade":["CC4","DT15"],"nicoll highway":["CC5"],
  "stadium":["CC6"],"mountbatten":["CC7"],"dakota":["CC8"],
  "macpherson":["CC10","DT26"],"tai seng":["CC11"],"bartley":["CC12"],
  "lorong chuan":["CC14"],"marymount":["CC16"],"caldecott":["CC17","TE9"],
  "botanic gardens":["CC19","DT9"],"farrer road":["CC20"],
  "holland village":["CC21"],"one-north":["CC23"],"kent ridge":["CC24"],
  "haw par villa":["CC25"],"pasir panjang":["CC26"],"labrador park":["CC27"],
  "telok blangah":["CC28"],
  // DTL
  "bukit panjang":["DT1"],"cashew":["DT2"],"hillview":["DT3"],
  "beauty world":["DT5"],"king albert park":["DT6"],"sixth avenue":["DT7"],
  "tan kah kee":["DT8"],"stevens":["DT10","TE11"],
  "rochor":["DT13"],"bayfront":["DT16","CE1"],"downtown":["DT17"],
  "telok ayer":["DT18"],"fort canning":["DT20"],"bencoolen":["DT21"],
  "jalan besar":["DT22"],"bendemeer":["DT23"],"geylang bahru":["DT24"],
  "mattar":["DT25"],"ubi":["DT27"],"kaki bukit":["DT28"],
  "bedok north":["DT29"],"bedok reservoir":["DT30"],"tampines west":["DT31"],
  "tampines east":["DT33"],"upper changi":["DT34"],
  // TEL
  "woodlands north":["TE1"],"woodlands south":["TE3"],"springleaf":["TE4"],
  "lentor":["TE5"],"mayflower":["TE6"],"bright hill":["TE7"],"upper thomson":["TE8"],
  "mount pleasant":["TE10"],"napier":["TE12"],"orchard boulevard":["TE13"],
  "great world":["TE15"],"havelock":["TE16"],"maxwell":["TE18"],
  "shenton way":["TE19"],"marina south":["TE21"],
};

function detectMrtSearch(text) {
  const lower = text.toLowerCase().trim();
  const cleaned = lower.replace(/\s*(mrt|lrt|station)\s*$/i, "").trim();
  if (MRT_LOOKUP[cleaned]) return MRT_LOOKUP[cleaned];
  for (const [name, codes] of Object.entries(MRT_LOOKUP)) {
    if (name === cleaned || name.includes(cleaned) || cleaned.includes(name)) return codes;
  }
  return null;
}

async function scraperFetch(url, wantJson = false) {
  const key = process.env.SCRAPER_API_KEY;
  if (!key) throw new Error("SCRAPER_API_KEY not configured");
  const proxyUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}&render=false`;
  const resp = await fetch(proxyUrl, { headers: wantJson ? { "Accept": "application/json" } : HEADERS });
  return resp;
}

async function getBuildId() {
  const now = Date.now();
  if (cachedBuildId && now - cacheTime < 43200000) return cachedBuildId;
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

  // ── Single URL extraction mode ────────────────────────────────────────────
  if (_extractUrl) {
    try {
      // Detect listing type from URL
      const isForSale = _extractUrl.includes('/for-sale') || _extractUrl.includes('property-for-sale');
      const lType = isForSale ? 'sale' : 'rent';

      // Fetch the listing page (one request only)
      const resp = await scraperFetch(_extractUrl);
      if (!resp.ok) return json({ success: false, error: `Listing page returned ${resp.status}` });
      const html = await resp.text();

      // ── Priority 1: Parse __NEXT_DATA__ JSON (detail page structure) ──────
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextDataMatch) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          const data = nextData?.props?.pageProps?.pageData?.data;
          const r = data?.listingDetail;

          if (r) {
            // Project name
            const projectName = r.project?.metaByType?.verified?.name
                             || r.project?.metaByType?.unverified?.name
                             || r.title?.en || '';

            // Price
            const priceRaw = r.price?.min || r.price?.max || 0;
            const priceDisplay = priceRaw
              ? (lType === 'rent' ? `$${Number(priceRaw).toLocaleString()}/mo` : `$${Number(priceRaw).toLocaleString()}`)
              : '';

            // Beds / Baths / Area — from propertyOverviewData.propertyInfo.amenities
            // BUGFIX (2026-04-19): PG sometimes changes `unit` field format, causing areaSqft
            // to be misread or missed. Now we scan multiple fields + sanity check.
            const amenities = data?.propertyOverviewData?.propertyInfo?.amenities || [];
            let beds = null, baths = null, areaSqft = null;
            for (const a of amenities) {
              const unit  = String(a.unit  || '').toLowerCase();
              const label = String(a.label || a.name || '').toLowerCase();
              const valueRaw = String(a.value || '');
              const num = parseInt(valueRaw.replace(/[^\d]/g, '')) || null;
              // Bedrooms
              if (/bed/.test(unit) || /bed/.test(label)) {
                if (num !== null && num < 20) beds = num;
              }
              // Bathrooms
              else if (/bath/.test(unit) || /bath/.test(label)) {
                if (num !== null && num < 20) baths = num;
              }
              // Floor area — sqft/sqm/square, and sanity check (must be >= 50)
              else if (/sqft|sqm|square|area|floor/.test(unit) || /sqft|sqm|square|area|floor/.test(label)) {
                if (num !== null && num >= 50) areaSqft = num;
              }
            }
            // Secondary: try direct fields on listingDetail (some PG pages have these)
            if (areaSqft === null) {
              const directArea = r.floorArea || r.area?.value || r.area?.localeStringValue || '';
              if (directArea) {
                const n = parseInt(String(directArea).replace(/[^\d]/g, '')) || null;
                if (n !== null && n >= 50) areaSqft = n;
              }
            }

            // MRT
            const mrtObj = r.pointOfInterest?.mrt?.[0];
            const mrt = mrtObj
              ? `${mrtObj.walkingDurationMins} mins (${(mrtObj.walkingDistanceKm * 1000).toFixed(0)}m) from ${mrtObj.name}`
              : '';

            // Availability date
            const availRaw = r.dates?.available?.date || '';
            let availability = '';
            if (availRaw) {
              const dt = new Date(availRaw);
              availability = dt.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
            }

            // Listed date
            const postedRaw = r.dates?.firstPosted?.date || '';
            let listedDate = '';
            if (postedRaw) {
              const dt = new Date(postedRaw);
              listedDate = dt.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
            }

            // Furnishing — from detailsData.metatable.items
            const metaItems = data?.detailsData?.metatable?.items || [];
            let furnishing = '';
            for (const item of metaItems) {
              if (/fully furnished/i.test(item.value)) { furnishing = 'Fully Furnished'; break; }
              if (/partial(?:ly)? furnished/i.test(item.value)) { furnishing = 'Partially Furnished'; break; }
              if (/unfurnished/i.test(item.value)) { furnishing = 'Unfurnished'; break; }
            }

            // Tenure & lease
            const tenure = r.project?.metaByType?.verified?.tenure?.text
                        || r.project?.metaByType?.unverified?.tenure?.text || '';
            const leaseTerm = r.lease?.text || '';

            // Agent info — phone is directly in JSON!
            const agent = r.lister?.metaByType?.agent || {};
            const agentName = agent.name || '';
            const agentPhone = agent.contacts?.[0]?.value || '';
            const agentCea = agent.license || '';
            const agencyName = r.organization?.name || '';

            // Street address
            const streetAddress = r.location?.address?.full || r.location?.address?.street || '';

            const listing = {
              link: _extractUrl,
              projectName,
              address: projectName || streetAddress,
              streetAddress,
              priceRaw, priceDisplay,
              beds, baths, areaSqft,
              areaDisplay: areaSqft ? `${areaSqft.toLocaleString()} sqft` : '',
              furnishing, availability, mrt, listedDate, tenure, leaseTerm,
              agent: { name: agentName, phone: agentPhone, cea: agentCea, agency: agencyName, blocked: false },
            };
            return json({ success: true, listing });
          }
        } catch (parseErr) {
          // fall through to regex fallback
        }
      }

      // ── Priority 2: Regex fallback (improved) ─────────────────────────────
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const title = titleMatch?.[1] || '';
      const agentFromTitle = title.match(/by ([^,]+),\s*\d+/i)?.[1]?.trim() || '';
      const addressFromTitle = title.split(',')[0]?.trim() || '';

      const projectMatch = html.match(/"localizedTitle"\s*:\s*"([^"]+)"/i)
                        || html.match(/"projectName"\s*:\s*"([^"]+)"/i);
      const projectName = projectMatch?.[1] || addressFromTitle;
      const phoneMatch = html.match(/"\+65(\d{8})"/);
      const phone = phoneMatch ? '+65' + phoneMatch[1] : '';
      const ceaMatch = html.match(/R\d{7}[A-Z]/);
      const cea = ceaMatch?.[0] || '';
      const agencyMatch = html.match(/(ERA\s+REALTY|PROPNEX[^"<]{0,20}|ORANGETEE[^"<]{0,20}|HUTTONS[^"<]{0,20}|KNIGHT\s+FRANK|SAVILLS|SLP[^"<]{0,20}|NAVIS[^"<]{0,20}|CENTURY 21[^"<]{0,20})/i);
      const agency = agencyMatch?.[1]?.trim() || '';
      const priceMatch = html.match(/"value"\s*:\s*(\d+)/) || html.match(/S\$\s*([\d,]+)\s*\/?\s*mo/i);
      const priceRaw = priceMatch ? parseInt((priceMatch[1]||'').replace(/,/g,'')) : 0;
      const bedsMatch = html.match(/"bedrooms"\s*:\s*(\d+)/i) || html.match(/(\d+)\s*Bed/i);
      const bathsMatch = html.match(/"bathrooms"\s*:\s*(\d+)/i) || html.match(/(\d+)\s*Bath/i);
      // BUGFIX (2026-04-19): prefer JSON floorArea field, else find largest sqft match >= 50
      let areaSqft = null;
      const faMatch = html.match(/"floorArea"\s*:\s*"?(\d+)"?/i);
      if (faMatch) {
        const n = parseInt(faMatch[1]);
        if (!isNaN(n) && n >= 50) areaSqft = n;
      }
      if (areaSqft === null) {
        const all = [...html.matchAll(/([\d,]+)\s*sqft/gi)]
          .map(m => parseInt(m[1].replace(/,/g, '')))
          .filter(n => !isNaN(n) && n >= 50);
        if (all.length > 0) areaSqft = Math.max(...all);
      }
      const furnishMatch = html.match(/(Fully [Ff]urnished|Partial(?:ly)? [Ff]urnished|Unfurnished)/i);
      const mrtMatch = html.match(/"nearbyText"\s*:\s*"([^"]+)"/i);
      const tenureMatch = html.match(/(Freehold|Leasehold[^"<]{0,20})/i);
      const leaseMatch = html.match(/(\d+)\s+years?\s+lease/i);
      const listedMatch = html.match(/"postedOn"[^}]{0,60}"text"\s*:\s*"([^"]+)"/i)
                       || html.match(/Listed\s+on\s+(\d{1,2}\s+\w+\s+\d{4})/i);

      const listing = {
        link: _extractUrl, projectName,
        address: projectName, streetAddress: addressFromTitle,
        priceRaw, priceDisplay: priceRaw ? `$${Number(priceRaw).toLocaleString()}` : '',
        beds: bedsMatch ? parseInt(bedsMatch[1]) : null,
        baths: bathsMatch ? parseInt(bathsMatch[1]) : null,
        areaSqft, areaDisplay: areaSqft ? `${areaSqft.toLocaleString()} sqft` : '',
        furnishing: furnishMatch?.[1] || '',
        availability: '',
        mrt: mrtMatch?.[1] || '',
        tenure: tenureMatch?.[1] || '',
        leaseTerm: leaseMatch?.[0] || '',
        listedDate: listedMatch?.[1] || '',
        agent: { name: agentFromTitle, phone, cea, agency, blocked: false },
      };
      return json({ success: true, listing });

    } catch (err) {
      return json({ success: false, error: err.message });
    }
  }

  // ── Build search query parameters ────────────────────────────────────────
  const qp = new URLSearchParams();
  const mrtCodes = freetext ? detectMrtSearch(freetext) : null;
  if (mrtCodes) {
    for (const code of mrtCodes) qp.append("mrtStations", code);
    qp.set("_freetextDisplay", freetext);
  } else if (freetext) {
    qp.set("freetext", freetext);
  }
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
      if (t === "CONDO") { qp.append("propertyTypeCode","CONDO"); qp.append("propertyTypeCode","APT"); qp.append("propertyTypeCode","EXCO"); }
      else if (t === "LANDED") { qp.append("propertyTypeCode","TERRA"); qp.append("propertyTypeCode","DETAC"); qp.append("propertyTypeCode","SEMI"); qp.append("propertyTypeCode","BUNG"); qp.append("propertyTypeCode","GCONDO"); }
      else if (t === "HDB") { qp.append("propertyTypeCode","HDB"); qp.set("propertyTypeGroup","H"); }
    }
  }

  const pgPage = listingType === "rent" ? "property-for-rent" : "property-for-sale";
  const searchUrl = `${PG_BASE}/${pgPage}?${qp.toString()}`;

  try {
    let buildId = await getBuildId();
    if (!buildId) return json({ success: false, error: "Could not get PG buildId", blocked: true, searchUrl });
    const jsonUrl = `${PG_BASE}/_next/data/${buildId}/${pgPage}.json?${qp.toString()}`;
    let resp = await scraperFetch(jsonUrl, true);
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
    const pageSize = rawListings.length || 20;  // actual listings per page (PG returns ~20-21)
    const totalPages = paginationData.totalPages || 1;
    // PG JSON has no totalCount field — estimate from totalPages × pageSize
    const total = paginationData.totalCount || paginationData.total
      || (totalPages > 1 ? totalPages * pageSize : rawListings.length);
    if (rawListings.length === 0) return json({ success: true, total: 0, page, totalPages: 0, listings: [], searchUrl, mrtSearch: !!mrtCodes });
    const filtered = rawListings.filter(r => {
      const price = r.price?.value || 0;
      if (minPrice && price < Number(minPrice)) return false;
      if (maxPrice && price > Number(maxPrice)) return false;
      return true;
    });
    const listings = filtered.map(r => formatListing(r, listingType));
    return json({ success: true, total, page, totalPages, listings, searchUrl, blocked: false, mrtSearch: !!mrtCodes });
  } catch (err) {
    return json({ success: false, error: err.message || "Server error", searchUrl });
  }
};

function json(obj) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function formatListing(r, listingType) {
  // Price
  let priceRaw = r.price?.value || 0;
  if (!priceRaw && r.asking_price_cents) priceRaw = Math.round(r.asking_price_cents / 100);
  if (!priceRaw && r.asking_price) priceRaw = r.asking_price;
  if (!priceRaw && r.price?.localeStringValue) priceRaw = parseInt(r.price.localeStringValue.replace(/[^\d]/g,'')) || 0;
  const priceDisplay = priceRaw ? (listingType === "rent" ? `$${Number(priceRaw).toLocaleString()}/mo` : `$${Number(priceRaw).toLocaleString()}`) : "";

  // Beds / baths / area — CONFIRMED from live PG JSON:
  // r.bedrooms, r.bathrooms, r.floorArea are direct fields
  // r.area.localeStringValue is "807 sqft"
  // BUGFIX (2026-04-19): add sanity check — area must be >= 50 sqft
  let beds = r.bedrooms ?? null;
  let baths = r.bathrooms ?? null;
  let areaSqft = null;
  if (r.floorArea) {
    const n = parseInt(String(r.floorArea).replace(/[^\d]/g, '')) || null;
    if (n !== null && n >= 50) areaSqft = n;
  }
  if (areaSqft === null && r.area?.localeStringValue) {
    const n = parseInt(r.area.localeStringValue.replace(/[^\d]/g, "")) || null;
    if (n !== null && n >= 50) areaSqft = n;
  }
  if (areaSqft === null && r.area?.value) {
    const n = parseInt(String(r.area.value).replace(/[^\d]/g, '')) || null;
    if (n !== null && n >= 50) areaSqft = n;
  }
  // Fallback to listingFeatures if direct fields missing
  if ((beds === null || areaSqft === null) && r.listingFeatures) {
    const feats = Array.isArray(r.listingFeatures) ? r.listingFeatures.flat() : [];
    feats.forEach(f => {
      if (f.dataAutomationId === "listing-card-v2-bedrooms" && beds === null) beds = parseInt(f.text) || null;
      if (f.dataAutomationId === "listing-card-v2-bathrooms" && baths === null) baths = parseInt(f.text) || null;
      if (f.text?.includes("sqft") && areaSqft === null) {
        const n = parseInt(f.text.replace(/[^\d]/g, "")) || null;
        if (n !== null && n >= 50) areaSqft = n;
      }
    });
  }

  // CONFIRMED from live PG JSON:
  // localizedTitle = condo/project name e.g. "Principal Garden"
  // fullAddress    = street address e.g. "91 Prince Charles Crescent"
  const projectName = r.localizedTitle || "";
  const streetAddress = r.fullAddress || "";
  const displayAddress = projectName || streetAddress.split(",")[0]?.trim() || "";

  // MRT — r.mrt.nearbyText confirmed e.g. "14 min (1.17 km) from EW18 Redhill MRT Station"
  const mrt = r.mrt?.nearbyText || "";

  const availability = r.availabilityInfo || r.availability || "";

  // Listed date — CONFIRMED: r.postedOn.text = "15 Apr 2026"
  // r.recency.text = "Listed on Apr 15, 2026 (1h ago)"
  const listedDate = r.postedOn?.text
    || r.recency?.text?.replace(/^Listed on\s*/i, "").replace(/\s*\(.*\)$/, "").trim()
    || "";

  return {
    link: r.url ? (r.url.startsWith("http") ? r.url : PG_BASE + r.url) : "",
    projectName,
    address: displayAddress,
    streetAddress,
    priceRaw, priceDisplay,
    beds, baths, areaSqft,
    areaDisplay: areaSqft ? `${areaSqft.toLocaleString()} sqft` : "",
    furnishing: "",
    availability, mrt, listedDate,
    propertyType: r.typeText || "",
    tenure: r.additionalData?.tenure || "",
    leaseTerm: "",
    agent: {
      name: r.agent?.name || "",
      cea: r.agent?.license || r.agent?.cea || "",
      agency: r.agency?.name || r.agent?.agencyName || "",
      phone: "", blocked: false,
    },
  };
}

async function enrichPhone(listing) {
  if (!listing.link) return listing;
  try {
    const resp = await scraperFetch(listing.link);
    if (!resp.ok) return listing;
    const html = await resp.text();
    // Phone number from HTML source
    const phoneMatch = html.match(/"\+65(\d{8})"/);
    if (phoneMatch) listing.agent.phone = "+65" + phoneMatch[1];
    // Furnishing (not in search JSON, only in detail page)
    if (!listing.furnishing) {
      const fm = html.match(/(Fully [Ff]urnished|Partial(?:ly)? [Ff]urnished|Unfurnished)/i);
      if (fm) listing.furnishing = fm[1];
    }
    // Area fallback
    // BUGFIX (2026-04-19): PG detail HTML can contain spurious "2 sqft" strings
    // (e.g. unit-toggle icons or other UI chrome). Old regex `.match()` took the FIRST
    // which could be garbage. Now: find ALL matches, filter to >= 50 sqft, take largest.
    if (!listing.areaSqft) {
      const all = [...html.matchAll(/([\d,]+)\s*sqft/gi)]
        .map(m => parseInt(m[1].replace(/,/g, '')))
        .filter(n => !isNaN(n) && n >= 50);
      if (all.length > 0) {
        const best = Math.max(...all);
        listing.areaSqft = best;
        listing.areaDisplay = `${best.toLocaleString()} sqft`;
      }
    }
    // Lease term
    if (!listing.leaseTerm) {
      const lm = html.match(/(\d+)\s+years?\s+lease/i);
      if (lm) listing.leaseTerm = lm[0];
    }
    // Tenure fallback
    if (!listing.tenure) {
      const tm = html.match(/(Freehold|Leasehold\s*\d*)/i);
      if (tm) listing.tenure = tm[1];
    }
  } catch {}
  return listing;
}
