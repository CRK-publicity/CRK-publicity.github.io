import { adminClient, json, normalizePhone, sendWhatsAppText, verifyMetaSignature } from "../_shared/backend.ts";

const MENU = "Hola, soy el asistente de CRK Publicity 👋\n¿En qué podemos ayudarte?\n\n1. Página web\n2. CRM y seguimiento\n3. Tarjetas de negocio\n4. Avisos, neón o vinilos\n5. Hablar con Iván\n\nResponde con un número.";
const REPLIES: Record<string, { intent: string; text: string }> = {
  "1": { intent: "pagina_web", text: "Perfecto. Cuéntame qué hace tu negocio y si ya tienes una página. Un asesor revisará tu caso." },
  "2": { intent: "crm", text: "Excelente. Podemos organizar clientes, conversaciones y seguimiento. ¿Cuántas personas atenderán el CRM?" },
  "3": { intent: "tarjetas", text: "Claro. Indícame cantidad, ciudad y si ya tienes diseño o necesitas que lo creemos." },
  "4": { intent: "avisos_vinilos", text: "Cuéntame qué necesitas, medidas aproximadas, ciudad y si es para interior o exterior." },
};

function messageText(message: any) {
  if (message.type === "text") return String(message.text?.body || "").trim();
  if (message.type === "button") return String(message.button?.text || "").trim();
  if (message.type === "interactive") return String(message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "").trim();
  return `[${message.type || "archivo"}]`;
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const valid = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === Deno.env.get("META_VERIFY_TOKEN");
    return valid ? new Response(url.searchParams.get("hub.challenge") || "", { status: 200 }) : new Response("Forbidden", { status: 403 });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await request.text();
  if (!(await verifyMetaSignature(raw, request.headers.get("x-hub-signature-256")))) return new Response("Invalid signature", { status: 401 });

  try {
    const payload = JSON.parse(raw);
    if (payload.object !== "whatsapp_business_account") return json({ received: true });
    const client = adminClient();
    for (const entry of payload.entry || []) for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const status of value.statuses || []) {
        await client.from("messages").update({ status: status.status }).eq("provider_message_id", status.id);
      }
      for (const message of value.messages || []) {
        const phone = normalizePhone(message.from || "");
        if (!phone || !message.id) continue;
        const body = messageText(message).slice(0, 4000);
        const profileName = String(value.contacts?.find((item: any) => item.wa_id === message.from)?.profile?.name || "Cliente").slice(0, 100);
        let { data: contact } = await client.from("contacts").select("id,lifecycle_stage").eq("phone_e164", phone).maybeSingle();
        if (!contact) {
          const result = await client.from("contacts").insert({ full_name: profileName, phone_e164: phone, source: "whatsapp", last_seen_at: new Date().toISOString() }).select("id,lifecycle_stage").single();
          if (result.error) throw result.error; contact = result.data;
        } else await client.from("contacts").update({ full_name: profileName, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", contact.id);
        let { data: conversation } = await client.from("conversations").select("id,status,bot_state").eq("contact_id", contact.id).eq("channel", "whatsapp").maybeSingle();
        if (!conversation) {
          const result = await client.from("conversations").insert({ contact_id: contact.id, channel: "whatsapp", status: "bot", last_message_at: new Date().toISOString() }).select("id,status,bot_state").single();
          if (result.error) throw result.error;
          conversation = result.data;
        }
        const insert = await client.from("messages").upsert({ conversation_id: conversation.id, contact_id: contact.id, provider_message_id: message.id, direction: "inbound", message_type: message.type || "unknown", body, status: "received", sent_at: new Date(Number(message.timestamp || Date.now() / 1000) * 1000).toISOString() }, { onConflict: "provider_message_id", ignoreDuplicates: true }).select("id").maybeSingle();
        if (!insert.data) continue;
        await client.from("conversations").update({ unread_count: 1, last_message_at: new Date().toISOString() }).eq("id", conversation.id);
        if (conversation.status !== "bot") continue;

        const normalized = body.toLowerCase();
        const handoff = normalized === "5" || /asesor|humano|persona|iv[aá]n/.test(normalized);
        let reply = MENU;
        let statusValue = "bot";
        let botState: Record<string, unknown> = conversation.bot_state || {};
        if (handoff) {
          reply = "Listo. He marcado tu conversación para atención personal. Iván continuará contigo tan pronto esté disponible.";
          statusValue = "waiting";
          botState = { ...botState, handoff_requested_at: new Date().toISOString() };
        } else if (REPLIES[body.trim()]) {
          const selected = REPLIES[body.trim()];
          reply = `${selected.text}\n\nPara volver al menú escribe MENÚ.`;
          botState = { ...botState, intent: selected.intent, qualified_at: new Date().toISOString() };
          await client.from("contacts").update({ lifecycle_stage: "qualified", updated_at: new Date().toISOString() }).eq("id", contact.id);
        } else if (normalized === "menu" || normalized === "menú" || body === `[${message.type || "archivo"}]`) reply = MENU;
        else if (botState.intent) reply = "Gracias, ya guardé esta información. Un asesor la revisará. Si quieres atención personal escribe ASESOR.";

        const providerId = await sendWhatsAppText(phone, reply);
        await client.from("messages").insert({ conversation_id: conversation.id, contact_id: contact.id, provider_message_id: providerId, direction: "outbound", message_type: "text", body: reply, status: "sent", sent_at: new Date().toISOString() });
        await client.from("conversations").update({ status: statusValue, bot_state: botState, last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", conversation.id);
      }
    }
    return json({ received: true });
  } catch (error) {
    console.error("whatsapp-webhook", error instanceof Error ? error.message : error);
    return json({ error: "processing_failed" }, 500);
  }
});