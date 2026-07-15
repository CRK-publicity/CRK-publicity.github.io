import { adminClient, allowedOrigin, cleanText, corsHeaders, json, normalizePhone, readBodyLimited, sha256 } from "../_shared/backend.ts";

const MAX_BODY_BYTES = 16_384;
const VALID_NEEDS = new Set([
  "Conseguir más prospectos",
  "Crear o mejorar mi página web",
  "Organizar clientes en un CRM",
  "Automatizar el seguimiento",
  "Tarjetas de negocio",
  "Avisos de neón o acrílico",
  "Vinilos o wraps",
  "Productos personalizados",
]);

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
    if (!payload || Array.isArray(payload) || typeof payload !== "object") return json({ error: "Solicitud inválida" }, 400, cors);
    if (cleanText(payload.website, 200)) return json({ accepted: true }, 202, cors);

    const name = cleanText(payload.name, 100);
    const email = cleanText(payload.email, 180).toLowerCase();
    const company = cleanText(payload.business, 140);
    const need = cleanText(payload.need, 240);
    const phone = normalizePhone(String(payload.phone || ""));
    if (name.length < 2 || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || company.length < 2 || !VALID_NEEDS.has(need) || payload.consent !== true) {
      return json({ error: "Revisa los datos del formulario" }, 422, cors);
    }

    const client = adminClient();
    const salt = Deno.env.get("IP_HASH_SALT");
    if (!salt || salt.length < 32) throw new Error("Rate limit configuration is incomplete");
    const ip = (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim().slice(0, 64);
    const fingerprint = await sha256(`${salt}:${ip}`);
    const rateResult = await client.rpc("check_lead_rate_limit", { p_fingerprint: fingerprint });
    if (rateResult.error) throw rateResult.error;
    if (rateResult.data !== true) return json({ error: "Espera unos minutos antes de intentarlo de nuevo" }, 429, cors);

    const leadResult = await client.rpc("ingest_public_lead", {
      p_name: name,
      p_email: email,
      p_phone: phone,
      p_company: company,
      p_need: need,
    });
    if (leadResult.error || !Array.isArray(leadResult.data) || leadResult.data.length !== 1) throw leadResult.error || new Error("Lead transaction returned invalid data");
    return json({ accepted: true }, 202, cors);
  } catch (error) {
    console.error("public-lead", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No pudimos registrar la solicitud. Escríbenos por WhatsApp." }, 500, cors);
  }
});
