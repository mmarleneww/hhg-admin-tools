exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "API key not configured" }) };
  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }
  const { system, user } = body;
  if (!system || !user) return { statusCode: 400, body: JSON.stringify({ error: "Missing system or user prompt" }) };
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1024, system, messages: [{ role: "user", content: user }] }),
    });
    if (!response.ok) { const err = await response.text(); return { statusCode: response.status, body: JSON.stringify({ error: err }) }; }
    const data = await response.json();
    const text = data.content?.map(c => c.text || "").join("") || "";
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ result: text }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Server error" }) };
  }
};