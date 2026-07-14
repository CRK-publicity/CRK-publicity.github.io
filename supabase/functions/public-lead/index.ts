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

    let { data: contact, error: lookupError } = await client.from("contacts").select("id").eq("phone_e164", phone).maybeSingle();
    if (lookupError) throw lookupError;
    if (!contact) {
      const emailLookup = await client.from("contacts").select("id").eq("email", email).maybeSingle();
      if (emailLookup.error) throw emailLookup.error;
      contact = emailLookup.data;
    }
    const now = new Date().toISOString();
    const contactData = { full_name: name, phone_e164: phone, email, company, source: "web", consent_status: "granted", consent_at: now, last_seen_at: now };
    if (contact) {
      const result = await client.from("contacts").update(contactData).eq("id", contact.id).select("id").single();
      if (result.error) throw result.error;
      contact = result.data;
    } else {
      const result = await client.from("contacts").insert(contactData).select("id").single();
      if (result.error) throw result.error;
      contact = result.data;
    }
    const conversationResult = await client.from("conversations").upsert({ contact_id: contact.id, channel: "web", status: "open", unread_count: 1, last_message_at: now }, { onConflict: "contact_id,channel" }).select("id").single();
    if (conversationResult.error) throw conversationResult.error;
    const requestMessage = `Nueva solicitud desde la web\n\nServicio: ${need}\nNegocio: ${company}\nCliente: ${name}\nCorreo: ${email}\nWhatsApp: ${phone}`;
    const messageResult = await client.from("messages").insert({ conversation_id: conversationResult.data.id, contact_id: contact.id, direction: "inbound", message_type: "lead_form", body: requestMessage, status: "received", sent_at: now });
    if (messageResult.error) throw messageResult.error;
    const activityResult = await client.from("activities").insert({ contact_id: contact.id, activity_type: "lead_form", summary: need, metadata: { company, email, phone, consent_at: now, page: "portfolio" } });
    if (activityResult.error) throw activityResult.error;
    return json({ accepted: true }, 202, cors);
  } catch (error) {
    console.error("public-lead", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No pudimos registrar la solicitud. Escríbenos por WhatsApp." }, 500, cors);
  }
});