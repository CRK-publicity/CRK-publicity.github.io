import { adminClient, allowedOrigin, corsHeaders, json, requireCrmOwner } from "../_shared/backend.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const extensions = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]);
const starts = (bytes: Uint8Array, values: number[]) => values.every((value, index) => bytes[index] === value);
function fileType(bytes: Uint8Array) { if (bytes.length >= 3 && starts(bytes, [255, 216, 255])) return "image/jpeg"; if (bytes.length >= 8 && starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png"; if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp"; return ""; }

Deno.serve(async (request) => {
  const origin = allowedOrigin(request); const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST" || !origin || !request.headers.get("content-type")?.startsWith("multipart/form-data")) return json({ error: "Solicitud no permitida" }, 403, cors);
  try {
    const auth = await requireCrmOwner(request); if (auth.error) return json({ error: auth.error.message }, auth.error.status, cors);
    const form = await request.formData(); const file = form.get("file"); const kind = String(form.get("kind") || "");
    if (!(file instanceof File) || file.size < 32 || file.size > MAX_BYTES || !["banner", "prize"].includes(kind)) return json({ error: "Selecciona una imagen válida de hasta 5 MB" }, 422, cors);
    const bytes = new Uint8Array(await file.arrayBuffer()); const mime = fileType(bytes); if (!extensions.has(mime) || file.type !== mime) return json({ error: "Solo se permite JPEG, PNG o WebP" }, 422, cors);
    const path = `admin/${auth.owner.userId}/${kind}-${crypto.randomUUID()}.${extensions.get(mime)}`; const client = adminClient(); const upload = await client.storage.from("raffle-private").upload(path, bytes, { contentType: mime, cacheControl: "private, max-age=0", upsert: false }); if (upload.error) throw upload.error;
    return json({ path, mimeType: mime, byteSize: bytes.length }, 201, cors);
  } catch (error) { console.error("raffle-admin-upload", error instanceof Error ? error.message : "unknown"); return json({ error: "No fue posible subir la imagen" }, 500, cors); }
});
