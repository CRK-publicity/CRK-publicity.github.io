import { adminClient, allowedOrigin, cleanText, corsHeaders, json, normalizePhone, readBodyLimited, sha256 } from "../_shared/backend.ts";

const MAX_BODY_BYTES = 65_536;
const MAX_REQUESTS_PER_HOUR = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number) => {
  const parsed = Number(value); return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

function clientFingerprint(request: Request) {
  return sha256(`${request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown"}|${request.headers.get("user-agent") || ""}`);
}

async function limited(client: ReturnType<typeof adminClient>, fingerprint: string, action: "reserve" | "submit") {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const count = await client.from("raffle_public_requests").select("id", { count: "exact", head: true }).eq("fingerprint_hash", fingerprint).eq("action", action).gte("created_at", since);
  if (count.error) throw count.error;
  if ((count.count || 0) >= MAX_REQUESTS_PER_HOUR) return true;
  const created = await client.from("raffle_public_requests").insert({ fingerprint_hash: fingerprint, action });
  if (created.error) throw created.error;
  return false;
}

function publicRaffle(row: Data, numbers: Data[], imageUrls: Map<string, string>) {
  const status = String(row.status || "");
  const visible = ["upcoming", "active", "sold_out", "finished"].includes(status) && !row.archived_at;
  if (!visible) return null;
  const bannerPath = cleanText(row.banner_path, 500);
  const prizePath = cleanText(row.prize_image_path, 500);
  const safeNumber = (item: Data) => ({ number: Number(item.number), state: String(item.state) });
  return {
    id: String(row.id), slug: cleanText(row.slug, 80), title: cleanText(row.title, 140), description: cleanText(row.description, 3000),
    legalType: cleanText(row.legal_type, 32), status, prizeName: cleanText(row.prize_name, 160), priceCop: Number(row.price_cop),
    startsAt: row.starts_at, closesAt: row.closes_at, drawAt: row.draw_at, maxNumbersPerParticipant: Number(row.max_numbers_per_participant),
    termsText: cleanText(row.terms_text, 10000), privacyText: cleanText(row.privacy_text, 2000), privacyVersion: cleanText(row.privacy_version, 40),
    paymentInstructions: cleanText(row.payment_instructions, 2000), nequiNumber: cleanText(row.nequi_number, 30),
    bannerUrl: bannerPath ? imageUrls.get(bannerPath) || "" : "", prizeImageUrl: prizePath ? imageUrls.get(prizePath) || "" : "",
    availableCount: numbers.filter((item) => item.state === "available").length,
    participantCount: numbers.filter((item) => ["pending_validation", "paid", "winner"].includes(String(item.state))).length,
    numbers: numbers.map(safeNumber),
    winner: row.winner_published && row.winner_number !== null ? { number: Number(row.winner_number) } : null,
  };
}

async function listRaffles() {
  const client = adminClient();
  await client.rpc("release_expired_raffle_reservations", { p_raffle_id: null });
  const raffles = await client.from("raffles").select("id,slug,title,description,legal_type,status,banner_path,prize_image_path,prize_name,price_cop,starts_at,closes_at,draw_at,max_numbers_per_participant,terms_text,privacy_text,privacy_version,payment_instructions,nequi_number,winner_published,winner_number,archived_at").in("status", ["upcoming", "active", "sold_out", "finished"]).is("archived_at", null).order("starts_at", { ascending: false });
  if (raffles.error) throw raffles.error;
  const ids = (raffles.data || []).map((item) => item.id);
  const numbers = ids.length ? await client.from("raffle_numbers").select("raffle_id,number,state").in("raffle_id", ids) : { data: [], error: null };
  if (numbers.error) throw numbers.error;
  const paths = (raffles.data || []).flatMap((row) => [row.banner_path, row.prize_image_path]).filter((item): item is string => typeof item === "string" && item.length > 0);
  const signed = paths.length ? await client.storage.from("raffle-private").createSignedUrls([...new Set(paths)], 900) : { data: [], error: null };
  if (signed.error) throw signed.error;
  const urls = new Map((signed.data || []).filter((item) => item.path && item.signedUrl).map((item) => [item.path, item.signedUrl]));
  return (raffles.data || []).map((raffle) => publicRaffle(raffle, (numbers.data || []).filter((number) => number.raffle_id === raffle.id), urls)).filter(Boolean);
}

async function reserve(request: Request, data: Data) {
  const raffleId = String(data.raffleId || "");
  const numbers = Array.isArray(data.numbers) ? data.numbers.map((item) => integer(item, 0, 99)).filter((item): item is number => item !== null) : [];
  if (!UUID.test(raffleId) || !numbers.length || numbers.length !== new Set(numbers).size || data.website) return json({ error: "La selección no es válida" }, 422);
  const client = adminClient(); const fingerprint = await clientFingerprint(request);
  if (await limited(client, fingerprint, "reserve")) return json({ error: "Intenta nuevamente más tarde" }, 429);
  const result = await client.rpc("reserve_raffle_numbers", { p_raffle_id: raffleId, p_numbers: numbers, p_fingerprint_hash: fingerprint });
  if (result.error) return json({ error: "Algunos números ya no están disponibles" }, 409);
  const reservation = Array.isArray(result.data) ? result.data[0] : null;
  if (!reservation) return json({ error: "No se pudo crear la reserva" }, 409);
  return json({ reservation: { id: reservation.reservation_id, code: reservation.reservation_code, expiresAt: reservation.expires_at, numbers } }, 201);
}

async function submit(request: Request, data: Data) {
  const reservationId = String(data.reservationId || ""); const code = cleanText(data.reservationCode, 64);
  const fullName = cleanText(data.fullName, 140); const phone = normalizePhone(cleanText(data.phone, 32)); const email = cleanText(data.email, 254);
  const city = cleanText(data.city, 100); const reference = cleanText(data.paymentReference, 120); const observations = cleanText(data.observations, 1000);
  const reportedAmount = data.reportedAmount === "" ? null : integer(data.reportedAmount, 0, 999999999);
  const receipt = object(data.receipt) ? data.receipt : {}; const participantPhoto = object(data.participantPhoto) ? data.participantPhoto : {};
  const receiptPath = cleanText(receipt.path, 300); const participantPhotoPath = cleanText(participantPhoto.path, 300);
  const receiptSize = integer(receipt.byteSize, 32, 5_242_880); const photoSize = participantPhotoPath ? integer(participantPhoto.byteSize, 32, 5_242_880) : null;
  const expectedPrefix = `${reservationId}/`;
  if (!UUID.test(reservationId) || !code || fullName.length < 2 || !phone || !receiptPath.startsWith(expectedPrefix) || receiptSize === null || (participantPhotoPath && (!participantPhotoPath.startsWith(expectedPrefix) || photoSize === null)) || data.consent !== true || data.website || (data.reportedAmount !== "" && reportedAmount === null)) return json({ error: "Revisa los datos obligatorios, el comprobante y la autorización" }, 422);
  const client = adminClient(); const fingerprint = await clientFingerprint(request);
  if (await limited(client, fingerprint, "submit")) return json({ error: "Intenta nuevamente más tarde" }, 429);
  const reservation = await client.from("raffle_reservations").select("id,raffle_id,numbers,state,expires_at").eq("id", reservationId).eq("reservation_code", code).maybeSingle();
  if (reservation.error) throw reservation.error;
  if (!reservation.data || reservation.data.state !== "active" || new Date(reservation.data.expires_at).getTime() <= Date.now()) return json({ error: "La reserva venció. Selecciona los números nuevamente." }, 409);
  const raffle = await client.from("raffles").select("price_cop,privacy_version").eq("id", reservation.data.raffle_id).maybeSingle();
  if (raffle.error || !raffle.data) throw raffle.error || new Error("raffle_missing");
  const expected = Number(raffle.data.price_cop) * reservation.data.numbers.length;
  const contact = await client.from("contacts").upsert({ full_name: fullName, phone_e164: phone, email: email || null, source: "raffle", consent_status: "granted", consent_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }, { onConflict: "phone_e164" }).select("id").single();
  if (contact.error) throw contact.error;
  const participant = await client.from("raffle_participants").insert({ raffle_id: reservation.data.raffle_id, reservation_id: reservation.data.id, contact_id: contact.data.id, full_name: fullName, phone_e164: phone, email: email || null, city: city || null, participant_photo_path: participantPhotoPath || null, receipt_path: receiptPath, payment_reference: reference || null, expected_amount_cop: expected, reported_amount_cop: reportedAmount, paid_at: data.paidAt ? new Date(String(data.paidAt)).toISOString() : null, observations: observations || null, consent_accepted_at: new Date().toISOString(), consent_policy_version: raffle.data.privacy_version, consent_evidence: { fingerprint_hash: fingerprint, channel: "web" }, marketing_consent: data.marketingConsent === true, marketing_consent_at: data.marketingConsent === true ? new Date().toISOString() : null });
  if (participant.error) return json({ error: "Ya existe un registro para esta reserva" }, 409);
  const finalized = await client.rpc("finalize_raffle_participation", { p_reservation_id: reservationId, p_reservation_code: code, p_participant_id: participant.data.id });
  if (finalized.error) { await client.from("raffle_participants").delete().eq("id", participant.data.id); return json({ error: "La reserva ya no es válida" }, 409); }
  await client.from("raffle_files").insert([{ raffle_id: reservation.data.raffle_id, participant_id: participant.data.id, kind: "payment_receipt", storage_path: receiptPath, content_type: cleanText(receipt.mimeType, 40) || "image/jpeg", byte_size: receiptSize }, ...(participantPhotoPath ? [{ raffle_id: reservation.data.raffle_id, participant_id: participant.data.id, kind: "participant_photo", storage_path: participantPhotoPath, content_type: cleanText(participantPhoto.mimeType, 40) || "image/jpeg", byte_size: photoSize! }] : [])]);
  await client.from("raffle_audit_log").insert({ raffle_id: reservation.data.raffle_id, participant_id: participant.data.id, action: "participant_submitted", after_data: { numbers: reservation.data.numbers, expected_amount_cop: expected } });
  return json({ participantId: participant.data.id, expectedAmountCop: expected, status: "pending_validation" }, 201);
}

Deno.serve(async (request) => {
  const origin = allowedOrigin(request); const cors = corsHeaders(origin, "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (!origin) return json({ error: "Origen no permitido" }, 403, cors);
  try {
    if (request.method === "GET") return json({ raffles: await listRaffles() }, 200, { ...cors, "Cache-Control": "no-store" });
    if (request.method !== "POST") return json({ error: "Método no permitido" }, 405, cors);
    const bytes = await readBodyLimited(request, MAX_BODY_BYTES); if (!bytes) return json({ error: "Solicitud demasiado grande" }, 413, cors);
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (!object(data)) return json({ error: "Solicitud inválida" }, 422, cors);
    const action = cleanText(data.action, 32); const response = action === "reserve" ? await reserve(request, data) : action === "submit" ? await submit(request, data) : json({ error: "Acción inválida" }, 422);
    response.headers.set("Access-Control-Allow-Origin", origin); response.headers.set("Vary", "Origin"); return response;
  } catch (error) { console.error("raffle-public", error instanceof Error ? error.message : "unknown"); return json({ error: "No fue posible procesar la solicitud" }, 500, cors); }
});
