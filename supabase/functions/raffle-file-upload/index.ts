import { adminClient, allowedOrigin, corsHeaders, json, readBodyLimited } from "../_shared/backend.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const allowed = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]);
const starts = (bytes: Uint8Array, values: number[]) => values.every((value, index) => bytes[index] === value);
function detectedType(bytes: Uint8Array) {
  if (bytes.length >= 3 && starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 8 && starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "";
}
Deno.serve(async (request) => {
  const origin = allowedOrigin(request); const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST" || !origin || !request.headers.get("content-type")?.startsWith("multipart/form-data")) return json({ error: "Solicitud no permitida" }, 403, cors);
  const declared = Number(request.headers.get("content-length") || 0); if (!Number.isFinite(declared) || declared < 1 || declared > MAX_BYTES + 32768) return json({ error: "Archivo demasiado grande" }, 413, cors);
  try {
    const form = await request.formData(); const reservationId = String(form.get("reservationId") || ""); const code = String(form.get("reservationCode") || ""); const kind = String(form.get("kind") || ""); const file = form.get("file");
    if (!/^[0-9a-f-]{36}$/i.test(reservationId) || !/^[a-f0-9]{24}$/i.test(code) || !["participant_photo", "payment_receipt"].includes(kind) || !(file instanceof File) || file.size < 32 || file.size > MAX_BYTES) return json({ error: "Archivo o reserva inválidos" }, 422, cors);
    const bytes = new Uint8Array(await file.arrayBuffer()); const mime = detectedType(bytes); if (!allowed.has(mime) || file.type !== mime) return json({ error: "Solo se permiten imágenes JPEG, PNG o WebP válidas" }, 422, cors);
    const client = adminClient(); const reservation = await client.from("raffle_reservations").select("id,state,expires_at").eq("id", reservationId).eq("reservation_code", code).maybeSingle();
    if (reservation.error) throw reservation.error; if (!reservation.data || reservation.data.state !== "active" || new Date(reservation.data.expires_at).getTime() <= Date.now()) return json({ error: "La reserva venció" }, 409, cors);
    const path = `${reservationId}/${kind}-${crypto.randomUUID()}.${allowed.get(mime)}`; const uploaded = await client.storage.from("raffle-private").upload(path, bytes, { contentType: mime, cacheControl: "private, max-age=0", upsert: false }); if (uploaded.error) throw uploaded.error;
    return json({ path, mimeType: mime, byteSize: bytes.length, kind }, 201, cors);
  } catch (error) { console.error("raffle-file-upload", error instanceof Error ? error.message : "unknown"); return json({ error: "No fue posible cargar el archivo" }, 500, cors); }
});
