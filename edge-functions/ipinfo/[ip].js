import { lookupIpInfo } from "../ipinfo.js";

function isIPAddress(ip) {
  if (typeof ip !== "string" || ip.length > 45) return false;

  if (!ip.includes(":")) {
    const octets = ip.split(".");
    return octets.length === 4 && octets.every(octet =>
      /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255
    );
  }

  // Reject URLs, brackets, ports, zone IDs, and non-IP input before URL parsing.
  if (!/^[\da-f:.]+$/i.test(ip)) return false;
  try {
    // The standard URL parser validates compressed and IPv4-mapped IPv6.
    new URL(`https://[${ip}]/`);
    return true;
  } catch {
    return false;
  }
}

export function onRequest(context) {
  const ip = context.params?.ip;
  if ((context.request.method === "GET" || context.request.method === "HEAD") && !isIPAddress(ip)) {
    return new Response(context.request.method === "HEAD" ? null : JSON.stringify({ error: "Invalid IP address" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }
  return lookupIpInfo(context, ip);
}
