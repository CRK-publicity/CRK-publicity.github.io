import { adminClient, cleanText, hmacSha256, json, readBodyLimited, safeEqual, sha256 } from "../_shared/backend.ts";

const MAX_WEBHOOK_BYTES = 65_536;

function signatureParts(value: string | null) {
  const parts = new Map<string, string>();
  for (const item of String(value || "").split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    parts.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  return { timestamp: parts.get("ts") || "", signature: parts.get("v1") || "" };
}

function internalStatus(providerStatus: string): string | null {
  if (providerStatus === "approved") return "approved";
  if (["pending", "in_process", "in_mediation", "authorized"].includes(providerStatus)) return "pending";
  if (providerStatus === "rejected") return "rejected";
  if (providerStatus === "cancelled") return "cancelled";
  if (providerStatus === "refunded") return "refunded";
  if (providerStatus === "charged_back") return "charged_back";
  return null;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Tipo de contenido no permitido" }, 415);

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_WEBHOOK_BYTES) return json({ error: "Solicitud demasiado grande" }, 413);

  const accessToken = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN") || "";
  const webhookSecret = Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET") || "";
  const modeValue = Deno.env.get("MERCADO_PAGO_USE_SANDBOX") || "";
  if (!accessToken || !webhookSecret || !["true", "false"].includes(modeValue)) {
    return json({ error: "Webhook no configurado" }, 503);
  }
  const expectLiveMode = modeValue === "false";

  const url = new URL(request.url);
  const dataId = cleanText(url.searchParams.get("data.id"), 80).toLowerCase();
  const requestId = cleanText(request.headers.get("x-request-id"), 200);
  const parsedSignature = signatureParts(request.headers.get("x-signature"));
  if (!/^[a-z0-9_-]{1,80}$/.test(dataId) || !requestId || !/^[0-9]{10,20}$/.test(parsedSignature.timestamp)
    || !/^[a-f0-9]{64}$/i.test(parsedSignature.signature)) {
    return json({ error: "Firma incompleta" }, 401);
  }

  const manifest = "id:" + dataId + ";request-id:" + requestId + ";ts:" + parsedSignature.timestamp + ";";
  const expected = await hmacSha256(webhookSecret, manifest);
  if (!safeEqual(expected, parsedSignature.signature.toLowerCase())) return json({ error: "Firma inválida" }, 401);

  try {
    const bytes = await readBodyLimited(request, MAX_WEBHOOK_BYTES);
    if (!bytes) return json({ error: "Solicitud demasiado grande" }, 413);
    const rawBody = new TextDecoder().decode(bytes);
    const payloadHash = await sha256(rawBody);
    const payload = JSON.parse(rawBody);
    if (!payload || Array.isArray(payload) || typeof payload !== "object") return json({ error: "Notificación inválida" }, 400);

    const eventType = cleanText(payload.type, 60);
    const eventAction = cleanText(payload.action, 100);
    const bodyDataId = cleanText(payload.data?.id, 80).toLowerCase();
    if (eventType !== "payment" || bodyDataId !== dataId) return json({ accepted: true, outcome: "ignored" }, 200);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let response;
    try {
      response = await fetch("https://api.mercadopago.com/v1/payments/" + encodeURIComponent(dataId), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Authorization: "Bearer " + accessToken },
      });
    } finally {
      clearTimeout(timeout);
    }

    const payment = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("Mercado Pago payment lookup failed with status " + response.status);

    const paymentId = cleanText(payment.id, 40);
    const externalReference = cleanText(payment.external_reference, 80);
    const providerStatus = cleanText(payment.status, 60);
    const rawStatusDetail = cleanText(payment.status_detail || "unknown", 100);
    const collectorId = cleanText(payment.collector_id, 30);
    const currency = cleanText(payment.currency_id, 3);
    const amount = Number(payment.transaction_amount);
    const refundedAmount = Number(payment.transaction_amount_refunded || 0);
    const providerUpdatedAt = new Date(String(payment.date_last_updated || ""));
    const liveMode = payment.live_mode;
    if (paymentId !== dataId || !externalReference || !providerStatus || !/^[0-9]{1,30}$/.test(collectorId)
      || currency !== "COP" || !Number.isSafeInteger(amount) || amount <= 0
      || !Number.isSafeInteger(refundedAmount) || refundedAmount < 0 || refundedAmount > amount
      || Number.isNaN(providerUpdatedAt.getTime()) || typeof liveMode !== "boolean") {
      return json({ error: "Datos de pago inválidos" }, 422);
    }
    if (liveMode !== expectLiveMode) return json({ error: "Modo de pago no permitido" }, 422);

    let mappedStatus = internalStatus(providerStatus);
    let statusDetail = rawStatusDetail;
    if (refundedAmount === amount && amount > 0) mappedStatus = "refunded";
    else if (refundedAmount > 0) {
      mappedStatus = null;
      statusDetail = cleanText("partial_refund:" + rawStatusDetail, 120);
    }

    const eventKey = "mp:" + await sha256(manifest);
    const result = await adminClient().rpc("apply_mercado_pago_payment", {
      p_external_reference: externalReference,
      p_provider_payment_id: paymentId,
      p_internal_status: mappedStatus,
      p_provider_status: providerStatus,
      p_provider_status_detail: statusDetail,
      p_provider_updated_at: providerUpdatedAt.toISOString(),
      p_amount_cop: amount,
      p_refunded_amount_cop: refundedAmount,
      p_currency: currency,
      p_collector_id: collectorId,
      p_event_key: eventKey,
      p_event_type: eventType,
      p_event_action: eventAction,
      p_payload_hash: payloadHash,
    });
    const outcome = Array.isArray(result.data) ? result.data[0]?.outcome : null;
    if (result.error || typeof outcome !== "string") throw result.error || new Error("Payment event transaction returned invalid data");

    if (["amount_mismatch", "collector_mismatch", "duplicate_payment", "unsupported_status"].includes(outcome)) {
      console.warn("mercado-pago-webhook", outcome);
    }
    return json({ accepted: true, outcome }, 200);
  } catch (error) {
    console.error("mercado-pago-webhook", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No pudimos procesar la notificación" }, 500);
  }
});