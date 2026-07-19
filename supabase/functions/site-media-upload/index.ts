import { adminClient, allowedOrigin, cleanText, corsHeaders, json, requireCrmOwner } from "../_shared/backend.ts";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, sequence: number[], offset = 0) {
  return sequence.every((value, index) => bytes[offset + index] === value);
}

function imageType(bytes: Uint8Array) {
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= PNG_SIGNATURE.length && startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "";
}

function concatenate(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function stripJpegMetadata(bytes: Uint8Array) {
  if (imageType(bytes) !== "image/jpeg") return bytes;
  const chunks = [bytes.slice(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return concatenate([...chunks, bytes.slice(offset)]);
    let markerEnd = offset + 1;
    while (markerEnd < bytes.length && bytes[markerEnd] === 0xff) markerEnd += 1;
    if (markerEnd >= bytes.length) return concatenate([...chunks, bytes.slice(offset)]);
    const marker = bytes[markerEnd];
    const markerStart = offset;
    offset = markerEnd + 1;
    if (marker === 0xd9 || marker === 0xda) return concatenate([...chunks, bytes.slice(markerStart)]);
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(bytes.slice(markerStart, offset));
      continue;
    }
    if (offset + 2 > bytes.length) return concatenate([...chunks, bytes.slice(markerStart)]);
    const size = (bytes[offset] << 8) | bytes[offset + 1];
    const segmentEnd = offset + size;
    if (size < 2 || segmentEnd > bytes.length) return concatenate([...chunks, bytes.slice(markerStart)]);
    // EXIF, IPTC and JPEG comments can carry personal metadata; they are not needed for public portfolio media.
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) chunks.push(bytes.slice(markerStart, segmentEnd));
    offset = segmentEnd;
  }
  return concatenate(chunks);
}

function stripPngMetadata(bytes: Uint8Array) {
  if (imageType(bytes) !== "image/png") return bytes;
  const chunks = [bytes.slice(0, 8)];
  const metadata = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const end = offset + 12 + size;
    if (end > bytes.length) return bytes;
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    if (!metadata.has(type)) chunks.push(bytes.slice(offset, end));
    offset = end;
    if (type === "IEND") return concatenate(chunks);
  }
  return bytes;
}

function stripWebpMetadata(bytes: Uint8Array) {
  if (imageType(bytes) !== "image/webp") return bytes;
  const chunks = [bytes.slice(0, 12)];
  const metadata = new Set(["EXIF", "XMP "]);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = new TextDecoder().decode(bytes.slice(offset, offset + 4));
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const paddedSize = size + (size % 2);
    const end = offset + 8 + paddedSize;
    if (end > bytes.length) return bytes;
    if (!metadata.has(type)) chunks.push(bytes.slice(offset, end));
    offset = end;
  }
  const output = concatenate(chunks);
  new DataView(output.buffer).setUint32(4, output.length - 8, true);
  return output;
}

function sanitizeImage(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/jpeg") return stripJpegMetadata(bytes);
  if (mimeType === "image/png") return stripPngMetadata(bytes);
  if (mimeType === "image/webp") return stripWebpMetadata(bytes);
  return bytes;
}

function dimensions(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (size < 2 || offset + 2 + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: (bytes[offset + 7] << 8) | bytes[offset + 8], height: (bytes[offset + 5] << 8) | bytes[offset + 6] };
      }
      offset += 2 + size;
    }
  }
  if (mimeType === "image/webp" && bytes.length >= 30) {
    const chunkType = new TextDecoder().decode(bytes.slice(12, 16));
    const chunkStart = 20;
    if (chunkType === "VP8X" && bytes.length >= chunkStart + 10) {
      const width = 1 + bytes[chunkStart + 4] + (bytes[chunkStart + 5] << 8) + (bytes[chunkStart + 6] << 16);
      const height = 1 + bytes[chunkStart + 7] + (bytes[chunkStart + 8] << 8) + (bytes[chunkStart + 9] << 16);
      return { width, height };
    }
    if (chunkType === "VP8 " && bytes.length >= chunkStart + 10 && startsWith(bytes, [0x9d, 0x01, 0x2a], chunkStart + 3)) {
      return {
        width: ((bytes[chunkStart + 6] | (bytes[chunkStart + 7] << 8)) & 0x3fff),
        height: ((bytes[chunkStart + 8] | (bytes[chunkStart + 9] << 8)) & 0x3fff),
      };
    }
    if (chunkType === "VP8L" && bytes.length >= chunkStart + 5 && bytes[chunkStart] === 0x2f) {
      const bits = new DataView(bytes.buffer, bytes.byteOffset + chunkStart + 1, 4).getUint32(0, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
  }
  return { width: null, height: null };
}

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST" || !origin) return json({ error: "Solicitud no permitida" }, 403, cors);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) return json({ error: "Tipo de contenido no permitido" }, 415, cors);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > MAX_UPLOAD_BYTES + 32_768) return json({ error: "Archivo demasiado grande" }, 413, cors);

  try {
    const auth = await requireCrmOwner(request);
    if (auth.error) return json({ error: auth.error.message }, auth.error.status, cors);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 32 || file.size > MAX_UPLOAD_BYTES) return json({ error: "Selecciona una imagen de hasta 5 MB" }, 422, cors);
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const detectedMime = imageType(rawBytes);
    if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime) || file.type !== detectedMime) {
      return json({ error: "Solo se permiten imágenes JPEG, PNG o WebP válidas" }, 422, cors);
    }
    const bytes = sanitizeImage(rawBytes, detectedMime);
    if (bytes.length > MAX_UPLOAD_BYTES) return json({ error: "La imagen supera el límite de 5 MB" }, 422, cors);
    const size = dimensions(bytes, detectedMime);
    if ((size.width && (size.width < 32 || size.width > 8_000)) || (size.height && (size.height < 32 || size.height > 8_000))) {
      return json({ error: "La imagen debe medir entre 32 y 8000 píxeles por lado" }, 422, cors);
    }
    const title = cleanText(form.get("title"), 120) || "Trabajo CRK";
    const altText = cleanText(form.get("altText"), 180);
    const section = cleanText(form.get("section"), 24);
    const sortOrder = Number(form.get("sortOrder"));
    const published = form.get("published") === "true";
    if (title.length < 2 || altText.length < 2 || !["portfolio", "products", "hero"].includes(section) || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9_999) {
      return json({ error: "Completa el título alternativo, la sección y el orden" }, 422, cors);
    }

    const extension = ALLOWED_MIME_TYPES.get(detectedMime)!;
    const storagePath = `${auth.owner.userId}/${crypto.randomUUID()}.${extension}`;
    const client = adminClient();
    const upload = await client.storage.from("site-media").upload(storagePath, bytes, {
      contentType: detectedMime,
      cacheControl: "86400",
      upsert: false,
    });
    if (upload.error) throw upload.error;
    const created = await client.from("site_media").insert({
      title,
      storage_path: storagePath,
      mime_type: detectedMime,
      byte_size: bytes.length,
      width: size.width,
      height: size.height,
      alt_text: altText,
      section,
      sort_order: sortOrder,
      published,
      archived: false,
      version: 1,
      created_by: auth.owner.userId,
      updated_by: auth.owner.userId,
    }).select().single();
    if (created.error) {
      await client.storage.from("site-media").remove([storagePath]);
      throw created.error;
    }
    return json({ ok: true, media: created.data }, 201, cors);
  } catch (error) {
    console.error("site-media-upload", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No se pudo guardar la imagen" }, 500, cors);
  }
});
