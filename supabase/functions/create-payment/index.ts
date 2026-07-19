import { adminClient, allowedOrigin, cleanText, corsHeaders, json, normalizePhone, readBodyLimited, sha256 } from "../_shared/backend.ts";

const MAX_BODY_BYTES = 8_192;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_CODE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const PRODUCTION_CHECKOUT_HOSTS = new Set(["www.mercadopago.com", "www.mercadopago.com.co"]);
const SANDBOX_CHECKOUT_HOSTS = new Set(["sandbox.mercadopago.com", "sandbox.mercadopago.com.co"]);
const ACCEPTANCE = Object.freeze({
  scope: "site-checkout-2026-07-17-v1",
  privacy: "privacy-2026-07-16-v1",
});

function trustedCheckoutUrl(value: unknown, useSandbox: boolean) {
  try {
    const url = new URL(String(value || ""));
    const safeAuthority = !url.username && !url.password && !url.port;
    const hosts = useSandbox ? SANDBOX_CHECKOUT_HOSTS : PRODUCTION_CHECKOUT_HOSTS;
    return url.protocol === "https:" && hosts.has(url.hostname) && safeAuthority ? url.href : "";
  } catch {
    return "";
  }
}

function configuredSiteUrl() {
  const raw = Deno.env.get("PUBLIC_SITE_URL") || "";
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Public site URL is invalid");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: cors }) : json({ error: "Origen no permitido" }, 403);
  if (request.method !== "POST") return json({ error: "Método no permitido" }, 405, cors);
  if (!origin) return json({ error: "Origen no permitido" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Tipo de contenido no permitido" }, 415, cors);

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: "Solicitud demasiado grande" }, 413, cors);

  const accessToken = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN") || "";
  const modeValue = Deno.env.get("MERCADO_PAGO_USE_SANDBOX") || "";
  const salt = Deno.env.get("IP_HASH_SALT") || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  if (!accessToken || !["true", "false"].includes(modeValue) || salt.length < 32 || !supabaseUrl.startsWith("https://")) {
    return json({ error: "El pago está en proceso de activación. Escríbenos por WhatsApp." }, 503, cors);
  }

  const useSandbox = modeValue === "true";
  const client = adminClient();
  let orderId = "";

  try {
    const siteUrl = configuredSiteUrl();
    const bytes = await readBodyLimited(request, MAX_BODY_BYTES);
    if (!bytes) return json({ error: "Solicitud demasiado grande" }, 413, cors);
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || Array.isArray(payload) || typeof payload !== "object") return json({ error: "Solicitud inválida" }, 400, cors);
    if (cleanText(payload.website, 200)) return json({ accepted: true }, 202, cors);

    const productCode = cleanText(payload.productCode, 80);
    const serviceId = cleanText(payload.serviceId, 36);
    const clientRequestId = cleanText(payload.clientRequestId, 36);
    const name = cleanText(payload.name, 100);
    const email = cleanText(payload.email, 180).toLowerCase();
    const phone = normalizePhone(String(payload.phone || ""));

    if ((!UUID_V4.test(serviceId) && !PRODUCT_CODE.test(productCode)) || !UUID_V4.test(clientRequestId) || name.length < 2 || !phone
      || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
      || payload.scopeAccepted !== true || payload.privacyAccepted !== true
      || cleanText(payload.scopeVersion, 80) !== ACCEPTANCE.scope
      || cleanText(payload.privacyVersion, 80) !== ACCEPTANCE.privacy) {
      return json({ error: "Revisa los datos de la compra" }, 422, cors);
    }

    const ip = (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim().slice(0, 64);
    const fingerprint = await sha256(salt + ":payment-create:" + ip);
    const rateResult = await client.rpc("check_payment_rate_limit", {
      p_fingerprint: fingerprint,
      p_request_kind: "create",
      p_public_token: clientRequestId,
    });
    if (rateResult.error) throw rateResult.error;
    if (rateResult.data !== true) return json({ error: "Espera unos minutos antes de volver a intentarlo." }, 429, cors);

    const serviceReference = UUID_V4.test(serviceId) ? serviceId : productCode;

    const orderResult = await client.rpc("create_payment_order", {
      p_public_token: clientRequestId,
      p_name: name,
      p_email: email,
      p_phone: phone,
      p_service_reference: serviceReference,
      p_payment_mode: useSandbox ? "test" : "live",
      p_scope_accepted: true,
      p_privacy_accepted: true,
      p_scope_version: ACCEPTANCE.scope,
      p_privacy_version: ACCEPTANCE.privacy,
    });
    if (orderResult.error) {
      if (String(orderResult.error.message || "").includes("payment_identity_conflict")) {
        return json({ error: "Los datos no coinciden con este intento de pago. Inicia uno nuevo.", code: "identity_conflict" }, 409, cors);
      }
      if (String(orderResult.error.message || "").includes("payment_service_unavailable")) {
        return json({ error: "Este servicio no está disponible para pago en línea." }, 422, cors);
      }
      if (String(orderResult.error.message || "").includes("payment_method_unavailable")) {
        return json({ error: "El pago está en proceso de activación. Escríbenos por WhatsApp." }, 503, cors);
      }
      throw orderResult.error;
    }
    const order = Array.isArray(orderResult.data) ? orderResult.data[0] : null;
    if (!order) throw new Error("Order transaction returned invalid data");
    orderId = String(order.order_id || "");
    const orderProductCode = cleanText(order.product_code, 80);
    const orderTitle = cleanText(order.title, 160);
    const orderDescription = cleanText(order.description, 1_000);
    const orderAmount = Number(order.amount_cop);
    if (!UUID_V4.test(orderId) || !PRODUCT_CODE.test(orderProductCode) || !orderTitle || !orderDescription
      || !Number.isSafeInteger(orderAmount) || orderAmount < 1_000 || order.currency !== "COP") {
      throw new Error("Order transaction returned an invalid product snapshot");
    }

    const existingUrl = trustedCheckoutUrl(order.checkout_url, useSandbox);
    if (order.status === "checkout_ready" && existingUrl) {
      return json({ checkoutUrl: existingUrl, orderId: order.order_public_token }, 200, cors);
    }
    if (["approved", "refunded", "charged_back"].includes(String(order.status))) {
      return json({ error: "Esta orden ya fue procesada." }, 409, cors);
    }

    const claim = await client.rpc("claim_payment_preference", { p_order_id: orderId });
    const claimState = Array.isArray(claim.data) ? claim.data[0] : null;
    if (claim.error || !claimState) throw claim.error || new Error("Preference claim returned invalid data");
    const claimedUrl = trustedCheckoutUrl(claimState.existing_checkout_url, useSandbox);
    if (!claimState.claimed && claimState.current_status === "checkout_ready" && claimedUrl) {
      return json({ checkoutUrl: claimedUrl, orderId: order.order_public_token }, 200, cors);
    }
    if (!claimState.claimed) return json({ error: "El pago se está preparando. Inténtalo de nuevo en unos segundos." }, 409, cors);

    const paymentPage = new URL("pago/", siteUrl);
    const successUrl = new URL(paymentPage);
    const pendingUrl = new URL(paymentPage);
    const failureUrl = new URL(paymentPage);
    successUrl.searchParams.set("result", "success");
    pendingUrl.searchParams.set("result", "pending");
    failureUrl.searchParams.set("result", "failure");
    for (const url of [successUrl, pendingUrl, failureUrl]) url.searchParams.set("order", String(order.order_public_token));

    const notificationUrl = new URL("/functions/v1/mercado-pago-webhook", supabaseUrl);
    notificationUrl.searchParams.set("source_news", "webhooks");

    const preference = {
      items: [{
        id: orderProductCode,
        title: orderTitle,
        description: orderDescription,
        quantity: 1,
        currency_id: String(order.currency),
        unit_price: orderAmount,
      }],
      payer: { email },
      external_reference: String(order.external_reference),
      back_urls: {
        success: successUrl.href,
        pending: pendingUrl.href,
        failure: failureUrl.href,
      },
      auto_return: "approved",
      notification_url: notificationUrl.href,
      metadata: {
        order_token: String(order.order_public_token),
        product_code: orderProductCode,
        service_id: String(order.service_id),
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(preference),
      });
    } finally {
      clearTimeout(timeout);
    }

    const preferenceData = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("Mercado Pago rejected the preference with status " + response.status);

    const checkoutUrl = trustedCheckoutUrl(useSandbox ? preferenceData.sandbox_init_point : preferenceData.init_point, useSandbox);
    const preferenceId = cleanText(preferenceData.id, 120);
    const collectorId = cleanText(preferenceData.collector_id, 30);
    if (!checkoutUrl || preferenceId.length < 5 || !/^[0-9]{1,30}$/.test(collectorId)) throw new Error("Mercado Pago returned invalid preference data");

    const saveResult = await client.rpc("set_payment_preference", {
      p_order_id: orderId,
      p_preference_id: preferenceId,
      p_collector_id: collectorId,
      p_checkout_url: checkoutUrl,
    });
    if (saveResult.error) throw saveResult.error;
    if (saveResult.data !== true) {
      const latest = await client.from("payment_orders")
        .select("status,checkout_url,public_token")
        .eq("id", orderId)
        .maybeSingle();
      if (latest.error) throw latest.error;
      const latestUrl = trustedCheckoutUrl(latest.data?.checkout_url, useSandbox);
      if (latest.data?.status === "checkout_ready" && latestUrl) {
        return json({ checkoutUrl: latestUrl, orderId: latest.data.public_token }, 200, cors);
      }
      if (["approved", "refunded", "charged_back"].includes(String(latest.data?.status))) {
        return json({ error: "Esta orden ya fue procesada." }, 409, cors);
      }
      throw new Error("Preference could not be stored");
    }

    return json({ checkoutUrl, orderId: order.order_public_token }, 201, cors);
  } catch (error) {
    if (orderId) {
      await client.from("payment_orders").update({ status: "error" }).eq("id", orderId).eq("status", "processing");
    }
    console.error("create-payment", error instanceof Error ? error.message : "unknown error");
    return json({ error: "No pudimos iniciar el pago. Escríbenos por WhatsApp." }, 502, cors);
  }
});
