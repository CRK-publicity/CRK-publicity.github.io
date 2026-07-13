import { adminClient, json, normalizePhone, readBodyLimited, safeEqual, sendWhatsAppText, verifyMetaSignature } from "../_shared/backend.ts";

const MAX_WEBHOOK_BYTES = 1_048_576;
const VALID_STATUSES = new Set(["sent", "delivered", "read", "failed", "deleted"]);
const MENU = "Hola, soy el asistente de CRK Publicity 👋\n¿En qué podemos ayudarte?\n\n1. Página web\n2. CRM y seguimiento\n3. Tarjetas de negocio\n4. Avisos, neón o vinilos\n5. Hablar con Iván\n\nResponde con un número.";
const REPLIES: Record<string, { intent: string; text: string }> = {
  "1": { intent: "pagina_web", text: "Perfecto. Cuéntame qué hace tu negocio y si ya tienes una página. Un asesor revisará tu caso." },
  "2": { intent: "crm", text: "Excelente. Podemos organizar clientes, conversaciones y seguimiento. ¿Cuántas personas atenderán el CRM?" },
  "3": { intent: "tarjetas", text: "Claro. Indícame la cantidad, la ciudad y si ya tienes el diseño o necesitas que lo creemos." },
  "4": { intent: "avisos_vinilos", text: "Cuéntame qué necesitas, las medidas aproximadas, la ciudad y si es para interiores o exteriores." },
};

type WhatsAppMessage = {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
};

function messageText(message: WhatsAppMessage) {
  if (message.type === "text") return String(message.text?.body || "").trim();
  if (message.type === "button") return String(message.button?.text || "").trim();
  if (message.type === "interactive") return String(message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "").trim();
  return `[${message.type || "archivo"}]`;
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const supplied = url.searchParams.get("hub.verify_token") || "";
    const expected = Deno.env.get("META_VERIFY_TOKEN") || "";
    const valid = url.searchParams.get("hub.mode") === "subscribe" && expected.length >= 32 && safeEqual(supplied, expected);
    return valid ? new Response(url.searchParams.get("hub.challenge") || "", { status: 200, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }) : new Response("Forbidden", { status: 403 });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_WEBHOOK_BYTES) return json({ error: "payload_too_large" }, 413);
  const bytes = await readBodyLimited(request, MAX_WEBHOOK_BYTES);
  if (!bytes) return json({ error: "payload_too_large" }, 413);
  const raw = new TextDecoder().decode(bytes);
  if (!(await verifyMetaSignature(raw, request.headers.get("x-hub-signature-256")))) return new Response("Invalid signature", { status: 401 });

  try {
    const payload = JSON.parse(raw);
    if (payload?.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) return json({ received: true });
    const client = adminClient();
    for (const entry of payload.entry) for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        if (typeof status?.id !== "string" || !VALID_STATUSES.has(status?.status)) continue;
        const update = await client.from("messages").update({ status: status.status }).eq("provider_message_id", status.id);
        if (update.error) throw update.error;
      }
      for (const message of (Array.isArray(value.messages) ? value.messages : []) as WhatsAppMessage[]) {
        const phone = normalizePhone(message.from || "");
        if (!phone || typeof message.id !== "string" || !message.id) continue;
        const body = messageText(message).slice(0, 4000);
        const profileName = String(value.contacts?.find((item: { wa_id?: string; profile?: { name?: string } }) => item.wa_id === message.from)?.profile?.name || "Cliente").normalize("NFKC").trim().slice(0, 100);
        let { data: contact, error: contactLookupError } = await client.from("contacts").select("id,lifecycle_stage").eq("phone_e164", phone).maybeSingle();
        if (contactLookupError) throw contactLookupError;
        const now = new Date().toISOString();
        if (!contact) {
          const result = await client.from("contacts").insert({ full_name: profileName || "Cliente", phone_e164: phone, source: "whatsapp", last_seen_at: now }).select("id,lifecycle_stage").single();
          if (result.error) throw result.error;
          contact = result.data;
        } else {
          const update = await client.from("contacts").update({ full_name: profileName || "Cliente", last_seen_at: now }).eq("id", contact.id);
          if (update.error) throw update.error;
        }

        let { data: conversation, error: conversationLookupError } = await client.from("conversations").select("id,status,bot_state").eq("contact_id", contact.id).eq("channel", "whatsapp").maybeSingle();
        if (conversationLookupError) throw conversationLookupError;
        if (!conversation) {
          const result = await client.from("conversations").insert({ contact_id: contact.id, channel: "whatsapp", status: "bot", last_message_at: now }).select("id,status,bot_state").single();
          if (result.error) throw result.error;
          conversation = result.data;
        }

        const seconds = Number(message.timestamp);
        const sentAt = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : now;
        const insert = await client.from("messages").upsert({ conversation_id: conversation.id, contact_id: contact.id, provider_message_id: message.id, direction: "inbound", message_type: message.type || "unknown", body, status: "received", sent_at: sentAt }, { onConflict: "provider_message_id", ignoreDuplicates: true }).select("id").maybeSingle();
        if (insert.error) throw insert.error;
        if (!insert.data) continue;
        const unreadUpdate = await client.from("conversations").update({ unread_count: 1, last_message_at: now }).eq("id", conversation.id);
        if (unreadUpdate.error) throw unreadUpdate.error;
        if (conversation.status !== "bot") continue;

        const normalized = body.toLocaleLowerCase("es");
        const handoff = normalized === "5" || /asesor|humano|persona|iv[aá]n/.test(normalized);
        let reply = MENU;
        let statusValue = "bot";
        let botState: Record<string, unknown> = conversation.bot_state || {};
        if (handoff) {
          reply = "Listo. He marcado tu conversación para atención personal. Iván continuará contigo tan pronto como esté disponible.";
          statusValue = "waiting";
          botState = { ...botState, handoff_requested_at: now };
        } else if (REPLIES[body.trim()]) {
          const selected = REPLIES[body.trim()];
          reply = `${selected.text}\n\nPara volver al menú, escribe MENÚ.`;
          botState = { ...botState, intent: selected.intent, qualified_at: now };
          const stageUpdate = await client.from("contacts").update({ lifecycle_stage: "qualified" }).eq("id", contact.id);
          if (stageUpdate.error) throw stageUpdate.error;
        } else if (normalized === "menu" || normalized === "menú" || body === `[${message.type || "archivo"}]`) {
          reply = MENU;
        } else if (botState.intent) {
          reply = "Gracias, ya guardé esta información. Un asesor la revisará. Si quieres atención personal, escribe ASESOR.";
        }

        const providerId = await sendWhatsAppText(phone, reply);
        const outbound = await client.from("messages").insert({ conversation_id: conversation.id, contact_id: contact.id, provider_message_id: providerId, direction: "outbound", message_type: "text", body: reply, status: "sent", sent_at: now });
        if (outbound.error) throw outbound.error;
        const conversationUpdate = await client.from("conversations").update({ status: statusValue, bot_state: botState, last_message_at: now }).eq("id", conversation.id);
        if (conversationUpdate.error) throw conversationUpdate.error;
      }
    }
    return json({ received: true });
  } catch (error) {
    console.error("whatsapp-webhook", error instanceof Error ? error.message : "unknown error");
    return json({ error: "processing_failed" }, 500);
  }
});