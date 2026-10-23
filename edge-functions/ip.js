// EdgeOne runs this handler for /ip. There is no app.listen() or Express server.
export function onRequest({ request }) {
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...headers, Allow: "GET, HEAD" }
    });
  }

  // Use platform metadata, not user-supplied X-Forwarded-For headers.
  const ip = request.eo?.clientIp;
  const available = typeof ip === "string" && ip.length > 0;
  return new Response(request.method === "HEAD" ? null : available ? ip : "Client IP unavailable", {
    status: available ? 200 : 503,
    headers
  });
}
