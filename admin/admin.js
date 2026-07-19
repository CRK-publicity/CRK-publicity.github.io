import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const $ = (selector) => document.querySelector(selector);
const setup = $("#setup"), login = $("#login"), workspace = $("#workspace");
let supabase, activeConversation = null, contactsCache = [];
let activeView = "inbox";
let currentUserIsOwner = false;
let siteAdminLoading = null;
let siteAdminState = { content: { hero: {}, contact: {} }, services: [], media: [], paymentMethods: [], publication: null };
let inviteFlow = /type=(invite|recovery)/.test(`${window.location.hash}${window.location.search}`);
let mfaFactorId = null;
let dashboardTimer = null;

function show(element) { [setup, login, workspace].forEach((item) => { item.hidden = item !== element; }); }
function toast(message) { const node = $("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 3200); }
function formatDate(value) { if (!value) return "—"; return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function stopDashboardRefresh() { if (dashboardTimer) window.clearInterval(dashboardTimer); dashboardTimer = null; }
function startDashboardRefresh() { stopDashboardRefresh(); dashboardTimer = window.setInterval(() => { if (!document.hidden && !workspace.hidden) loadDashboard(); }, 30000); }

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
  if (!session) { mfaFactorId = null; currentUserIsOwner = false; resetSiteAdminWorkspace(); document.querySelectorAll("[data-owner-only]").forEach((node) => { node.hidden = true; }); stopDashboardRefresh(); showAuthForm("#login-form"); return; }
  if (inviteFlow) { showAuthForm("#activation-form"); return; }
  if (await requireMfa()) return;
  await loadOwnerAccess(session.user.id);
  show(workspace); $("#logout").hidden = false; $("#session-name").textContent = session.user.email || "";
  await loadDashboard(); startDashboardRefresh();
}

async function loadOwnerAccess(userId) {
  currentUserIsOwner = false;
  document.querySelectorAll("[data-owner-only]").forEach((node) => { node.hidden = true; });
  if (!userId || !supabase) return;
  const { data, error } = await supabase.from("profiles").select("role").eq("user_id", userId).maybeSingle();
  if (error) { return; }
  currentUserIsOwner = data?.role === "owner";
  document.querySelectorAll("[data-owner-only]").forEach((node) => { node.hidden = !currentUserIsOwner; });
}

function resetSiteAdminWorkspace() {
  activeView = "inbox";
  siteAdminLoading = null;
  siteAdminState = { content: { hero: {}, contact: {} }, services: [], media: [], paymentMethods: [], publication: null };
  $("#inbox-view").hidden = false;
  $("#clients-view").hidden = true;
  $("#site-view").hidden = true;
  $(".metrics").hidden = false;
  $("#page-title").textContent = "Bandeja de atención";
  $("#service-list").replaceChildren();
  $("#media-list").replaceChildren();
  $("#payment-method-list").replaceChildren();
  $("#site-admin-status").textContent = "";
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

async function loadDashboard(notify = false) {
  const [contacts, conversations, analytics] = await Promise.all([
    supabase.from("contacts").select("id,full_name,phone_e164,email,company,source,lifecycle_stage,last_seen_at").order("last_seen_at", { ascending: false }).limit(500),
    supabase.from("conversations").select("id,contact_id,status,channel,unread_count,last_message_at,contacts(full_name,phone_e164,company)").order("last_message_at", { ascending: false }).limit(100),
    supabase.from("analytics_daily").select("visits,clicks").order("metric_date", { ascending: false }).limit(3660),
  ]);
  if (contacts.error || conversations.error || analytics.error) { toast("No se pudo cargar el CRM. Revisa los permisos."); return; }
  contactsCache = contacts.data || [];
  renderContacts(contactsCache); renderConversations(conversations.data || []);
  $("#metric-clients").textContent = contactsCache.length;
  $("#metric-qualified").textContent = contactsCache.filter((item) => ["qualified", "proposal"].includes(item.lifecycle_stage)).length;
  $("#metric-waiting").textContent = (conversations.data || []).filter((item) => item.status === "waiting").length;
  const traffic = (analytics.data || []).reduce((totals, day) => ({ visits: totals.visits + Number(day.visits || 0), clicks: totals.clicks + Number(day.clicks || 0) }), { visits: 0, clicks: 0 });
  $("#metric-visits").textContent = traffic.visits.toLocaleString("es-CO");
  $("#metric-clicks").textContent = traffic.clicks.toLocaleString("es-CO");
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
  const sourceLabels = { web: "Formulario web", whatsapp: "WhatsApp", payment: "Pago web" };
  const leadRequests = activities.filter((item) => ["lead_form", "payment_created", "payment_approved", "payment_status"].includes(item.activity_type));
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
    const source = el("td", "", contact.source === "whatsapp" ? "WhatsApp" : contact.source === "payment" ? "Pago web" : "Web");
    const stageCell = document.createElement("td"), select = document.createElement("select");
    [["lead","Lead"],["qualified","Calificado"],["proposal","Propuesta"],["customer","Cliente"],["inactive","Inactivo"]].forEach(([value,label]) => { const option = new Option(label, value, false, contact.lifecycle_stage === value); select.add(option); });
    select.setAttribute("aria-label", `Etapa de ${contact.full_name}`); select.addEventListener("change", async () => { select.disabled = true; const { error } = await supabase.from("contacts").update({ lifecycle_stage: select.value, updated_at: new Date().toISOString() }).eq("id", contact.id); toast(error ? "No se pudo actualizar" : "Etapa actualizada"); select.disabled = false; });
    stageCell.append(select); const date = el("td", "", formatDate(contact.last_seen_at)); row.append(identity, detail, source, stageCell, date); table.append(row);
  });
}
$("#client-search").addEventListener("input", (event) => { const query = event.target.value.toLowerCase().trim(); renderContacts(contactsCache.filter((item) => [item.full_name,item.company,item.email,item.phone_e164].some((value) => String(value || "").toLowerCase().includes(query)))); });

function toPlainObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function toArray(value) { return Array.isArray(value) ? value : []; }
function trimText(value, maxLength = 1000) { return String(value ?? "").trim().slice(0, maxLength); }
function numericValue(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }

function setSiteStatus(message, state = "idle") {
  const node = $("#site-admin-status");
  node.textContent = message;
  node.dataset.state = state;
}

function unwrapFunctionResponse(value) {
  if (!value || typeof value !== "object") return value;
  if (value.ok === false) throw new Error("request-rejected");
  return value.data && typeof value.data === "object" ? value.data : value;
}

async function requestSiteAdmin(action, data = {}) {
  if (!currentUserIsOwner) throw new Error("owner-required");
  const { data: response, error } = await supabase.functions.invoke("site-admin", { body: { action, data } });
  if (error) throw new Error("site-admin-unavailable");
  return unwrapFunctionResponse(response);
}

function contentRecord(rawContent, key) {
  const source = Array.isArray(rawContent)
    ? rawContent.find((item) => item?.contentKey === key || item?.content_key === key)
    : toPlainObject(rawContent)[key];
  const record = toPlainObject(source);
  const payload = toPlainObject(record.payload);
  return { payload: Object.keys(payload).length ? payload : record, version: Number.isInteger(record.version) ? record.version : 0 };
}

function normalizeSiteAdminState(response) {
  const data = unwrapFunctionResponse(response) || {};
  const content = data.content || data.siteContent || data.site_content || {};
  return {
    content: { hero: contentRecord(content, "hero"), contact: contentRecord(content, "contact") },
    services: toArray(data.services || data.siteServices || data.site_services),
    media: toArray(data.media || data.gallery || data.siteMedia || data.site_media),
    paymentMethods: toArray(data.paymentMethods || data.payment_methods || data.payments),
    publication: toPlainObject(data.publication || data.activePublication || data.active_publication),
  };
}

function setFormField(form, name, value) {
  const field = form.elements.namedItem(name);
  if (!field) return;
  if (field instanceof RadioNodeList) return;
  if (field.type === "checkbox") field.checked = Boolean(value);
  else field.value = value == null ? "" : String(value);
}

function populateContentForm() {
  const form = $("#site-content-form");
  const hero = siteAdminState.content.hero.payload;
  const contact = siteAdminState.content.contact.payload;
  const values = {
    heroEyebrow: hero.eyebrow || hero.heroEyebrow,
    heroTitle: hero.title || hero.heroTitle,
    heroAccent: hero.highlight || hero.heroAccent,
    heroDescription: hero.description || hero.heroDescription,
    heroPrimaryLabel: hero.primaryLabel || hero.heroPrimaryLabel,
    heroPrimaryUrl: hero.primaryUrl || hero.heroPrimaryUrl,
    heroSecondaryLabel: hero.secondaryLabel || hero.heroSecondaryLabel,
    heroSecondaryUrl: hero.secondaryUrl || hero.heroSecondaryUrl,
    contactEyebrow: contact.eyebrow || contact.contactEyebrow,
    contactTitle: contact.title || contact.contactTitle,
    contactDescription: contact.description || contact.contactDescription,
  };
  Object.entries(values).forEach(([name, value]) => setFormField(form, name, value));
}

function serviceFeatures(service) {
  return toArray(service.features).map((item) => trimText(item, 160)).filter(Boolean);
}

function formatCop(value) {
  const amount = numericValue(value, 0);
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(amount);
}

function appendEditorMeta(parent, labels) {
  const meta = el("div", "editor-meta");
  labels.forEach(({ label, live }) => { const tag = el("span", live === true ? "is-live" : live === false ? "is-draft" : "", label); meta.append(tag); });
  parent.append(meta);
}

function makeItemButton(label, className, handler) {
  const button = el("button", `small-button ${className || ""}`, label);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function renderServices() {
  const list = $("#service-list");
  list.replaceChildren();
  const services = [...siteAdminState.services].sort((a, b) => numericValue(a.sortOrder ?? a.sort_order) - numericValue(b.sortOrder ?? b.sort_order));
  $("#service-count").textContent = String(services.length);
  if (!services.length) { list.append(el("p", "editor-empty", "Aún no hay servicios configurados. Crea el primero con el formulario.")); return; }
  services.forEach((service) => {
    const item = el("article", "editor-item");
    const copy = el("div", "editor-item-copy");
    const title = trimText(service.title, 90) || "Servicio sin nombre";
    copy.append(el("b", "", title), el("p", "", trimText(service.description || service.summary, 360) || "Sin descripción"));
    appendEditorMeta(copy, [
      { label: formatCop(service.priceCop ?? service.price_cop) },
      { label: service.ctaType || service.cta_type || "quote" },
      { label: service.published ? "Visible" : "Borrador", live: Boolean(service.published) },
    ]);
    const actions = el("div", "item-actions");
    actions.append(
      makeItemButton("Editar", "", () => { fillServiceForm(service); setSiteTab("services"); }),
      makeItemButton("Archivar", "danger", () => deleteSiteService(service)),
    );
    item.append(copy, actions); list.append(item);
  });
}

function updateServiceCtaFields() {
  const form = $("#service-form");
  const ctaType = String(new FormData(form).get("ctaType") || "quote");
  $("[data-service-checkout]").hidden = ctaType !== "checkout";
  $("[data-service-link]").hidden = ctaType !== "link";
  form.elements.checkoutProductCode.required = ctaType === "checkout";
  form.elements.ctaUrl.required = ctaType === "link";
}

function resetServiceForm() {
  const form = $("#service-form");
  form.reset();
  delete form.dataset.version;
  setFormField(form, "sortOrder", 0);
  setFormField(form, "ctaType", "quote");
  setFormField(form, "published", true);
  updateServiceCtaFields();
}

function fillServiceForm(service) {
  const form = $("#service-form");
  setFormField(form, "id", service.id);
  setFormField(form, "title", service.title);
  setFormField(form, "slug", service.slug);
  setFormField(form, "summary", service.description || service.summary);
  setFormField(form, "features", serviceFeatures(service).join("\n"));
  setFormField(form, "priceCop", service.priceCop ?? service.price_cop);
  setFormField(form, "sortOrder", service.sortOrder ?? service.sort_order ?? 0);
  setFormField(form, "ctaType", service.ctaType || service.cta_type || "quote");
  setFormField(form, "checkoutProductCode", service.checkoutProductCode || service.checkout_product_code);
  setFormField(form, "ctaUrl", service.ctaUrl || service.cta_url);
  setFormField(form, "published", Boolean(service.published));
  form.dataset.version = Number.isInteger(service.version) ? String(service.version) : "";
  updateServiceCtaFields();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function safePublicAssetUrl(value) {
  if (!value) return "";
  try {
    const target = new URL(String(value), window.location.origin);
    const supabaseOrigin = new URL(supabaseUrl).origin;
    if (target.protocol !== "https:" || ![window.location.origin, supabaseOrigin].includes(target.origin)) return "";
    return target.href;
  } catch { return ""; }
}

function renderMedia() {
  const list = $("#media-list");
  list.replaceChildren();
  const media = [...siteAdminState.media].sort((a, b) => numericValue(a.sortOrder ?? a.sort_order) - numericValue(b.sortOrder ?? b.sort_order));
  $("#media-count").textContent = String(media.length);
  if (!media.length) { list.append(el("p", "editor-empty", "Aún no hay fotos publicadas desde el CRM.")); return; }
  media.forEach((item) => {
    const card = el("article", "media-card");
    const url = safePublicAssetUrl(item.previewUrl || item.preview_url || item.publicUrl || item.public_url || item.url);
    if (url) { const image = document.createElement("img"); image.src = url; image.alt = trimText(item.altText || item.alt_text, 180) || "Foto del portafolio"; image.loading = "lazy"; card.append(image); }
    else card.append(el("div", "media-missing", "Vista previa no disponible"));
    card.append(el("strong", "", trimText(item.title, 90) || "Foto sin título"), el("small", "", item.section === "products" ? "Productos" : "Trabajos"));
    const actions = el("div", "item-actions");
    actions.append(el("span", item.published ? "is-live" : "is-draft", item.published ? "Visible" : "Borrador"), makeItemButton("Archivar", "danger", () => deleteSiteMedia(item)));
    card.append(actions); list.append(card);
  });
}

function resetPaymentMethodForm() {
  const form = $("#payment-method-form");
  form.reset();
  setFormField(form, "label", "Mercado Pago");
  setFormField(form, "code", "mercado_pago");
  setFormField(form, "provider", "mercado_pago");
  setFormField(form, "mode", "live");
  setFormField(form, "sortOrder", 0);
  setFormField(form, "enabled", false);
  delete form.dataset.version;
  updatePaymentMethodFields();
}

function updatePaymentMethodFields() {
  const form = $("#payment-method-form");
  setFormField(form, "code", "mercado_pago");
  setFormField(form, "provider", "mercado_pago");
}

function fillPaymentMethodForm(method) {
  const form = $("#payment-method-form");
  setFormField(form, "id", method.id);
  setFormField(form, "label", method.label);
  setFormField(form, "code", method.code);
  setFormField(form, "provider", method.provider);
  setFormField(form, "mode", method.mode || "live");
  setFormField(form, "sortOrder", method.sortOrder ?? method.sort_order ?? 0);
  setFormField(form, "enabled", Boolean(method.enabled));
  form.dataset.version = Number.isInteger(method.version) ? String(method.version) : "";
  updatePaymentMethodFields();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderPaymentMethods() {
  const list = $("#payment-method-list");
  list.replaceChildren();
  const methods = [...siteAdminState.paymentMethods].sort((a, b) => numericValue(a.sortOrder ?? a.sort_order) - numericValue(b.sortOrder ?? b.sort_order));
  $("#payment-method-count").textContent = String(methods.length);
  if (!methods.length) { list.append(el("p", "editor-empty", "No hay medios de pago configurados. Activa solo los que tengas listos para recibir pagos.")); return; }
  methods.forEach((method) => {
    const item = el("article", "editor-item");
    const copy = el("div", "editor-item-copy");
    copy.append(el("b", "", trimText(method.label, 70) || "Medio sin nombre"), el("p", "", method.enabled ? "Disponible para clientes." : "Guardado como borrador; aún no es visible para clientes."));
    appendEditorMeta(copy, [
      { label: trimText(method.provider, 40) || "Proveedor" },
      { label: method.mode === "test" ? "Prueba" : "Producción" },
      { label: method.enabled ? "Activo" : "Inactivo", live: Boolean(method.enabled) },
    ]);
    const actions = el("div", "item-actions");
    actions.append(makeItemButton("Editar", "", () => { fillPaymentMethodForm(method); setSiteTab("payments"); }), makeItemButton("Eliminar", "danger", () => deletePaymentMethod(method)));
    item.append(copy, actions); list.append(item);
  });
}

function renderPublication() {
  const publication = siteAdminState.publication;
  const publishedAt = publication.publishedAt || publication.published_at || publication.createdAt || publication.created_at;
  const isPublished = Boolean(publication.id || publishedAt);
  const services = siteAdminState.services.filter((item) => item.published).length;
  const media = siteAdminState.media.filter((item) => item.published).length;
  $("#publication-state").textContent = isPublished ? "Publicada" : "Sin publicar";
  $("#publication-title").textContent = isPublished ? `Versión publicada ${formatDate(publishedAt)}` : "Aún no hay una versión publicada";
  $("#publication-description").textContent = isPublished ? "La página pública muestra esta versión hasta que publiques una nueva." : "Guarda tus cambios y publica cuando estés listo. Cada publicación queda registrada con su fecha y usuario.";
  $("#publication-services").textContent = String(services);
  $("#publication-media").textContent = String(media);
  $("#publication-date").textContent = isPublished ? formatDate(publishedAt) : "—";
}

function renderSiteAdmin() {
  populateContentForm();
  renderServices();
  renderMedia();
  renderPaymentMethods();
  renderPublication();
}

async function loadSiteAdmin(notify = false) {
  if (!currentUserIsOwner) { setSiteStatus("Este módulo está disponible solo para la cuenta propietaria.", "error"); return; }
  if (siteAdminLoading) return siteAdminLoading;
  setSiteStatus("Cargando la configuración protegida…");
  siteAdminLoading = (async () => {
    try {
      siteAdminState = normalizeSiteAdminState(await requestSiteAdmin("get_dashboard"));
      renderSiteAdmin();
      if (siteAdminState.paymentMethods.length === 1 && !trimText($("#payment-method-form").elements.id.value)) {
        fillPaymentMethodForm(siteAdminState.paymentMethods[0]);
      }
      setSiteStatus("Configuración cargada. Los cambios no serán públicos hasta que los publiques.", "success");
      if (notify) toast("Configuración del sitio actualizada");
    } catch {
      setSiteStatus("No fue posible cargar esta configuración. Verifica que tu cuenta sea propietaria y vuelve a intentar.", "error");
    } finally { siteAdminLoading = null; }
  })();
  return siteAdminLoading;
}

function setSiteTab(name) {
  const available = new Set(["page", "services", "gallery", "payments", "publication"]);
  const tab = available.has(name) ? name : "page";
  document.querySelectorAll("[data-site-tab]").forEach((button) => {
    const active = button.dataset.siteTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-site-panel]").forEach((panel) => { panel.hidden = panel.dataset.sitePanel !== tab; });
}

function safeLink(value, allowInternal = true) {
  const candidate = trimText(value, 500);
  if (!candidate) return "";
  if (allowInternal && /^#[A-Za-z][\w-]*$/.test(candidate)) return candidate;
  let parsed;
  try { parsed = new URL(candidate); } catch { throw new Error("invalid-url"); }
  if (parsed.protocol !== "https:") throw new Error("invalid-url");
  return parsed.href;
}

async function withBusy(button, busyLabel, operation) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try { await operation(); } finally { button.disabled = false; button.textContent = label; }
}

async function deleteSiteService(service) {
  if (!service?.id || !window.confirm(`¿Archivar “${trimText(service.title, 90) || "este servicio"}”? Seguirá visible en la versión pública hasta que publiques los cambios.`)) return;
  try {
    await requestSiteAdmin("delete_service", { id: service.id, version: numericValue(service.version, 0) });
    toast("Servicio archivado");
    resetServiceForm();
    await loadSiteAdmin();
  } catch { toast("No fue posible archivar el servicio"); }
}

async function deleteSiteMedia(media) {
  if (!media?.id || !window.confirm(`¿Archivar “${trimText(media.title, 90) || "esta foto"}”? Seguirá visible en la versión pública hasta que publiques los cambios.`)) return;
  try { await requestSiteAdmin("delete_media", { id: media.id, version: numericValue(media.version, 0) }); toast("Foto archivada"); await loadSiteAdmin(); } catch { toast("No fue posible archivar la foto"); }
}

async function deletePaymentMethod(method) {
  if (!method?.id || !window.confirm(`¿Eliminar “${trimText(method.label, 70) || "este medio de pago"}”?`)) return;
  try { await requestSiteAdmin("delete_payment_method", { id: method.id, version: numericValue(method.version, 0) }); toast("Medio de pago eliminado"); resetPaymentMethodForm(); await loadSiteAdmin(); } catch { toast("No fue posible eliminar el medio de pago"); }
}

$("#site-content-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const hero = {
    eyebrow: trimText(data.get("heroEyebrow"), 80), title: trimText(data.get("heroTitle"), 160), highlight: trimText(data.get("heroAccent"), 90), description: trimText(data.get("heroDescription"), 320),
    primaryLabel: trimText(data.get("heroPrimaryLabel"), 32), secondaryLabel: trimText(data.get("heroSecondaryLabel"), 32),
  };
  const contact = { eyebrow: trimText(data.get("contactEyebrow"), 80), title: trimText(data.get("contactTitle"), 110), description: trimText(data.get("contactDescription"), 420) };
  try {
    hero.primaryUrl = safeLink(data.get("heroPrimaryUrl"));
    hero.secondaryUrl = safeLink(data.get("heroSecondaryUrl"));
  } catch { setSiteStatus("Revisa los enlaces: solo se admiten HTTPS o anclas internas de la página.", "error"); return; }
  const button = form.querySelector("button[type='submit']");
  await withBusy(button, "Guardando…", async () => {
    try {
      await requestSiteAdmin("save_content", { contentKey: "hero", payload: hero, version: siteAdminState.content.hero.version });
      await requestSiteAdmin("save_content", { contentKey: "contact", payload: contact, version: siteAdminState.content.contact.version });
      toast("Contenido guardado. Publícalo cuando estés listo.");
      await loadSiteAdmin();
    } catch { setSiteStatus("No fue posible guardar el contenido. Es posible que otra sesión lo haya modificado.", "error"); }
  });
});

$("#service-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const ctaType = String(data.get("ctaType") || "quote");
  const rawPrice = trimText(data.get("priceCop"), 16);
  const priceCop = rawPrice ? numericValue(rawPrice, -1) : null;
  if (priceCop !== null && (!Number.isInteger(priceCop) || priceCop < 1000 || priceCop > 999999999)) { setSiteStatus("El precio debe ser un valor entero entre $1.000 y $999.999.999 COP.", "error"); return; }
  if (ctaType === "checkout" && priceCop === null) { setSiteStatus("Un servicio con pago directo necesita un precio.", "error"); return; }
  const payload = {
    id: trimText(data.get("id"), 80) || undefined,
    version: form.dataset.version ? numericValue(form.dataset.version, null) : undefined,
    slug: trimText(data.get("slug"), 60), title: trimText(data.get("title"), 90), description: trimText(data.get("summary"), 360),
    features: String(data.get("features") || "").split(/\r?\n/).map((item) => trimText(item, 160)).filter(Boolean).slice(0, 12),
    priceCop, ctaType, sortOrder: Math.max(0, Math.min(9999, numericValue(data.get("sortOrder"), 0))), published: data.get("published") === "on",
  };
  try {
    if (ctaType === "checkout") payload.checkoutProductCode = trimText(data.get("checkoutProductCode"), 80);
    if (ctaType === "link") payload.ctaUrl = safeLink(data.get("ctaUrl"), false);
  } catch { setSiteStatus("El enlace del servicio debe usar HTTPS.", "error"); return; }
  const button = form.querySelector("button[type='submit']");
  await withBusy(button, "Guardando…", async () => {
    try { await requestSiteAdmin("save_service", payload); toast("Servicio guardado. Publícalo cuando estés listo."); resetServiceForm(); await loadSiteAdmin(); }
    catch { setSiteStatus("No fue posible guardar el servicio. Revisa los datos e inténtalo de nuevo.", "error"); }
  });
});

$("#media-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const file = form.elements.file.files?.[0];
  const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!file || !acceptedTypes.has(file.type) || file.size > 5 * 1024 * 1024) { setSiteStatus("Elige una imagen JPG, PNG o WebP de máximo 5 MB.", "error"); return; }
  const data = new FormData();
  data.append("file", file, file.name);
  data.append("title", trimText(form.elements.title.value, 90));
  data.append("altText", trimText(form.elements.altText.value, 180));
  data.append("section", String(form.elements.section.value));
  data.append("sortOrder", String(Math.max(0, Math.min(9999, numericValue(form.elements.sortOrder.value, 0)))));
  data.append("published", String(form.elements.published.checked));
  const button = form.querySelector("button[type='submit']");
  await withBusy(button, "Subiendo…", async () => {
    const { data: response, error } = await supabase.functions.invoke("site-media-upload", { body: data });
    try {
      if (error) throw new Error("upload-failed");
      unwrapFunctionResponse(response);
      form.reset(); setFormField(form, "sortOrder", 0); setFormField(form, "published", true);
      toast("Foto cargada. Publícala desde la pestaña Publicación.");
      await loadSiteAdmin();
    } catch { setSiteStatus("No fue posible subir la foto. Confirma el formato, el tamaño y tus permisos.", "error"); }
  });
});

$("#payment-method-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  let checkoutUrl = "";
  try { checkoutUrl = safeLink(data.get("checkoutUrl"), false); } catch { setSiteStatus("El enlace de pago debe usar HTTPS.", "error"); return; }
  const payload = {
    id: trimText(data.get("id"), 80) || undefined, version: form.dataset.version ? numericValue(form.dataset.version, null) : undefined,
    code: trimText(data.get("code"), 50), label: trimText(data.get("label"), 70), provider: String(data.get("provider")), mode: String(data.get("mode")),
    checkoutUrl: checkoutUrl || undefined, instructions: trimText(data.get("instructions"), 500) || undefined,
    sortOrder: Math.max(0, Math.min(9999, numericValue(data.get("sortOrder"), 0))), enabled: data.get("enabled") === "on",
  };
  const button = form.querySelector("button[type='submit']");
  await withBusy(button, "Guardando…", async () => {
    try { await requestSiteAdmin("save_payment_method", payload); toast("Medio de pago guardado. No se guardaron credenciales en el navegador."); resetPaymentMethodForm(); await loadSiteAdmin(); }
    catch { setSiteStatus("No fue posible guardar el medio de pago. Revisa los datos e inténtalo de nuevo.", "error"); }
  });
});

$("#service-reset").addEventListener("click", resetServiceForm);
$("#payment-method-reset").addEventListener("click", () => {
  const method = siteAdminState.paymentMethods.find((item) => item.code === "mercado_pago");
  if (method) fillPaymentMethodForm(method);
  else resetPaymentMethodForm();
});
$("#service-form").elements.ctaType.addEventListener("change", updateServiceCtaFields);
$("#payment-method-form").elements.provider.addEventListener("change", updatePaymentMethodFields);
$("#publish-site").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  await withBusy(button, "Publicando…", async () => {
    try { await requestSiteAdmin("publish_site", {}); toast("Cambios publicados en la web"); await loadSiteAdmin(); }
    catch { setSiteStatus("No fue posible publicar. Revisa los cambios e inténtalo de nuevo.", "error"); }
  });
});
document.querySelectorAll("[data-site-tab]").forEach((button) => button.addEventListener("click", () => setSiteTab(button.dataset.siteTab)));

let raffleAdminState = { raffles: [], participants: [], stats: [] };
function renderRaffleSummary() {
  const form = $("#raffle-quick-form");
  if (!form) return;
  let list = $("#raffle-summary");
  if (!list) { list = document.createElement("div"); list.id = "raffle-summary"; list.className = "raffle-summary"; form.after(list); }
  list.replaceChildren();
  if (!raffleAdminState.raffles.length) { list.append(el("p", "editor-empty", "Aún no hay sorteos. Crea el primero con el formulario anterior.")); return; }
  const stats = new Map(raffleAdminState.stats.map((item) => [item.raffleId, item]));
  raffleAdminState.raffles.forEach((raffle) => {
    const values = stats.get(raffle.id) || { available: 0, paid: 0, pending: 0 };
    const card = el("article", "raffle-summary-card");
    const copy = el("div"); copy.append(el("b", "", raffle.title), el("small", "", `${raffle.prize_name} · ${Number(raffle.price_cop || 0).toLocaleString("es-CO")} COP`), el("small", "", `Disponibles: ${values.available} · Por validar: ${values.pending} · Confirmados: ${values.paid}`));
    const status = el("span", `raffle-state raffle-state-${raffle.status}`, raffle.status === "active" ? "Activo" : raffle.status === "draft" ? "Borrador" : raffle.status);
    card.append(copy, status); list.append(card);
  });
}
async function raffleRequest(action, data = {}) { const { data: response, error } = await supabase.functions.invoke("raffle-admin", { body: { action, ...data } }); if (error || !response) throw new Error("raffle-admin-unavailable"); if (response.error) throw new Error(response.error); return response; }
function renderParticipants() { const body = $("#participants-table"); body.replaceChildren(); const raffles = new Map(raffleAdminState.raffles.map((item) => [item.id, item])); for (const participant of raffleAdminState.participants) { const row = document.createElement("tr"); const raffle = raffles.get(participant.raffle_id); const cells = [participant.full_name, raffle?.title || "—", (participant.numbers || []).map((number) => String(number).padStart(2, "0")).join(", "), participant.payment_status, formatDate(participant.created_at)]; cells.forEach((value) => { const cell = document.createElement("td"); cell.textContent = String(value || "—"); row.append(cell); }); const actions = document.createElement("td"); for (const [label, action] of [["Aprobar", "approve"], ["Rechazar", "reject"], ["Liberar", "release"]]) { const button = document.createElement("button"); button.className = "small-button"; button.type = "button"; button.textContent = label; button.disabled = action === "approve" && participant.payment_status === "approved"; button.addEventListener("click", async () => { try { await raffleRequest("participant_action", { participantId: participant.id, action }); toast("Participante actualizado"); await loadRaffleAdmin(); } catch { toast("No fue posible actualizar la participación"); } }); actions.append(button); } row.append(actions); body.append(row); } if (!raffleAdminState.participants.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 6; cell.textContent = "No hay participantes registrados."; row.append(cell); body.append(row); } }
async function loadRaffleAdmin() { try { raffleAdminState = await raffleRequest("dashboard"); renderParticipants(); renderRaffleSummary(); } catch { toast("No fue posible cargar los sorteos."); } }
async function uploadRaffleAdminFile(kind, file) { if (!(file instanceof File) || !file.size) return ""; const body = new FormData(); body.set("kind", kind); body.set("file", file); const { data, error } = await supabase.functions.invoke("raffle-admin-upload", { body }); if (error || !data?.path) throw new Error("upload_failed"); return data.path; }
$("#raffle-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return; const data = new FormData(form); try { const bannerPath = await uploadRaffleAdminFile("banner", data.get("bannerFile")); const prizeImagePath = await uploadRaffleAdminFile("prize", data.get("prizeFile")); const payload = { id: String(data.get("id") || ""), slug: trimText(data.get("slug"), 80), title: trimText(data.get("title"), 140), prizeName: trimText(data.get("prizeName"), 160), description: trimText(data.get("description"), 3000), priceCop: numericValue(data.get("priceCop"), 0), status: String(data.get("status")), maxNumbersPerParticipant: numericValue(data.get("maxNumbersPerParticipant"), 1), reservationMinutes: numericValue(data.get("reservationMinutes"), 20), bannerPath: bannerPath || String(data.get("bannerPath") || ""), prizeImagePath: prizeImagePath || String(data.get("prizeImagePath") || ""), nequiNumber: trimText(data.get("nequiNumber"), 30), paymentInstructions: trimText(data.get("paymentInstructions"), 2000), termsText: trimText(data.get("termsText"), 10000), privacyText: trimText(data.get("privacyText"), 2000) }; await raffleRequest("save_raffle", payload); toast("Sorteo guardado"); form.reset(); await loadRaffleAdmin(); } catch { toast("Revisa los datos, imágenes y permisos."); } });
$("#raffle-refresh")?.addEventListener("click", loadRaffleAdmin);

function raffleSlug(value) {
  const base = trimText(value, 80).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base.slice(0, 64) || `sorteo-${Date.now()}`;
}

function setRaffleStatus(message, state = "idle") {
  const node = $("#raffle-status");
  if (!node) return;
  node.textContent = message;
  node.dataset.state = state;
}

$("#raffle-quick-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const values = new FormData(form);
  const title = trimText(values.get("title"), 140);
  const prizeName = trimText(values.get("prizeName"), 160);
  const button = form.querySelector("button[type='submit']");
  if (!title || !prizeName || numericValue(values.get("priceCop"), -1) < 0 || !button) {
    setRaffleStatus("Indica el nombre, el premio y un valor vÃ¡lido.", "error");
    return;
  }
  await withBusy(button, "Guardandoâ€¦", async () => {
    try {
      setRaffleStatus("Subiendo imÃ¡genes y creando el sorteoâ€¦");
      const bannerPath = await uploadRaffleAdminFile("banner", values.get("bannerFile"));
      const prizeImagePath = await uploadRaffleAdminFile("prize", values.get("prizeFile"));
      const description = trimText(values.get("description"), 3000) || `Participa por ${prizeName}. Selecciona tu nÃºmero, realiza el pago y adjunta el comprobante.`;
      const payload = {
        id: trimText(values.get("id"), 80),
        title,
        prizeName,
        description,
        slug: trimText(values.get("slug"), 80) || raffleSlug(title),
        priceCop: numericValue(values.get("priceCop"), 0),
        status: String(values.get("status") || "draft"),
        maxNumbersPerParticipant: numericValue(values.get("maxNumbersPerParticipant"), 1),
        reservationMinutes: numericValue(values.get("reservationMinutes"), 20),
        bannerPath: bannerPath || trimText(values.get("bannerPath"), 500),
        prizeImagePath: prizeImagePath || trimText(values.get("prizeImagePath"), 500),
        nequiNumber: trimText(values.get("nequiNumber"), 30),
        paymentInstructions: trimText(values.get("paymentInstructions"), 2000),
        termsText: trimText(values.get("termsText"), 10000),
        privacyText: trimText(values.get("privacyText"), 2000),
      };
      await raffleRequest("save_raffle", payload);
      form.reset();
      setRaffleStatus("Sorteo creado correctamente. Ya puedes revisarlo en la lista de participantes.", "success");
      toast("Sorteo creado");
      await loadRaffleAdmin();
    } catch (error) {
      const message = error instanceof Error ? error.message : "No fue posible crear el sorteo";
      const friendly = message.includes("duplicate") || message.includes("unique") ? "Ese identificador ya existe. Cambia el nombre o usa uno personalizado." : message.includes("raffle-admin") ? "No se pudo conectar con el servidor. Confirma que la verificaciÃ³n en dos pasos estÃ¡ completa." : message;
      setRaffleStatus(friendly, "error");
    }
  });
});
async function setActiveView(view) {
  const target = view === "clients" || view === "site" || view === "participants" ? view : "inbox";
  if ((target === "site" || target === "participants") && !currentUserIsOwner) { toast("Solo la cuenta propietaria puede editar el sitio."); return; }
  activeView = target;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === target));
  $("#inbox-view").hidden = target !== "inbox";
  $("#clients-view").hidden = target !== "clients";
  $("#site-view").hidden = target !== "site";
  $("#participants-view").hidden = target !== "participants";
  $(".metrics").hidden = target === "site" || target === "participants";
  $("#page-title").textContent = target === "clients" ? "Gestión de clientes" : target === "site" ? "Configuración del sitio" : "Bandeja de atención";
  if (target === "site") await loadSiteAdmin();
  if (target === "participants") await loadRaffleAdmin();
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setActiveView(button.dataset.view)));
$("#refresh").addEventListener("click", () => activeView === "site" ? loadSiteAdmin(true) : activeView === "participants" ? loadRaffleAdmin() : loadDashboard(true));
resetServiceForm();
resetPaymentMethodForm();
const quickRaffleForm = $("#raffle-quick-form");
const raffleTools = document.querySelector(".raffle-admin-tools");
if (quickRaffleForm && raffleTools) raffleTools.before(quickRaffleForm);
const catalogTab = $("#site-tab-services");
if (catalogTab) catalogTab.textContent = "CatÃ¡logo";
const catalogHeading = $("#site-panel-services h3");
if (catalogHeading) catalogHeading.textContent = "CatÃ¡logo de productos y servicios";
const catalogDescription = $("#site-panel-services .site-panel-heading p");
if (catalogDescription) catalogDescription.textContent = "Crea productos o servicios, define su precio y conéctalos con Mercado Pago desde un solo panel.";
boot();
