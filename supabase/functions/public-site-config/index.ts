import { adminClient, allowedOrigin, cleanText, corsHeaders, json } from "../_shared/backend.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_PATH_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/i;
const CTA_TYPES = new Set(["quote", "checkout", "link"]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeHttpsUrl(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.href : "";
  } catch {
    return "";
  }
}

function publicHero(value: unknown) {
  if (!isObject(value)) return null;
  const title = cleanText(value.title, 110);
  const description = cleanText(value.description, 420);
  if (!title || !description) return null;
  const primaryUrl = String(value.primaryUrl || "").startsWith("#") ? cleanText(value.primaryUrl, 90) : safeHttpsUrl(value.primaryUrl);
  const secondaryUrl = String(value.secondaryUrl || "").startsWith("#") ? cleanText(value.secondaryUrl, 90) : safeHttpsUrl(value.secondaryUrl);
  return {
    eyebrow: cleanText(value.eyebrow, 80),
    title,
    highlight: cleanText(value.highlight, 90),
    description,
    primaryLabel: cleanText(value.primaryLabel, 48),
    primaryUrl,
    secondaryLabel: cleanText(value.secondaryLabel, 48),
    secondaryUrl,
  };
}

function publicContact(value: unknown) {
  if (!isObject(value)) return null;
  const title = cleanText(value.title, 110);
  const description = cleanText(value.description, 420);
  if (!title || !description) return null;
  return { eyebrow: cleanText(value.eyebrow, 80), title, description, primaryLabel: cleanText(value.primaryLabel, 48) };
}

function publicService(value: unknown) {
  if (!isObject(value) || !UUID_PATTERN.test(String(value.id || ""))) return null;
  const title = cleanText(value.title, 110);
  const description = cleanText(value.description, 500);
  const price = value.price_cop === null ? null : Number(value.price_cop);
  const cta = isObject(value.cta) ? value.cta : {};
  const type = cleanText(cta.type, 20);
  if (!title || !description || !CTA_TYPES.has(type) || (price !== null && (!Number.isSafeInteger(price) || price < 1_000 || price > 999_999_999))) return null;
  const productCode = cleanText(cta.product_code, 60);
  const url = type === "link" ? safeHttpsUrl(cta.url) : "";
  if ((type === "checkout" && !productCode) || (type === "link" && !url)) return null;
  const features = Array.isArray(value.features) ? value.features.map((item) => cleanText(item, 110)).filter(Boolean).slice(0, 12) : [];
  return {
    id: String(value.id),
    title,
    description,
    features,
    price_cop: price,
    currency: "COP",
    cta: { type, label: cleanText(cta.label, 32) || "Agregar +", url, product_code: productCode },
  };
}

function publicMedia(value: unknown) {
  if (!isObject(value)) return null;
  const storagePath = String(value.storage_path || "");
  if (!UUID_PATTERN.test(String(value.id || "")) || !STORAGE_PATH_PATTERN.test(storagePath)) return null;
  const section = cleanText(value.section, 24);
  if (!["portfolio", "products", "hero"].includes(section)) return null;
  return {
    id: String(value.id),
    title: cleanText(value.title, 120) || "Trabajo CRK",
    alt: cleanText(value.alt, 180) || "Trabajo realizado por CRK Publicity",
    section,
    storage_path: storagePath,
  };
}

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  const cors = corsHeaders(origin, "GET, OPTIONS");
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "GET" || !origin) return json({ error: "Solicitud no permitida" }, 403, cors);

  try {
    const client = adminClient();
    const state = await client.from("site_publication_state").select("active_publication_id").eq("id", true).maybeSingle();
    if (state.error) throw state.error;
    if (!state.data?.active_publication_id) return json({ error: "No hay una publicación activa" }, 404, cors);
    const publication = await client.from("site_publications")
      .select("id,snapshot,checksum,published_at")
      .eq("id", state.data.active_publication_id)
      .maybeSingle();
    if (publication.error) throw publication.error;
    if (!publication.data || !isObject(publication.data.snapshot)) return json({ error: "La publicación no está disponible" }, 404, cors);

    const snapshot = publication.data.snapshot;
    const sourceContent = isObject(snapshot.content) ? snapshot.content : {};
    const services = Array.isArray(snapshot.services) ? snapshot.services.map(publicService).filter(Boolean) : [];
    const media = Array.isArray(snapshot.media) ? snapshot.media.map(publicMedia).filter(Boolean) : [];
    const paths = media.map((item) => item!.storage_path);
    const signedUrls = new Map<string, string>();
    if (paths.length) {
      const signed = await client.storage.from("site-media").createSignedUrls(paths, 3_600);
      if (signed.error) throw signed.error;
      for (const item of signed.data || []) if (item.path && item.signedUrl) signedUrls.set(item.path, item.signedUrl);
    }
    const gallery = media
      .map((item) => item && ({ ...item, image_url: signedUrls.get(item.storage_path) || "" }))
      .filter((item) => item?.image_url);
    return json({
      snapshot: {
        version: 1,
        publicationId: publication.data.id,
        checksum: publication.data.checksum,
        publishedAt: publication.data.published_at,
        content: { hero: publicHero(sourceContent.hero), contact: publicContact(sourceContent.contact) },
        services,
        gallery,
      },
    }, 200, { ...cors, "Cache-Control": "no-store" });
  } catch (error) {
    console.error("public-site-config", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No se pudo cargar la configuración del sitio" }, 500, cors);
  }
});
