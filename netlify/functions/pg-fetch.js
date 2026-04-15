exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { url } = body;
  if (!url || !url.includes("propertyguru.com.sg")) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid PropertyGuru URL" }) };
  }

  try {
    // Fetch PropertyGuru listing with browser-like headers
    const pgResponse = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      redirect: "follow",
    });

    if (!pgResponse.ok) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `PropertyGuru returned ${pgResponse.status}`, blocked: true }),
      };
    }

    const html = await pgResponse.text();

    // Check if we got the actual listing page or a bot-blocked page
    if (html.includes("Cloudflare") || html.includes("cf-browser-verification") || html.includes("Just a moment")) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "PropertyGuru blocked the request", blocked: true }),
      };
    }

    // Extract key fields using regex from the HTML
    const extracted = extractListingData(html, url);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, data: extracted }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Fetch failed", blocked: true }),
    };
  }
};

function extractListingData(html, url) {
  const result = { url };

  // Try to extract from JSON-LD structured data first (most reliable)
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const script of jsonLdMatch) {
      try {
        const jsonStr = script.replace(/<script[^>]*>/, "").replace(/<\/script>/, "").trim();
        const data = JSON.parse(jsonStr);
        if (data["@type"] === "SingleFamilyResidence" || data["@type"] === "Apartment" || data["@type"] === "RealEstateListing" || data.name) {
          result.address = data.name || data.address?.streetAddress || "";
          result.price = data.offers?.price || data.price || "";
          result.priceCurrency = data.offers?.priceCurrency || "SGD";
          result.description = (data.description || "").substring(0, 500);
        }
      } catch {}
    }
  }

  // Extract from meta tags
  const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1] || "";
  const ogDesc = html.match(/<meta property="og:description" content="([^"]+)"/i)?.[1] || "";
  const metaDesc = html.match(/<meta name="description" content="([^"]+)"/i)?.[1] || "";

  if (!result.address && ogTitle) result.address = ogTitle;
  if (!result.description) result.description = ogDesc || metaDesc;

  // Extract price patterns like S$40,000/mo or $40,000
  const priceMatch = html.match(/S?\$\s*[\d,]+(?:\s*\/\s*mo(?:nth)?)?/i);
  if (priceMatch && !result.price) result.price = priceMatch[0];

  // Extract bedroom/bathroom counts
  const bedMatch = html.match(/(\d+)\s*(?:Bed(?:room)?s?|BR)/i);
  const bathMatch = html.match(/(\d+)\s*(?:Bath(?:room)?s?|BA)/i);
  if (bedMatch) result.beds = bedMatch[1];
  if (bathMatch) result.baths = bathMatch[1];

  // Extract floor area
  const areaMatch = html.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft|sq ft)/i);
  if (areaMatch) result.area = areaMatch[1].replace(/,/g, "") + " sqft";

  // Extract availability
  const availMatch = html.match(/(?:Available|Move in|Avail(?:able)?)\s*(?:from\s*)?([A-Z][a-z]+\s+\d{4}|\d{1,2}\s+[A-Z][a-z]+\s+\d{4}|Now|Immediately)/i);
  if (availMatch) result.availability = availMatch[1];

  // Extract furnishing
  if (/fully\s*furnished/i.test(html)) result.furnishing = "Fully Furnished";
  else if (/partial(?:ly)?\s*furnished/i.test(html)) result.furnishing = "Partial Furnished";
  else if (/unfurnished/i.test(html)) result.furnishing = "Unfurnished";

  // Pass raw text snippets for AI to parse if we didn't get enough
  // Extract visible text from title area
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (titleMatch) result.titleHtml = titleMatch[1].replace(/<[^>]+>/g, " ").trim().substring(0, 200);

  return result;
}
