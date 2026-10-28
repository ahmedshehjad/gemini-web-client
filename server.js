import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.GEMINI_API_KEY || "";
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://ahmedshehjad.github.io";
const ALLOWED_MODELS = new Set(
  (process.env.GEMINI_ALLOWED_MODELS || "gemini-3.8-flash,gemini-3.1-flash-lite")
    .split(",").map(s => s.trim()).filter(Boolean)
);
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const requestBuckets = new Map();
const MAX_BODY = 12 * 1024 * 1024;

function send(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  res.end(payload);
}

function getClientIp(req) {
  // Render supplies this header; do not trust arbitrary X-Forwarded-For values.
  return req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
}

function rateLimited(req) {
  const now = Date.now();
  const ip = getClientIp(req);
  let bucket = requestBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    requestBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (requestBuckets.size > 5000) {
    for (const [key, value] of requestBuckets) {
      if (now - value.startedAt >= WINDOW_MS) requestBuckets.delete(key);
    }
  }
  return bucket.count > MAX_REQUESTS;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== SITE_ORIGIN) {
    send(res, 403, { error: "Origin not allowed." });
    return false;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY) {
      const err = new Error("Request body too large.");
      err.status = 413;
      throw err;
    }
  }
  try { return JSON.parse(raw || "{}"); }
  catch {
    const err = new Error("Invalid JSON body.");
    err.status = 400;
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) return;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true, service: "gemini-web-client-backend", apiKeyConfigured: Boolean(API_KEY) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    send(res, 200, { models: [...ALLOWED_MODELS] });
    return;
  }


  if (req.method === "POST" && url.pathname === "/api/image") {
    if (rateLimited(req)) {
      send(res, 429, { error: "Too many requests. Please wait one minute and try again." });
      return;
    }
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
    const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN || "";
    if (!accountId || !cloudflareToken) {
      send(res, 503, { error: "FLUX image generation is not configured yet. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to the backend environment." });
      return;
    }
    try {
      const body = await readJson(req);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt || prompt.length > 2048) {
        send(res, 400, { error: "A prompt between 1 and 2048 characters is required." });
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      let upstream;
      try {
        upstream = await fetch(
          "https://api.cloudflare.com/client/v4/accounts/" +
            encodeURIComponent(accountId) +
            "/ai/run/@cf/black-forest-labs/flux-1-schnell",
          {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + cloudflareToken,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ prompt, steps: 4 }),
            signal: controller.signal
          }
        );
      } finally {
        clearTimeout(timeout);
      }
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        const providerMessage = data?.errors?.map(e => e.message).filter(Boolean).join("; ");
        const message = upstream.status === 429
          ? "Cloudflare's free daily AI allowance or temporary capacity limit has been reached. Try again later."
          : upstream.status === 403
            ? "Cloudflare denied access to FLUX. Check that Workers AI is enabled and the API token has AI:Run permission."
            : (providerMessage || "Cloudflare could not generate this image.");
        const status = [400, 401, 403, 429].includes(upstream.status) ? upstream.status : 502;
        send(res, status, { error: message });
        return;
      }
      const image = data?.result?.image;
      if (typeof image !== "string" || !image.length) {
        send(res, 502, { error: "Cloudflare returned no image data." });
        return;
      }
      send(res, 200, { dataUrl: "data:image/jpeg;base64," + image, model: "FLUX.1 schnell" });
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 502;
      const message = err.name === "AbortError"
        ? "Image generation timed out. Please try again."
        : (status === 413 ? "Request body too large." : (status === 400 ? err.message : "The image service could not complete the request."));
      send(res, status, { error: message });
    }
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/api/chat") {
    send(res, 404, { error: "Not found." });
    return;
  }

  if (rateLimited(req)) {
    send(res, 429, { error: "Too many requests. Please wait one minute and try again." });
    return;
  }
  if (!API_KEY) {
    send(res, 503, { error: "Backend is deployed but GEMINI_API_KEY has not been configured in the server environment." });
    return;
  }

  try {
    const body = await readJson(req);
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const contents = body.contents;
    if (!ALLOWED_MODELS.has(model)) {
      send(res, 400, { error: "This model is not on the server's allowed-model list." });
      return;
    }
    if (!Array.isArray(contents) || contents.length === 0 || contents.length > 80) {
      send(res, 400, { error: "A non-empty contents array is required." });
      return;
    }
    const validContents = contents.every(item =>
      item && ["user", "model"].includes(item.role) &&
      Array.isArray(item.parts) && item.parts.length > 0
    );
    if (!validContents) {
      send(res, 400, { error: "Invalid message contents." });
      return;
    }

    // If a free model is temporarily busy or rate-limited, try one other explicitly allowed free model.
    const candidates = [model, ...[...ALLOWED_MODELS].filter(candidate => candidate !== model).slice(0, 1)];
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const candidate = candidates[attempt];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45_000);
      let upstream;
      try {
        upstream = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" +
            encodeURIComponent(candidate) + ":generateContent?key=" + encodeURIComponent(API_KEY),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents,
              generationConfig: body.generationConfig && typeof body.generationConfig === "object"
                ? body.generationConfig : { temperature: 0.7, maxOutputTokens: 8192 }
            }),
            signal: controller.signal
          }
        );
      } catch (err) {
        if (attempt < candidates.length - 1) continue;
        throw err;
      } finally {
        clearTimeout(timeout);
      }
      const data = await upstream.json().catch(() => ({}));
      if (upstream.ok) {
        if (candidate !== model) data._fallbackModel = candidate;
        send(res, 200, data);
        return;
      }
      const retryable = [429, 500, 502, 503, 504].includes(upstream.status);
      if (retryable && attempt < candidates.length - 1) continue;
      const status = [400, 401, 403, 404, 429].includes(upstream.status) ? upstream.status : 502;
      const message = data?.error?.message || "The upstream AI provider rejected the request.";
      send(res, status, { error: message });
      return;
    }
  } catch (err) {
    const status = Number.isInteger(err.status) ? err.status : 502;
    const message = err.name === "AbortError"
      ? "The AI request timed out. Please try again."
      : (status === 413 ? "Request body too large." : (status === 400 ? err.message : "The backend could not complete the AI request."));
    send(res, status, { error: message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  // Never print the API key or request payloads to logs.
  console.log("Gemini proxy listening on port " + PORT);
});
