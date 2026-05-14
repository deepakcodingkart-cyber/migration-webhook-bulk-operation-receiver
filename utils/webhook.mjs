import crypto from "crypto";

export function getHeader(headers = {}, key) {
  const lower = key.toLowerCase();
  const found = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  return found ? headers[found] : null;
}

export function verifyShopifyWebhook(event) {
  const hmacHeader = getHeader(event.headers, "X-Shopify-Hmac-Sha256");
  if (!hmacHeader) return false;

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : Buffer.from(event.body, "utf8");

  const generatedHmac = crypto
    .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(generatedHmac, "utf8"),
      Buffer.from(hmacHeader, "utf8")
    );
  } catch {
    return false;
  }
}

export function response(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  };
}

// Returns elapsed time since `startTime` (Date.now()) as "Xms" or "X.YYs"
export function calculateDuration(startTime) {
  const ms = Date.now() - startTime;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}
