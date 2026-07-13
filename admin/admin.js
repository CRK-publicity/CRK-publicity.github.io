import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const $ = (selector) => document.querySelector(selector);
const setup = $("#setup"), login = $("#login"), workspace = $("#workspace");
let supabase, activeConversation = null, contactsCache = [];

function show(element) { [setup, login, workspace].forEach((item) => { item.hidden = item !== element; }); }
function toast(message) { const node = $("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 3200); }
function formatDate(value) { if (!value) return "—"; return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }

async function boot() {
  if (!supabaseUrl || !supabaseKey) { show(setup); return; }
  supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  const { data } = await supabase.auth.getSession();
  await setSession(data.session);
  supabase.auth.onAuthStateChange((_event, session) => setTimeout(() => setSession(session), 0));
}

async function setSession(session) {
  if (!session) { show(login); $("#logout").hidden = true; return; }
  show(workspace); $("#logout").hidden = false; $("#session-name").textContent = session.user.email || "";
  await loadDashboard();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.currentTarget.querySelector("button"); const data = new FormData(event.currentTarget);
  button.disabled = true; $("#login-error").textContent = "";
  const { error } = await supabase.auth.signInWithPassword({ email: String(data.get("email")), password: String(data.get("password")) });
  if (error) $("#login-error").textContent = "No pudimos iniciar sesión. Revisa tus datos.";
  button.disabled = false;
});
$("#logout").addEventListener("click", () => supabase?.auth.signOut());
$("#refresh").addEventListener("click", () => loadDashboard(true));

async function loadDashboard(notify = false) {
  const [contacts, conversations] = await Promise.all([
    supabase.from("contacts").select("id,full_name,phone_e164,email,company,source,lifecycle_stage,last_seen_at").order("last_seen_at", { ascending: false }).limit(500),
    supabase.from("conversations").select("id,contact_id,status,channel,unread_count,last_message_at,contacts(full_name,phone_e164,company)").order("last_message_at", { ascending: false }).limit(100),
  ]);
  if (contacts.error || conversations.error) { toast("No se pudo cargar el CRM. Revisa los permisos."); return; }
  contactsCache = contacts.data || [];
  renderContacts(contactsCache); renderConversations(conversations.data || []);
  $("#metric-clients").textContent = contactsCache.length;
  $("#metric-qualified").textContent = contactsCache.filter((item) => ["qualified", "proposal"].includes(item.lifecycle_stage)).length;
  $("#metric-waiting").textContent = (conversations.data || []).filter((item) => item.status === "waiting").length;
  if (notify) toast("Información actualizada");
}

function renderConversations(items) {
  const list = $("#conversation-list"); list.replaceChildren(); $("#conversation-count").textContent = items.length;
  if (!items.length) { list.append(el("p", "empty-list", "Todavía no hay conversaciones.")); return; }
  items.forEach((item) => {
    const contact = Array.isArray(item.contacts) ? item.contacts[0] : item.contacts;
    const button = el("button", `conversation ${item.status === "waiting" ? "waiting" : ""}`); button.type = "button";
    const avatar = el("span", "avatar", (contact?.full_name || "C").slice(0, 1).toUpperCase());
    const copy = el("span", "conversation-copy"); copy.append(el("b", "", contact?.full_name || "Cliente"), el("small", "", item.channel === "whatsapp" ? "WhatsApp" : "Formulario web"));
    const time = el("time", "", formatDate(item.last_message_at));
    button.append(avatar, copy, time); button.addEventListener("click", () => openConversation(item, contact)); list.append(button);
  });
}

async function openConversation(conversation, contact) {
  activeConversation = conversation; $("#chat-empty").hidden = true; $("#chat").hidden = false;
  $("#chat-name").textContent = contact?.full_name || "Cliente"; $("#chat-phone").textContent = contact?.phone_e164 || "Sin teléfono";
  $("#chat-status").textContent = conversation.status === "waiting" ? "Espera asesor" : conversation.status;
  const { data, error } = await supabase.from("messages").select("id,direction,body,status,sent_at,message_type").eq("conversation_id", conversation.id).order("sent_at");
  if (error) { toast("No se pudo abrir el historial"); return; }
  const list = $("#message-list"); list.replaceChildren();
  (data || []).forEach((message) => { const bubble = el("article", `message ${message.direction}`); bubble.append(el("p", "", message.body || `[${message.message_type}]`), el("time", "", formatDate(message.sent_at))); list.append(bubble); });
  list.scrollTop = list.scrollHeight;
  await supabase.from("conversations").update({ unread_count: 0 }).eq("id", conversation.id);
}

$("#reply-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!activeConversation) return; const textarea = $("#reply"), button = event.currentTarget.querySelector("button"); const body = textarea.value.trim(); if (!body) return;
  button.disabled = true; $("#reply-error").textContent = "";
  const { error } = await supabase.functions.invoke("send-whatsapp", { body: { conversationId: activeConversation.id, body } });
  if (error) $("#reply-error").textContent = "No se pudo enviar. Verifica la conexión de WhatsApp."; else { textarea.value = ""; toast("Mensaje enviado por WhatsApp"); await openConversation(activeConversation, { full_name: $("#chat-name").textContent, phone_e164: $("#chat-phone").textContent }); }
  button.disabled = false;
});

function renderContacts(items) {
  const table = $("#client-table"); table.replaceChildren();
  items.forEach((contact) => {
    const row = document.createElement("tr"); const identity = document.createElement("td"); identity.append(el("b", "", contact.full_name), el("small", "", contact.company || "Sin empresa"));
    const detail = document.createElement("td"); detail.append(el("span", "", contact.phone_e164 || "—"), el("small", "", contact.email || "—"));
    const source = el("td", "", contact.source === "whatsapp" ? "WhatsApp" : "Web");
    const stageCell = document.createElement("td"), select = document.createElement("select");
    [["lead","Lead"],["qualified","Calificado"],["proposal","Propuesta"],["customer","Cliente"],["inactive","Inactivo"]].forEach(([value,label]) => { const option = new Option(label, value, false, contact.lifecycle_stage === value); select.add(option); });
    select.setAttribute("aria-label", `Etapa de ${contact.full_name}`); select.addEventListener("change", async () => { select.disabled = true; const { error } = await supabase.from("contacts").update({ lifecycle_stage: select.value, updated_at: new Date().toISOString() }).eq("id", contact.id); toast(error ? "No se pudo actualizar" : "Etapa actualizada"); select.disabled = false; });
    stageCell.append(select); const date = el("td", "", formatDate(contact.last_seen_at)); row.append(identity, detail, source, stageCell, date); table.append(row);
  });
}
$("#client-search").addEventListener("input", (event) => { const query = event.target.value.toLowerCase().trim(); renderContacts(contactsCache.filter((item) => [item.full_name,item.company,item.email,item.phone_e164].some((value) => String(value || "").toLowerCase().includes(query)))); });

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("active", item === button)); const clients = button.dataset.view === "clients";
  $("#inbox-view").hidden = clients; $("#clients-view").hidden = !clients; $("#page-title").textContent = clients ? "Gestión de clientes" : "Bandeja de atención";
}));
boot();