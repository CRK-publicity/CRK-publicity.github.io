import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.3";
import { adminClient, allowedOrigin, corsHeaders, json, readBodyLimited, sendWhatsAppText } from "../_shared/backend.ts";

const MAX_BODY_BYTES = 8_192;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST" || !origin) return json({ error: "Solicitud no permitida" }, 403, cors);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Tipo de contenido no permitido" }, 415, cors);
  const authHeader = request.headers.get("authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) return json({ error: "Debes iniciar sesión" }, 401, cors);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Solicitud demasiado grande" }, 413, cors);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data: userData, error: userError } = await userClient.auth.getUser(accessToken);
    if (userError || !userData.user) return json({ error: "Sesión inválida" }, 401, cors);
    const { data: assurance, error: assuranceError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError || assurance?.currentLevel !== "aal2") return json({ error: "Se requiere verificación en dos pasos" }, 403, cors);

    const admin = adminClient();
    const { data: profile, error: profileError } = await admin.from("profiles").select("role").eq("user_id", userData.user.id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile || !["owner", "agent"].includes(profile.role)) return json({ error: "No autorizado" }, 403, cors);

    const bytes = await readBodyLimited(request, MAX_BODY_BYTES);
    if (!bytes) return json({ error: "Solicitud demasiado grande" }, 413, cors);
    const input = JSON.parse(new TextDecoder().decode(bytes));
    const conversationId = String(input?.conversationId || "");
    const body = String(input?.body || "").trim();
    if (!UUID_PATTERN.test(conversationId) || !body || body.length > 4000) return json({ error: "Mensaje inválido" }, 422, cors);

    const conversationResult = await admin.from("conversations").select("id,contact_id,contacts(phone_e164)").eq("id", conversationId).eq("channel", "whatsapp").single();
    if (conversationResult.error || !conversationResult.data) return json({ error: "Conversación no encontrada" }, 404, cors);
    const conversation = conversationResult.data;
    const phone = Array.isArray(conversation.contacts) ? conversation.contacts[0]?.phone_e164 : conversation.contacts?.phone_e164;
    if (!phone) return json({ error: "El cliente no tiene WhatsApp" }, 422, cors);

    const providerId = await sendWhatsAppText(phone, body);
    const sentAt = new Date().toISOString();
    const messageResult = await admin.from("messages").insert({ conversation_id: conversation.id, contact_id: conversation.contact_id, provider_message_id: providerId, direction: "outbound", message_type: "text", body, status: "sent", sent_at: sentAt });
    if (messageResult.error) throw messageResult.error;
    const conversationUpdate = await admin.from("conversations").update({ status: "open", unread_count: 0, last_message_at: sentAt }).eq("id", conversation.id);
    if (conversationUpdate.error) throw conversationUpdate.error;
    const activityResult = await admin.from("activities").insert({ contact_id: conversation.contact_id, activity_type: "agent_reply", summary: "Respuesta enviada por WhatsApp", created_by: userData.user.id });
    if (activityResult.error) throw activityResult.error;
    return json({ sent: true, sentAt }, 200, cors);
  } catch (error) {
    console.error("send-whatsapp", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No se pudo enviar el mensaje" }, 500, cors);
  }
});
