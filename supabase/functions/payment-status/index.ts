import { adminClient, allowedOrigin, cleanText, corsHeaders, json, readBodyLimited, sha256 } from "../_shared/backend.ts";

const MAX_BODY_BYTES = 2_048;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST") return json({ error: "Método no permitido" }, 405, cors);
  if (!origin) return json({ error: "Origen no permitido" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Tipo de contenido no permitido" }, 415, cors);

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Solicitud demasiado grande" }, 413, cors);

  try {
    const bytes = await readBodyLimited(request, MAX_BODY_BYTES);
    if (!bytes) return json({ error: "Solicitud demasiado grande" }, 413, cors);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    const orderId = cleanText(payload?.orderId, 36);
    if (!UUID_V4.test(orderId)) return json({ error: "Orden inválida" }, 422, cors);

    const salt = Deno.env.get("IP_HASH_SALT") || "";
    if (salt.length < 32) throw new Error("Payment status configuration is incomplete");
    const ip = (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim().slice(0, 64);
    const fingerprint = await sha256(salt + ":payment-status:" + ip);
    const client = adminClient();
    const rateResult = await client.rpc("check_payment_rate_limit", {
      p_fingerprint: fingerprint,
      p_request_kind: "status",
      p_public_token: orderId,
    });
    if (rateResult.error) throw rateResult.error;
    if (rateResult.data !== true) return json({ error: "Demasiadas consultas. Inténtalo más tarde." }, 429, cors);

    const orderResult = await client
      .from("payment_orders")
      .select("title,amount_cop,currency,status")
      .eq("public_token", orderId)
      .maybeSingle();
    if (orderResult.error) throw orderResult.error;
    if (!orderResult.data) return json({ error: "Orden no encontrada" }, 404, cors);

    return json({
      status: orderResult.data.status,
      title: orderResult.data.title,
      amount: orderResult.data.amount_cop,
      currency: orderResult.data.currency,
    }, 200, cors);
  } catch (error) {
    console.error("payment-status", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No pudimos verificar el pago." }, 500, cors);
  }
});