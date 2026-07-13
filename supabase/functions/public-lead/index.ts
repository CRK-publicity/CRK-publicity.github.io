import { adminClient, allowedOrigin, corsHeaders, json, normalizePhone, sha256 } from "../_shared/backend.ts";

const MAX_BODY_BYTES = 16_384;
const WINDOW_MINUTES = 15;
const MAX_REQUESTS = 5;

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST") return json({ error: "Método no permitido" }, 405, cors);
  if (!origin) return json({ error: "Origen no permitido" }, 403);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES || !request.headers.get("content-type")?.includes("application/json")) return json({ error: "Solicitud inválida" }, 400, cors);

  try {
    const payload = await request.json();
    if (payload.website) return json({ accepted: true }, 202, cors);
    const name = String(payload.name || "").trim().slice(0, 100);
    const email = String(payload.email || "").trim().toLowerCase().slice(0, 180);
    const company = String(payload.business || "").trim().slice(0, 140);
    const need = String(payload.need || "").trim().slice(0, 240);
    const phone = normalizePhone(String(payload.phone || ""));
    if (name.length < 2 || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || company.length < 2 || !need || payload.consent !== true) {
      return json({ error: "Revisa los datos del formulario" }, 422, cors);
    }

    const client = adminClient();
    const ip = (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    const fingerprint = await sha256(`${Deno.env.get("IP_HASH_SALT") || ""}:${ip}`);
    const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
    const { count } = await client.from("lead_requests").select("id", { count: "exact", head: true }).eq("fingerprint_hash", fingerprint).gte("created_at", since);
    if ((count || 0) >= MAX_REQUESTS) return json({ error: "Espera unos minutos antes de intentarlo de nuevo" }, 429, cors);
    await client.from("lead_requests").insert({ fingerprint_hash: fingerprint });

    let { data: contact } = await client.from("contacts").select("id").eq("phone_e164", phone).maybeSingle();
    if (!contact) ({ data: contact } = await client.from("contacts").select("id").ilike("email", email).maybeSingle());
    const contactData = { full_name: name, phone_e164: phone, email, company, source: "web", consent_status: "granted", consent_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (contact) {
      const result = await client.from("contacts").update(contactData).eq("id", contact.id).select("id").single();
      if (result.error) throw result.error;
      contact = result.data;
    } else {
      const result = await client.from("contacts").insert(contactData).select("id").single();
      if (result.error) throw result.error;
      contact = result.data;
    }
    const conversationResult = await client.from("conversations").upsert({ contact_id: contact.id, channel: "web", status: "open", last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "contact_id,channel" }).select("id").single();
    if (conversationResult.error) throw conversationResult.error;
    const activityResult = await client.from("activities").insert({ contact_id: contact.id, activity_type: "lead_form", summary: need, metadata: { company, page: "portfolio" } });
    if (activityResult.error) throw activityResult.error;
    return json({ accepted: true, reference: contact.id.slice(0, 8) }, 202, cors);
  } catch (error) {
    console.error("public-lead", error instanceof Error ? error.message : error);
    return json({ error: "No pudimos registrar la solicitud. Escríbenos por WhatsApp." }, 500, cors);
  }
});