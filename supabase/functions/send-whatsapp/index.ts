import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adminClient, allowedOrigin, corsHeaders, json, sendWhatsAppText } from "../_shared/backend.ts";

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST" || !origin) return json({ error: "Solicitud no permitida" }, 403, cors);
  const authHeader = request.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Debes iniciar sesión" }, 401, cors);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Sesión inválida" }, 401, cors);
    const admin = adminClient();
    const { data: profile } = await admin.from("profiles").select("role").eq("user_id", userData.user.id).maybeSingle();
    if (!profile || !["owner", "agent"].includes(profile.role)) return json({ error: "No autorizado" }, 403, cors);
    const input = await request.json();
    const conversationId = String(input.conversationId || "");
    const body = String(input.body || "").trim().slice(0, 4000);
    if (!/^[0-9a-f-]{36}$/i.test(conversationId) || !body) return json({ error: "Mensaje inválido" }, 422, cors);
    const { data: conversation, error } = await admin.from("conversations").select("id,contact_id,contacts(phone_e164)").eq("id", conversationId).eq("channel", "whatsapp").single();
    if (error || !conversation) return json({ error: "Conversación no encontrada" }, 404, cors);
    const phone = Array.isArray(conversation.contacts) ? conversation.contacts[0]?.phone_e164 : conversation.contacts?.phone_e164;
    if (!phone) return json({ error: "El cliente no tiene WhatsApp" }, 422, cors);
    const providerId = await sendWhatsAppText(phone, body);
    const sentAt = new Date().toISOString();
    await admin.from("messages").insert({ conversation_id: conversation.id, contact_id: conversation.contact_id, provider_message_id: providerId, direction: "outbound", message_type: "text", body, status: "sent", sent_at: sentAt });
    await admin.from("conversations").update({ status: "open", unread_count: 0, last_message_at: sentAt, updated_at: sentAt }).eq("id", conversation.id);
    await admin.from("activities").insert({ contact_id: conversation.contact_id, activity_type: "agent_reply", summary: "Respuesta enviada por WhatsApp", created_by: userData.user.id });
    return json({ sent: true, sentAt }, 200, cors);
  } catch (error) {
    console.error("send-whatsapp", error instanceof Error ? error.message : error);
    return json({ error: "No se pudo enviar el mensaje" }, 500, cors);
  }
});