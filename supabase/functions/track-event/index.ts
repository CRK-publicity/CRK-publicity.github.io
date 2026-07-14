import { adminClient, allowedOrigin, corsHeaders, json, readBodyLimited, sha256 } from "../_shared/backend.ts";

const MAX_BODY_BYTES = 2_048;
const VALID_EVENTS = new Set(["visit", "click"]);

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST") return json({ error: "Método no permitido" }, 405, cors);
  if (!origin) return json({ error: "Origen no permitido" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Tipo de contenido no permitido" }, 415, cors);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Solicitud demasiado grande" }, 413, cors);

  try {
    const bytes = await readBodyLimited(request, MAX_BODY_BYTES);
    if (!bytes) return json({ error: "Solicitud demasiado grande" }, 413, cors);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const eventType = String(payload?.eventType || "");
    if (!VALID_EVENTS.has(eventType)) return json({ error: "Evento inválido" }, 422, cors);
    const salt = Deno.env.get("IP_HASH_SALT");
    if (!salt || salt.length < 32) throw new Error("Analytics configuration is incomplete");
    const ip = (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim().slice(0, 64);
    const eventDay = new Date().toISOString().slice(0, 10);
    const fingerprint = await sha256(`${salt}:${eventDay}:${ip}`);
    const result = await adminClient().rpc("record_site_event", { p_fingerprint: fingerprint, p_event_type: eventType });
    if (result.error) throw result.error;
    return json({ accepted: true }, 202, cors);
  } catch (error) {
    console.error("track-event", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No se pudo registrar el evento" }, 500, cors);
  }
});
