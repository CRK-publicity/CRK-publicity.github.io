import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.3";

const encoder = new TextEncoder();
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Backend configuration is incomplete");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

export function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin") || "";
  const configured = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((item) => item.trim()).filter(Boolean);
  return configured.includes(origin) ? origin : "";
}

export function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

export function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizePhone(value: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("3")) digits = `57${digits}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

export async function readBodyLimited(request: Request, maxBytes: number) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("payload_too_large").catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export async function verifyMetaSignature(rawBody: string, signature: string | null) {
  const secret = Deno.env.get("META_APP_SECRET") || "";
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = `sha256=${[...new Uint8Array(signed)].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
  return safeEqual(expected, signature);
}

export function verifiedJwtPayload(token: string) {
  const encoded = token.split(".")[1];
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function sendWhatsAppText(to: string, body: string) {
  const token = Deno.env.get("META_ACCESS_TOKEN") || "";
  const phoneId = Deno.env.get("META_PHONE_NUMBER_ID") || "";
  const version = Deno.env.get("META_GRAPH_VERSION") || "";
  const normalizedTo = normalizePhone(to);
  if (!token || !/^\d+$/.test(phoneId) || !/^v\d+\.\d+$/.test(version)) throw new Error("WhatsApp configuration is incomplete");
  if (!normalizedTo || !body || body.length > 4096) throw new Error("WhatsApp message is invalid");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: normalizedTo.slice(1), type: "text", text: { preview_url: false, body } }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Meta rejected the message: ${response.status}`);
    const messageId = data.messages?.[0]?.id;
    if (typeof messageId !== "string" || !messageId) throw new Error("Meta did not return a message id");
    return messageId;
  } finally {
    clearTimeout(timeout);
  }
}