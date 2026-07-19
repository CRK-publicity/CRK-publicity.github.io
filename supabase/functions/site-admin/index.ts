import { adminClient, allowedOrigin, cleanText, corsHeaders, json, readBodyLimited, requireCrmOwner, sha256 } from "../_shared/backend.ts";

const MAX_BODY_BYTES = 65_536;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_CTA_TYPES = new Set(["quote", "checkout", "link"]);
const PAYMENT_MODES = new Set(["live", "test"]);
const CONTENT_KEYS = new Set(["hero", "contact"]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, minimum: number, maximum: number, fallback?: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function uuid(value: unknown) {
  const normalized = String(value || "");
  return UUID_PATTERN.test(normalized) ? normalized : "";
}

function slug(value: unknown, maxLength = 60) {
  const normalized = cleanText(value, maxLength)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return normalized;
}

function productCode(value: unknown, maxLength = 60) {
  return cleanText(value, maxLength)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
}

function safeUrl(value: unknown, { allowRelative = false } = {}) {
  const raw = cleanText(value, 1_500);
  if (!raw) return "";
  if (allowRelative && raw.startsWith("#") && /^#[a-z0-9-]{1,80}$/i.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function stringList(value: unknown, maximumItems: number, itemLength: number) {
  if (!Array.isArray(value)) return [];
  const values = value
    .map((item) => cleanText(item, itemLength))
    .filter(Boolean);
  return [...new Set(values)].slice(0, maximumItems);
}

function contentPayload(contentKey: string, input: unknown) {
  if (!isObject(input)) return null;
  if (contentKey === "hero") {
    const title = cleanText(input.title, 110);
    const highlight = cleanText(input.highlight, 90);
    const description = cleanText(input.description, 420);
    if (title.length < 2 || description.length < 2) return null;
    const primaryUrl = safeUrl(input.primaryUrl, { allowRelative: true });
    const secondaryUrl = safeUrl(input.secondaryUrl, { allowRelative: true });
    return {
      eyebrow: cleanText(input.eyebrow, 80),
      title,
      highlight,
      description,
      primaryLabel: cleanText(input.primaryLabel, 48),
      primaryUrl,
      secondaryLabel: cleanText(input.secondaryLabel, 48),
      secondaryUrl,
    };
  }
  if (contentKey === "contact") {
    const title = cleanText(input.title, 110);
    const description = cleanText(input.description, 420);
    if (title.length < 2 || description.length < 2) return null;
    return { eyebrow: cleanText(input.eyebrow, 80), title, description, primaryLabel: cleanText(input.primaryLabel, 48) };
  }
  return null;
}

function servicePayload(input: unknown) {
  if (!isObject(input)) return null;
  const title = cleanText(input.title, 110);
  const description = cleanText(input.description, 500);
  const ctaType = cleanText(input.ctaType, 20);
  const priceCop = input.priceCop === null || input.priceCop === "" ? null : integer(input.priceCop, 1_000, 999_999_999);
  const serviceSlug = slug(input.slug || title);
  if (title.length < 2 || description.length < 2 || !serviceSlug || !SERVICE_CTA_TYPES.has(ctaType) || (input.priceCop !== null && input.priceCop !== "" && priceCop === undefined)) return null;
  if (ctaType === "checkout" && priceCop === null) return null;
  const checkoutProductCode = ctaType === "checkout" ? productCode(input.checkoutProductCode || serviceSlug, 60) : "";
  const ctaUrl = ctaType === "link" ? safeUrl(input.ctaUrl) : "";
  if (ctaType === "checkout" && !checkoutProductCode) return null;
  if (ctaType === "link" && !ctaUrl) return null;
  return {
    slug: serviceSlug,
    title,
    description,
    features: stringList(input.features, 12, 110),
    price_cop: priceCop,
    currency: "COP",
    cta_type: ctaType,
    checkout_product_code: checkoutProductCode || null,
    cta_url: ctaUrl || null,
    sort_order: integer(input.sortOrder, 0, 9_999, 0),
    published: input.published === true,
  };
}

function paymentMethodPayload(input: unknown) {
  if (!isObject(input)) return null;
  const code = slug(input.code, 40).replace(/-/g, "_");
  const label = cleanText(input.label, 80);
  const provider = cleanText(input.provider, 32);
  const mode = cleanText(input.mode, 10);
  if (code !== "mercado_pago" || label.length < 2 || provider !== "mercado_pago" || !PAYMENT_MODES.has(mode)) return null;
  return {
    code,
    label,
    provider,
    mode,
    enabled: input.enabled === true,
    checkout_url: null,
    instructions: null,
    sort_order: integer(input.sortOrder, 0, 9_999, 0),
  };
}

function clientError(message: string, status = 422) {
  return { error: message, status };
}

async function saveContent(data: JsonObject, ownerId: string) {
  const contentKey = cleanText(data.contentKey, 24);
  const payload = contentPayload(contentKey, data.payload);
  const version = integer(data.version, 0, 1_000_000);
  if (!CONTENT_KEYS.has(contentKey) || !payload || version === undefined) return clientError("El bloque de contenido no es válido");
  const client = adminClient();
  if (version === 0) {
    const result = await client.from("site_content").insert({ content_key: contentKey, payload, version: 1, created_by: ownerId, updated_by: ownerId }).select().maybeSingle();
    if (result.error) return clientError("El contenido ya existe o no se pudo guardar", 409);
    return { data: result.data };
  }
  const result = await client.from("site_content")
    .update({ payload, version: version + 1, updated_by: ownerId })
    .eq("content_key", contentKey)
    .eq("version", version)
    .select()
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return clientError("El contenido cambió en otra sesión. Recarga antes de guardar.", 409);
  return { data: result.data };
}

async function saveService(data: JsonObject, ownerId: string) {
  const values = servicePayload(data);
  const id = uuid(data.id);
  const version = integer(data.version, 1, 1_000_000);
  if (!values || (id && version === undefined)) return clientError("Revisa los campos del servicio");
  const client = adminClient();
  if (!id) {
    const result = await client.from("site_services").insert({ ...values, archived: false, version: 1, created_by: ownerId, updated_by: ownerId }).select().single();
    if (result.error) throw result.error;
    return { data: result.data };
  }
  const result = await client.from("site_services")
    .update({ ...values, version: Number(version) + 1, updated_by: ownerId })
    .eq("id", id)
    .eq("version", version)
    .select()
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return clientError("El servicio cambió en otra sesión. Recarga antes de guardar.", 409);
  return { data: result.data };
}

async function savePaymentMethod(data: JsonObject, ownerId: string) {
  const values = paymentMethodPayload(data);
  const id = uuid(data.id);
  const version = integer(data.version, 1, 1_000_000);
  if (!values || (id && version === undefined)) return clientError("Revisa los campos del medio de pago");
  const client = adminClient();
  if (!id) {
    const existing = await client.from("payment_methods").select("id").eq("code", "mercado_pago").maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return clientError("Edita la configuración existente de Mercado Pago", 409);
    const result = await client.from("payment_methods").insert({ ...values, version: 1, created_by: ownerId, updated_by: ownerId }).select().single();
    if (result.error) throw result.error;
    return { data: result.data };
  }
  const result = await client.from("payment_methods")
    .update({ ...values, version: Number(version) + 1, updated_by: ownerId })
    .eq("id", id)
    .eq("version", version)
    .select()
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return clientError("El medio de pago cambió en otra sesión. Recarga antes de guardar.", 409);
  return { data: result.data };
}

async function deleteRecord(table: "site_services" | "payment_methods" | "site_media", id: string, version: unknown, ownerId: string) {
  const recordVersion = integer(version, 1, 1_000_000);
  if (!uuid(id) || recordVersion === undefined) return clientError("El identificador o la versión no son válidos");
  const client = adminClient();
  if (table === "site_services" || table === "site_media") {
    const result = await client.from(table)
      .update({ archived: true, published: false, updated_by: ownerId })
      .eq("id", id)
      .eq("version", recordVersion)
      .eq("archived", false)
      .select("id")
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) return clientError("El registro cambió en otra sesión. Recarga antes de archivarlo.", 409);
    return { data: { id, archived: true } };
  }
  const prepared = await client.from("payment_methods")
    .update({ updated_by: ownerId })
    .eq("id", id)
    .eq("version", recordVersion)
    .select("id,version")
    .maybeSingle();
  if (prepared.error) throw prepared.error;
  if (!prepared.data) return clientError("El medio de pago cambió en otra sesión. Recarga antes de eliminarlo.", 409);
  const result = await client.from("payment_methods").delete().eq("id", id).eq("version", prepared.data.version).select("id").maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return clientError("El medio de pago no se pudo eliminar", 409);
  return { data: { id } };
}

function publicSnapshot(contentRows: Array<JsonObject>, services: Array<JsonObject>, media: Array<JsonObject>, paymentMethods: Array<JsonObject>) {
  const content: Record<string, unknown> = {};
  for (const row of contentRows) {
    if (typeof row.content_key === "string" && isObject(row.payload)) content[row.content_key] = row.payload;
  }
  return {
    schema_version: 1,
    content,
    services: services
      .filter((item) => item.published === true)
      .map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        features: Array.isArray(item.features) ? item.features : [],
        price_cop: item.price_cop,
        currency: item.currency,
        cta: { type: item.cta_type, label: "Agregar +", url: item.cta_url, product_code: item.checkout_product_code },
        sort_order: item.sort_order,
      })),
    media: media
      .filter((item) => item.published === true)
      .map((item) => ({
        id: item.id,
        title: item.title || "Trabajo CRK",
        alt: item.alt_text,
        section: item.section,
        storage_path: item.storage_path,
        sort_order: item.sort_order,
      })),
    payment_methods: paymentMethods
      .filter((item) => item.enabled === true)
      .map((item) => ({ code: item.code, label: item.label, provider: item.provider, mode: item.mode })),
  };
}

async function getDashboard() {
  const client = adminClient();
  const [content, services, media, paymentMethods, state] = await Promise.all([
    client.from("site_content").select("content_key,payload,version,updated_at").order("content_key"),
    client.from("site_services").select("id,slug,title,description,features,price_cop,currency,cta_type,checkout_product_code,cta_url,sort_order,published,version,updated_at").eq("archived", false).order("sort_order").order("created_at"),
    client.from("site_media").select("id,title,storage_path,mime_type,byte_size,width,height,alt_text,section,sort_order,published,version,updated_at").eq("archived", false).order("sort_order").order("created_at"),
    client.from("payment_methods").select("id,code,label,provider,mode,enabled,checkout_url,instructions,sort_order,version,updated_at").order("sort_order").order("created_at"),
    client.from("site_publication_state").select("active_publication_id").eq("id", true).maybeSingle(),
  ]);
  for (const result of [content, services, media, paymentMethods, state]) if (result.error) throw result.error;
  const contentMap: Record<string, unknown> = {};
  for (const row of content.data || []) contentMap[row.content_key] = { payload: row.payload, version: row.version, updatedAt: row.updated_at };
  const mediaRows = media.data || [];
  const paths = mediaRows.map((item) => item.storage_path).filter((item): item is string => typeof item === "string" && item.length > 0);
  const signedUrls = new Map<string, string>();
  if (paths.length) {
    const signed = await client.storage.from("site-media").createSignedUrls(paths, 900);
    if (signed.error) throw signed.error;
    for (const item of signed.data || []) if (item.path && item.signedUrl) signedUrls.set(item.path, item.signedUrl);
  }
  let publication: { id: string | null; published_at?: string; checksum?: string } = { id: state.data?.active_publication_id || null };
  if (publication.id) {
    const current = await client.from("site_publications").select("id,published_at,checksum").eq("id", publication.id).maybeSingle();
    if (current.error) throw current.error;
    if (current.data) publication = current.data;
  }
  return {
    content: contentMap,
    services: services.data || [],
    media: mediaRows.map((item) => ({ ...item, preview_url: signedUrls.get(item.storage_path) || "" })),
    paymentMethods: paymentMethods.data || [],
    publication,
  };
}

async function publishSite(ownerId: string) {
  const dashboard = await getDashboard();
  const contentRows = Object.entries(dashboard.content).map(([content_key, value]) => {
    const entry = isObject(value) ? value : {};
    return { content_key, payload: entry.payload };
  });
  const snapshot = publicSnapshot(contentRows, dashboard.services as Array<JsonObject>, dashboard.media as Array<JsonObject>, dashboard.paymentMethods as Array<JsonObject>);
  const checksum = await sha256(JSON.stringify(snapshot));
  const client = adminClient();
  const result = await client.rpc("publish_site_snapshot", { p_snapshot: { ...snapshot, __actor_id: ownerId }, p_checksum: checksum });
  if (result.error) throw result.error;
  const publication = Array.isArray(result.data) ? result.data[0] : result.data;
  return { publication: publication ? { id: String(publication) } : null, checksum };
}

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST" || !origin) return json({ error: "Solicitud no permitida" }, 403, cors);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Tipo de contenido no permitido" }, 415, cors);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Solicitud demasiado grande" }, 413, cors);

  try {
    const auth = await requireCrmOwner(request);
    if (auth.error) return json({ error: auth.error.message }, auth.error.status, cors);
    const bytes = await readBodyLimited(request, MAX_BODY_BYTES);
    if (!bytes) return json({ error: "Solicitud demasiado grande" }, 413, cors);
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!isObject(body) || !isObject(body.data)) return json({ error: "Solicitud inválida" }, 400, cors);
    const action = cleanText(body.action, 40);
    let result: JsonObject | { error: string; status: number };
    if (action === "get_dashboard") result = await getDashboard();
    else if (action === "save_content") result = await saveContent(body.data, auth.owner.userId);
    else if (action === "save_service") result = await saveService(body.data, auth.owner.userId);
    else if (action === "delete_service") result = await deleteRecord("site_services", uuid(body.data.id), body.data.version, auth.owner.userId);
    else if (action === "save_payment_method") result = await savePaymentMethod(body.data, auth.owner.userId);
    else if (action === "delete_payment_method") result = await deleteRecord("payment_methods", uuid(body.data.id), body.data.version, auth.owner.userId);
    else if (action === "delete_media") result = await deleteRecord("site_media", uuid(body.data.id), body.data.version, auth.owner.userId);
    else if (action === "publish_site") result = await publishSite(auth.owner.userId);
    else return json({ error: "Acción no permitida" }, 400, cors);
    if ("error" in result) return json({ error: result.error }, result.status, cors);
    return json({ ok: true, ...result }, 200, cors);
  } catch (error) {
    console.error("site-admin", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No se pudo completar la operación" }, 500, cors);
  }
});
