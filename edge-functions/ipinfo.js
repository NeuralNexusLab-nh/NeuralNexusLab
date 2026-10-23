// /ipinfo queries the visitor's IP, not the function's outbound IP.
export async function onRequest({ request, env }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  const json = (data, status = 200) => new Response(
    request.method === "HEAD" ? null : JSON.stringify(data),
    { status, headers }
  );

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...headers, Allow: "GET, HEAD" }
    });
  }

  const token = typeof env?.TOKEN === "string" ? env.TOKEN.trim() : "";
  if (!token) return json({ error: "TOKEN is not configured" }, 503);

  const ip = request.eo?.clientIp;
  if (typeof ip !== "string" || !ip) {
    return json({ error: "Client IP unavailable" }, 503);
  }
  // HEAD returns metadata without spending an upstream request.
  if (request.method === "HEAD") return json(null);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(token)}`,
      {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: controller.signal
      }
    );
    if (!response.ok) {
      // Do not expose provider error bodies, URLs, or credentials.
      return json({ error: "IP information provider rejected the request" }, response.status);
    }
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.ip !== "string") {
      return json({ error: "Invalid response from IP information provider" }, 502);
    }
    return json(data);
  } catch {
    return controller.signal.aborted
      ? json({ error: "IP information request timed out" }, 504)
      : json({ error: "Failed to fetch IP information" }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
