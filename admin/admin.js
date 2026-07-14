import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const $ = (selector) => document.querySelector(selector);
const setup = $("#setup"), login = $("#login"), workspace = $("#workspace");
let supabase, activeConversation = null, contactsCache = [];
let inviteFlow = /type=(invite|recovery)/.test(`${window.location.hash}${window.location.search}`);
let mfaFactorId = null;

function show(element) { [setup, login, workspace].forEach((item) => { item.hidden = item !== element; }); }
function toast(message) { const node = $("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 3200); }
function formatDate(value) { if (!value) return "—"; return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }

async function boot() {
  if (!supabaseUrl || !supabaseKey) { show(setup); return; }
  supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const { data } = await supabase.auth.getSession();
  await setSession(data.session);
  supabase.auth.onAuthStateChange((event, session) => { if (["PASSWORD_RECOVERY", "SIGNED_IN"].includes(event) && /type=(invite|recovery)/.test(window.location.hash)) inviteFlow = true; setTimeout(() => setSession(session), 0); });
}

function showAuthForm(activeForm) {
  show(login);
  ["#login-form", "#activation-form", "#mfa-form"].forEach((selector) => { $(selector).hidden = selector !== activeForm; });
  $("#logout").hidden = true;
}

async function requireMfa() {
  const { data: level, error: levelError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (levelError) { toast("No se pudo comprobar la seguridad de la sesión."); await supabase.auth.signOut(); return true; }
  if (level.currentLevel === "aal2") return false;
  showAuthForm("#mfa-form");
  if (mfaFactorId) return true;
  const { data: factorData, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) { $("#mfa-error").textContent = "No se pudieron consultar los factores de seguridad."; return true; }
  const verified = factorData.totp.find((factor) => factor.status === "verified");
  if (verified) {
    mfaFactorId = verified.id;
    $("#mfa-title").textContent = "Confirma tu identidad";
    $("#mfa-copy").textContent = "Ingresa el código actual de tu aplicación de autenticación.";
    $("#mfa-enrollment").hidden = true;
    return true;
  }
  const unverified = factorData.totp.find((factor) => factor.status === "unverified");
  if (unverified) await supabase.auth.mfa.unenroll({ factorId: unverified.id });
  const { data: enrollment, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "CRK CRM" });
  if (enrollError) { $("#mfa-error").textContent = "No se pudo iniciar la verificación en dos pasos."; return true; }
  mfaFactorId = enrollment.id;
  $("#mfa-title").textContent = "Protege tu cuenta";
  $("#mfa-copy").textContent = "Escanea el QR con una aplicación de autenticación y escribe el código generado.";
  $("#mfa-qr").src = enrollment.totp.qr_code;
  $("#mfa-enrollment").hidden = false;
  return true;
}

async function setSession(session) {
  if (!session) { mfaFactorId = null; showAuthForm("#login-form"); return; }
  if (inviteFlow) { showAuthForm("#activation-form"); return; }
  if (await requireMfa()) return;
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
$("#activation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget), password = String(data.get("password") || ""), confirmation = String(data.get("confirmation") || "");
  const button = event.currentTarget.querySelector("button"), errorNode = $("#activation-error"); errorNode.textContent = "";
  if (password.length < 12 || password !== confirmation) { errorNode.textContent = "Las contraseñas deben coincidir y tener al menos 12 caracteres."; return; }
  button.disabled = true;
  const { error } = await supabase.auth.updateUser({ password });
  if (error) { errorNode.textContent = "No se pudo guardar la contraseña. Solicita una nueva invitación."; button.disabled = false; return; }
  inviteFlow = false; history.replaceState({}, document.title, `${location.pathname}`); toast("Cuenta activada correctamente");
  const { data: sessionData } = await supabase.auth.getSession(); await setSession(sessionData.session); button.disabled = false;
});
$("#mfa-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = String(new FormData(event.currentTarget).get("code") || "").trim();
  const button = event.currentTarget.querySelector("button"), errorNode = $("#mfa-error"); errorNode.textContent = "";
  if (!mfaFactorId || !/^\d{6}$/.test(code)) { errorNode.textContent = "Ingresa un código válido de seis dígitos."; return; }
  button.disabled = true;
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: mfaFactorId, code });
  if (error) { errorNode.textContent = "El código no es válido o ya venció."; button.disabled = false; return; }
  event.currentTarget.reset(); toast("Identidad verificada");
  const { data: sessionData } = await supabase.auth.getSession(); await setSession(sessionData.session); button.disabled = false;
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

function renderClientDetails(contact, activities, channel) {
  const stageLabels = { lead: "Lead", qualified: "Calificado", proposal: "Propuesta", customer: "Cliente", inactive: "Inactivo" };
  const sourceLabels = { web: "Formulario web", whatsapp: "WhatsApp" };
  const leadRequests = activities.filter((item) => item.activity_type === "lead_form");
  const latest = leadRequests[0];
  const metadata = latest?.metadata && typeof latest.metadata === "object" ? latest.metadata : {};
  $("#detail-company").textContent = contact.company || metadata.company || "No informado";
  const email = $("#detail-email");
  email.textContent = contact.email || metadata.email || "No informado";
  if (contact.email || metadata.email) email.href = `mailto:${contact.email || metadata.email}`; else email.removeAttribute("href");
  const phone = contact.phone_e164 || metadata.phone || "";
  const whatsapp = $("#detail-whatsapp");
  whatsapp.textContent = phone || "No informado";
  if (phone) { whatsapp.href = `https://wa.me/${phone.replace(/\D/g, "")}`; whatsapp.target = "_blank"; whatsapp.rel = "noopener noreferrer"; } else whatsapp.removeAttribute("href");
  $("#detail-source").textContent = sourceLabels[contact.source] || contact.source || (channel === "web" ? "Formulario web" : "WhatsApp");
  $("#detail-stage").textContent = stageLabels[contact.lifecycle_stage] || contact.lifecycle_stage || "Lead";
  $("#detail-consent").textContent = contact.consent_status === "granted" ? `Autorizado · ${formatDate(contact.consent_at)}` : "Pendiente";
  $("#detail-need").textContent = latest?.summary || (channel === "whatsapp" ? "Conversación iniciada por WhatsApp" : "Sin solicitud registrada");
  $("#detail-received").textContent = latest ? `Recibida ${formatDate(latest.created_at)}` : `Primer contacto ${formatDate(contact.first_seen_at)}`;
  $("#request-count").textContent = String(leadRequests.length);
  const history = $("#request-history"), list = $("#request-list");
  history.hidden = leadRequests.length < 2; list.replaceChildren();
  leadRequests.slice(0, 10).forEach((request) => { const item = el("article"); item.append(el("strong", "", request.summary), el("time", "", formatDate(request.created_at))); list.append(item); });
}

async function openConversation(conversation, contactPreview) {
  activeConversation = conversation; $("#chat-empty").hidden = true; $("#chat").hidden = false;
  $("#chat-status").textContent = ({ waiting: "Esperando asesor", open: "Atención humana", bot: "Bot activo", closed: "Cerrada" }[conversation.status] || conversation.status);
  const [messagesResult, contactResult, activitiesResult] = await Promise.all([
    supabase.from("messages").select("id,direction,body,status,sent_at,message_type").eq("conversation_id", conversation.id).order("sent_at", { ascending: false }).limit(200),
    supabase.from("contacts").select("id,full_name,phone_e164,email,company,source,lifecycle_stage,consent_status,consent_at,first_seen_at,last_seen_at").eq("id", conversation.contact_id).single(),
    supabase.from("activities").select("id,activity_type,summary,metadata,created_at").eq("contact_id", conversation.contact_id).order("created_at", { ascending: false }).limit(20),
  ]);
  if (messagesResult.error || contactResult.error || activitiesResult.error) { toast("No se pudo abrir el detalle del cliente"); return; }
  const contact = contactResult.data || contactPreview || {};
  const activities = activitiesResult.data || [];
  $("#chat-name").textContent = contact.full_name || "Cliente"; $("#chat-phone").textContent = contact.phone_e164 || "Sin teléfono";
  renderClientDetails(contact, activities, conversation.channel);
  const canReply = conversation.channel === "whatsapp";
  $("#reply-form").hidden = !canReply; $("#channel-note").hidden = canReply; $("#reply-error").textContent = "";
  const list = $("#message-list"); list.replaceChildren();
  [...(messagesResult.data || [])].reverse().forEach((message) => { const bubble = el("article", `message ${message.direction}`); bubble.append(el("p", "", message.body || `[${message.message_type}]`), el("time", "", formatDate(message.sent_at))); list.append(bubble); });
  if (!messagesResult.data?.length) {
    const latestRequest = activities.find((item) => item.activity_type === "lead_form");
    if (latestRequest) { const bubble = el("article", "message inbound"); bubble.append(el("p", "", `Solicitud: ${latestRequest.summary}`), el("time", "", formatDate(latestRequest.created_at))); list.append(bubble); }
    else list.append(el("p", "empty-list", "Aún no hay mensajes en esta conversación."));
  }
  list.scrollTop = list.scrollHeight;
  const { error: readError } = await supabase.from("conversations").update({ unread_count: 0 }).eq("id", conversation.id);
  if (readError) toast("No se pudo marcar la conversación como leída");
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