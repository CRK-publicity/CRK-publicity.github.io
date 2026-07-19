import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("no secret credentials are committed in frontend configuration", () => {
  const env = read(".env.example");
  assert.doesNotMatch(env, /service_role|META_ACCESS_TOKEN\s*=/);
  assert.match(env, /VITE_SUPABASE_PUBLISHABLE_KEY/);
});

test("database protects CRM tables with row level security", () => {
  const sql = read("supabase/migrations/202607130001_crm.sql");
  for (const table of ["profiles", "contacts", "conversations", "messages", "activities", "lead_requests"]) assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  assert.match(sql, /default 'pending'/);
  assert.doesNotMatch(sql, /policy .*lead_requests.* to anon/i);
});

test("Meta webhook verifies signatures and is idempotent", () => {
  const webhook = read("supabase/functions/whatsapp-webhook/index.ts");
  assert.match(webhook, /verifyMetaSignature/);
  assert.match(webhook, /provider_message_id/);
  assert.match(webhook, /ignoreDuplicates: true/);
  assert.match(webhook, /conversation\.status !== "bot"/);
});

test("public form includes consent, honeypot and WhatsApp", () => {
  const html = read("index.html");
  assert.match(html, /name="consent"/);
  assert.match(html, /name="website"/);
  assert.match(html, /name="phone"/);
});
test("frontend avoids HTML injection sinks and enforces a CSP", () => {
  const app = read("app.js");
  const main = read("index.html");
  const admin = read("admin/index.html");
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.match(main, /Content-Security-Policy/);
  assert.match(admin, /Content-Security-Policy/);
  assert.match(main, /privacidad/);
});

test("all static images declare dimensions", () => {
  for (const file of ["index.html", "admin/index.html", "privacidad/index.html", "pago/index.html"]) {
    const html = read(file);
    for (const tag of html.match(/<img\b[^>]*>/g) || []) {
      assert.match(tag, /\bwidth="\d+"/);
      assert.match(tag, /\bheight="\d+"/);
    }
  }
});

test("edge functions pin dependencies and bound untrusted requests", () => {
  const shared = read("supabase/functions/_shared/backend.ts");
  const lead = read("supabase/functions/public-lead/index.ts");
  const webhook = read("supabase/functions/whatsapp-webhook/index.ts");
  assert.match(shared, /supabase-js@2\.110\.3/);
  assert.match(shared, /AbortController/);
  assert.match(shared, /getReader/);
  assert.match(lead, /MAX_BODY_BYTES/);
  assert.match(lead, /check_lead_rate_limit/);
  assert.match(webhook, /MAX_WEBHOOK_BYTES/);
  assert.doesNotMatch(`${lead}${webhook}`, /request\.arrayBuffer/);
});

test("WhatsApp authorization verifies MFA with the authenticated Supabase client", () => {
  const shared = read("supabase/functions/_shared/backend.ts");
  const sender = read("supabase/functions/send-whatsapp/index.ts");
  assert.match(sender, /auth\.getUser\(accessToken\)/);
  assert.match(sender, /auth\.mfa\.getAuthenticatorAssuranceLevel\(\)/);
  assert.match(sender, /assurance\?\.currentLevel !== "aal2"/);
  assert.doesNotMatch(`${shared}${sender}`, /verifiedJwtPayload/);
});

test("database requires MFA and uses atomic lead rate limiting", () => {
  const sql = read("supabase/migrations/202607130002_security_hardening.sql");
  assert.match(sql, /as restrictive for all to authenticated/g);
  assert.match(sql, /auth\.jwt\(\) ->> 'aal'/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /force row level security/g);
});

test("cPanel package includes defensive HTTP headers", () => {
  const apache = read("public/.htaccess");
  for (const header of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Permissions-Policy", "Strict-Transport-Security", "Cross-Origin-Resource-Policy"]) assert.match(apache, new RegExp(header));
  assert.match(apache, /base-uri 'none'/);
  assert.match(apache, /frame-ancestors 'none'/);
  assert.match(apache, /upgrade-insecure-requests/);
  assert.match(apache, /ico\|mp4/);
});
test("CRM renders the complete lead request", () => {
  const html = read("admin/index.html");
  const admin = read("admin/admin.js");
  const lead = read("supabase/functions/public-lead/index.ts");
  for (const id of ["client-detail", "detail-company", "detail-email", "detail-whatsapp", "detail-need", "request-list"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(admin, /from\("activities"\)/);
  assert.match(admin, /renderClientDetails/);
  assert.match(admin, /setInterval/);
  assert.match(lead, /rpc\("ingest_public_lead"/);
});

test("public lead ingestion is atomic and restricted to the service role", () => {
  const lead = read("supabase/functions/public-lead/index.ts");
  const sql = read("supabase/migrations/202607150001_atomic_public_lead.sql");
  assert.match(lead, /rpc\("ingest_public_lead"/);
  assert.doesNotMatch(lead, /from\("contacts"\)/);
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /on conflict \(contact_id, channel\) do update/);
  assert.match(sql, /message_type, body, status/);
  assert.match(sql, /activity_type, summary, metadata/);
  assert.match(sql, /phone_e164 = p_phone and lower\(email\) = lower\(p_email\)/);
  assert.match(sql, /lead_identity_conflict/);
  assert.match(lead, /lead_identity_conflict/);
  assert.doesNotMatch(sql, /update public\.contacts\s+set[^;]*(?:full_name|phone_e164|email)\s*=/s);
  assert.match(sql, /revoke all on function public\.ingest_public_lead[^;]+from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.ingest_public_lead[^;]+to service_role/);
});
test("analytics counts visits and clicks privately", () => {
  const app = read("app.js");
  const admin = read("admin/admin.js");
  const html = read("admin/index.html");
  const analytics = read("supabase/functions/track-event/index.ts");
  const sql = read("supabase/migrations/202607130004_site_analytics.sql");
  assert.match(app, /trackSiteEvent\('visit'\)/);
  assert.match(app, /trackSiteEvent\('click'\)/);
  assert.match(analytics, /VALID_EVENTS/);
  assert.match(analytics, /sha256/);
  assert.match(sql, /record_site_event/);
  assert.match(sql, /current_clicks >= 100/);
  assert.match(sql, /force row level security/g);
  assert.match(admin, /analytics_daily/);
  assert.match(html, /id="metric-visits"/);
  assert.match(html, /id="metric-clicks"/);
});
test("hero uses the transparent 3D mascot, a three-second loop and one RGB logo", () => {
  const html = read("index.html");
  const css = read("styles.css");
  assert.match(html, /crk-mascot-thumbs-up-transparent\.webp/);
  assert.match(html, /class="hero-mascot"/);
  assert.equal((html.match(/class="hero-rgb-logo"/g) || []).length, 1);
  assert.match(html, /hero-rgb-logo[^]*crk-publicity-logo\.svg/);
  assert.match(css, /hero-mascot\{[^}]*animation:hero-mascot-3d-loop 3s/);
  assert.match(css, /hero-mascot\{[^}]*filter:none/);
  assert.doesNotMatch(css, /hero-photo-stage::after\{/);
  assert.match(css, /@keyframes hero-mascot-3d-loop/);
  assert.match(css, /hero-photo-stage\{[^}]*border:0[^}]*background:transparent[^}]*box-shadow:none[^}]*overflow:visible/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});
test("hero includes the second chart video with safe automatic looping", () => {
  const html = read("index.html");
  const css = read("styles.css");
  assert.match(html, /<video class="hero-chart-video" autoplay muted loop playsinline preload="metadata"/);
  assert.match(html, /assets\/video\/five-bar-chart\.mp4/);
  assert.match(html, /type="video\/mp4"/);
  assert.match(css, /hero-chart-video\{[^}]*object-fit:cover/);
});

test("public page defers non-critical work and media", () => {
  const html = read("index.html");
  const app = read("app.js");
  const css = read("styles.css");
  assert.match(app, /requestIdleCallback/);
  assert.match(app, /connection\?\.saveData/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /IntersectionObserver/);
  assert.match(html, /crk-contact-strip\.png"[^>]*loading="lazy"[^>]*decoding="async"/);
  assert.match(css, /content-visibility:auto/);
  for (const removed of ["hero-logo-stage", "hero-logo-mark", "product-art-cards", "product-art-neon", "product-art-wrap"]) assert.doesNotMatch(css, new RegExp(removed));
});

test("public CMS configuration fails closed and preserves the static page as fallback", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.match(html, /data-site-services/);
  assert.match(html, /data-site-gallery/);
  assert.match(html, /img-src 'self' data: https:\/\/wiyhambpgiqbnzwrsykd\.supabase\.co/);
  assert.match(app, /functions\/v1\/public-site-config/);
  assert.match(app, /CMS_PUBLIC_ASSET_ORIGIN/);
  assert.match(app, /object\\\/sign\\\/site-media/);
  assert.match(app, /replaceChildren/);
  assert.match(app, /cache: 'no-store'/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
});

test("CMS writes, publication and private media require an owner with MFA", () => {
  const schema = read("supabase/migrations/20260717142008_site_content_management.sql");
  const shared = read("supabase/functions/_shared/backend.ts");
  const admin = read("supabase/functions/site-admin/index.ts");
  const upload = read("supabase/functions/site-media-upload/index.ts");
  const publicConfig = read("supabase/functions/public-site-config/index.ts");
  const config = read("supabase/config.toml");
  const browserAdmin = read("admin/admin.js");
  for (const table of ["site_content", "site_services", "site_media", "payment_methods", "site_publications", "site_publication_state", "site_audit_events"]) {
    assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(schema, new RegExp(`alter table public\\.${table} force row level security`));
    assert.match(schema, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
  }
  assert.match(schema, /public = false/);
  assert.match(schema, /array\['image\/jpeg', 'image\/png', 'image\/webp'\]/);
  assert.match(schema, /publish_site_snapshot/);
  assert.match(schema, /revoke all on function public\.publish_site_snapshot[^;]+from public, anon, authenticated/);
  assert.match(schema, /grant execute on function public\.publish_site_snapshot[^;]+to service_role/);
  assert.match(shared, /requireCrmOwner/);
  assert.match(shared, /auth\.getUser\(accessToken\)/);
  assert.match(shared, /auth\.mfa\.getAuthenticatorAssuranceLevel\(accessToken\)/);
  assert.match(shared, /profile\?\.role !== "owner"/);
  assert.match(admin, /requireCrmOwner\(request\)/);
  assert.match(admin, /publish_site_snapshot/);
  assert.match(upload, /file instanceof File/);
  assert.match(upload, /stripJpegMetadata/);
  assert.match(upload, /MAX_UPLOAD_BYTES/);
  assert.match(publicConfig, /createSignedUrls/);
  assert.match(publicConfig, /STORAGE_PATH_PATTERN/);
  assert.match(browserAdmin, /functions\.invoke\("site-admin"/);
  assert.match(browserAdmin, /functions\.invoke\("site-media-upload"/);
  assert.doesNotMatch(`${admin}${upload}${browserAdmin}`, /\.innerHTML\s*=/);
  assert.match(config, /\[functions\.site-admin\][^]*verify_jwt = true/);
  assert.match(config, /\[functions\.site-media-upload\][^]*verify_jwt = true/);
  assert.match(config, /\[functions\.public-site-config\][^]*verify_jwt = false/);
});

test("closed quote panel cannot receive focus or create visible horizontal overflow", () => {
  const html = read("index.html");
  const app = read("app.js");
  const css = read("styles.css");
  assert.match(html, /id="quote-panel"[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(app, /panel\.inert = !open/);
  assert.match(css, /\.quote-panel\{visibility:hidden;pointer-events:none/);
  assert.match(css, /html\{overflow-x:clip\}/);
});

test("API responses fail closed with JSON security headers and strict CORS", () => {
  const shared = read("supabase/functions/_shared/backend.ts");
  assert.match(shared, /Content-Security-Policy/);
  assert.match(shared, /Cross-Origin-Resource-Policy/);
  assert.match(shared, /X-Frame-Options/);
  assert.match(shared, /x-client-info/);
  assert.match(shared, /x-retry-count/);
  assert.match(shared, /\.\.\.\(origin \? \{ "Access-Control-Allow-Origin": origin \} : \{\}\)/);
  assert.doesNotMatch(shared, /Access-Control-Allow-Origin": "\*"/);
});

test("Mercado Pago starter offer is integrated in services and links directly to payment", () => {
  const html = read("index.html");
  const payment = read("pago/index.html");
  assert.match(html, /<article class="service-card[^\"]*payment-starter[^\"]*"[^>]*>[\s\S]*?href="pago\/"[^>]*data-payment-product="web_starter"[^>]*>Agregar/);
  assert.match(html, /class="service-foot payment-starter-foot"[^>]*>[\s\S]*?href="pago\/"/);
  assert.doesNotMatch(html, /data-service="[^"]*"[^>]*data-payment-product="web_starter"/);
  assert.doesNotMatch(html, /payment-starter-action|payment-starter-copy/);
  assert.match(html, /\$200\.000 COP/);
  assert.match(html, /Dominio, hosting e integraciones avanzadas/);
  assert.match(payment, /Página web inicial/);
  assert.match(payment, /\$200\.000/);
  assert.match(payment, /Mercado Pago/);
});

test("payment frontend redirects only to trusted Mercado Pago HTTPS URLs", () => {
  const script = read("pago/payment.js");
  const page = read("pago/index.html");
  assert.match(script, /productCode: "web_starter"/);
  assert.match(script, /clientRequestId/);
  assert.match(script, /window\.location\.assign/);
  assert.match(script, /url\.protocol === "https:"/);
  assert.match(script, /trustedCheckoutHosts\.has\(url\.hostname\)/);
  assert.match(script, /"www\.mercadopago\.com"/);
  assert.match(script, /"sandbox\.mercadopago\.com"/);
  assert.doesNotMatch(script, /hostname\.endsWith/);
  assert.doesNotMatch(script, /unit_price|MERCADO_PAGO_ACCESS_TOKEN|MERCADO_PAGO_WEBHOOK_SECRET/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.match(page, /noindex,nofollow/);
  assert.match(page, /Content-Security-Policy/);
  assert.match(page, /<form id="payment-form" method="post"/);
  assert.match(page, /type="submit" disabled/);
  assert.match(page, /aria-live="polite" aria-atomic="true"/);
});

test("payment return page verifies server state and ignores browser result parameters", () => {
  const script = read("pago/payment.js");
  assert.match(script, /postFunction\("payment-status", \{ orderId \}/);
  assert.match(script, /get\("order"\)/);
  assert.doesNotMatch(script, /get\("result"\)|get\("status"\)/);
  assert.match(script, /attempt < 6/);
  assert.match(script, /textContent/);
});

test("Mercado Pago catalog prices and idempotency are enforced server-side", () => {
  const createPayment = read("supabase/functions/create-payment/index.ts");
  const paymentClient = read("pago/payment.js");
  const status = read("supabase/functions/payment-status/index.ts");
  const originalSql = read("supabase/migrations/202607160001_mercado_pago.sql");
  const catalogSql = read("supabase/migrations/20260717143308_payment_catalog_checkout.sql");
  const publishedCatalogSql = read("supabase/migrations/20260717150711_published_catalog_checkout_integrity.sql");
  assert.doesNotMatch(createPayment, /from\("site_services"\)/);
  assert.doesNotMatch(createPayment, /from\("payment_methods"\)/);
  assert.match(createPayment, /p_service_reference: serviceReference/);
  assert.match(createPayment, /p_payment_mode: useSandbox \? "test" : "live"/);
  assert.match(createPayment, /unit_price: orderAmount/);
  assert.match(paymentClient, /serviceId: activeProduct\.serviceId \|\| undefined/);
  assert.doesNotMatch(createPayment, /payload\.(?:price|amount|currency)/);
  assert.match(createPayment, /check_payment_rate_limit/);
  assert.match(createPayment, /create_payment_order/);
  assert.match(createPayment, /claim_payment_preference/);
  assert.match(createPayment, /p_scope_accepted: true/);
  assert.match(createPayment, /p_privacy_accepted: true/);
  assert.match(status, /select\("title,amount_cop,currency,status"\)/);
  assert.match(catalogSql, /add column if not exists service_id uuid references public\.site_services/);
  assert.match(catalogSql, /p_service_id uuid/);
  assert.match(publishedCatalogSql, /site_services_checkout_product_code_unique_idx/);
  assert.match(publishedCatalogSql, /site_publication_state/);
  assert.match(publishedCatalogSql, /jsonb_array_elements\(coalesce\(v_snapshot -> 'services'/);
  assert.match(publishedCatalogSql, /payment_service_unavailable/);
  assert.match(publishedCatalogSql, /payment_method_unavailable/);
  assert.match(publishedCatalogSql, /site_publication_id/);
  assert.match(publishedCatalogSql, /description text/);
  assert.match(originalSql, /public_token uuid not null unique/);
  assert.match(originalSql, /provider_event_key text not null unique/);
  assert.match(originalSql, /accepted_at timestamptz not null/);
  assert.match(originalSql, /and status = 'processing'/);
  assert.match(originalSql, /on delete restrict/);
  assert.match(originalSql, /force row level security/g);
  assert.doesNotMatch(createPayment, /X-Idempotency-Key/i);
});

test("Mercado Pago webhook authenticates and revalidates every payment", () => {
  const webhook = read("supabase/functions/mercado-pago-webhook/index.ts");
  const shared = read("supabase/functions/_shared/backend.ts");
  const sql = read("supabase/migrations/202607160001_mercado_pago.sql");
  assert.match(webhook, /x-signature/);
  assert.match(webhook, /x-request-id/);
  assert.match(webhook, /searchParams\.get\("data\.id"\)/);
  assert.match(webhook, /id:" \+ dataId \+ ";request-id:"/);
  assert.match(webhook, /hmacSha256/);
  assert.match(shared, /export async function hmacSha256/);
  assert.match(webhook, /api\.mercadopago\.com\/v1\/payments\//);
  assert.match(webhook, /paymentId !== dataId/);
  assert.match(webhook, /p_amount_cop: amount/);
  assert.match(webhook, /p_refunded_amount_cop: refundedAmount/);
  assert.match(webhook, /p_currency: currency/);
  assert.match(webhook, /p_collector_id: collectorId/);
  assert.match(webhook, /apply_mercado_pago_payment/);
  assert.match(webhook, /eventKey = "mp:" \+ await sha256\(manifest\)/);
  assert.match(webhook, /liveMode !== expectLiveMode/);
  assert.match(webhook, /return null/);
  assert.match(sql, /amount_mismatch/);
  assert.match(sql, /collector_mismatch/);
  assert.match(sql, /duplicate_payment/);
  assert.match(sql, /unsupported_status/);
  assert.match(sql, /refunded_amount_cop bigint not null/);
  assert.match(sql, /possible pago duplicado|posible pago duplicado/);
  assert.match(sql, /v_order\.status = 'approved'/);
});

test("Mercado Pago secrets stay in Edge Functions and functions are public-gateway configured", () => {
  const env = read(".env.example");
  const frontend = read("index.html") + read("pago/index.html") + read("pago/payment.js");
  const config = read("supabase/config.toml");
  assert.doesNotMatch(env + frontend, /MERCADO_PAGO_ACCESS_TOKEN|MERCADO_PAGO_WEBHOOK_SECRET/);
  for (const name of ["create-payment", "payment-status", "mercado-pago-webhook"]) {
    assert.match(config, new RegExp("\\[functions\\." + name.replace("-", "\\-") + "\\][^]*verify_jwt = false"));
  }
});

test("CRM recognizes payment activities without exposing provider payloads", () => {
  const admin = read("admin/admin.js");
  const sql = read("supabase/migrations/202607160001_mercado_pago.sql");
  assert.match(admin, /payment_created/);
  assert.match(admin, /payment_approved/);
  assert.match(admin, /payment: "Pago web"/);
  assert.match(sql, /payload_hash text not null/);
  assert.doesNotMatch(sql, /card_number|security_code|document_number/);
});
test("payment identity remains bound to both normalized contact identifiers", () => {
  const sql = read("supabase/migrations/20260717150711_published_catalog_checkout_integrity.sql");
  const createOrder = sql.slice(sql.indexOf("create function public.create_payment_order"));
  assert.match(createOrder, /c\.phone_e164 = p_phone and lower\(c\.email\) = lower\(p_email\)/);
  assert.match(createOrder, /payment_identity_conflict/);
  assert.match(createOrder, /p_scope_version not in/);
  assert.match(createOrder, /lower\(coalesce\(v_contact_email, ''\)\) <> lower\(p_email\)/);
  assert.match(createOrder, /v_existing_service_id::text is distinct from lower\(p_service_reference\)/);
  assert.doesNotMatch(createOrder, /update public\.contacts\s+set[^;]*(?:full_name|phone_e164|email)\s*=/s);
});

test("payment consent, privacy disclosure and storage fallback are explicit", () => {
  const page = read("pago/index.html");
  const script = read("pago/payment.js");
  const privacy = read("privacidad/index.html");
  assert.match(page, /id="purchase-conditions"/);
  assert.match(page, /condiciones de cancelación o devolución/);
  assert.match(script, /scopeVersion: acceptanceVersions\.scope/);
  assert.match(script, /privacyVersion: acceptanceVersions\.privacy/);
  assert.match(script, /sessionStorage\.removeItem\(requestStorageKey\)/);
  assert.match(script, /requestStorageKey = "crkPaymentRequestId:"/);
  assert.match(script, /let volatileRequestId = ""/);
  assert.match(script, /error\.code === "identity_conflict"/);
  const clearBlock = script.slice(script.indexOf("function clearRequestId"), script.indexOf("function validateField"));
  assert.doesNotMatch(clearBlock, /clearRequestId\(\);/);
  assert.match(privacy, /Mercado Pago recibe los datos necesarios/);
  assert.match(privacy, /no recibimos ni almacenamos los datos de tu tarjeta/);
});

test("build output uses portable relative asset paths", () => {
  const config = read("vite.config.js");
  assert.match(config, /base: ['"]\.\/['"]/);
  assert.doesNotMatch(config, /base: ['"]\/crkpublicity\/['"]/);
});

test("raffles use atomic reservations, private files and owner-only administration", () => {
  const sql = read("supabase/migrations/20260719022558_raffles_and_participants.sql");
  const publicFunction = read("supabase/functions/raffle-public/index.ts");
  const adminFunction = read("supabase/functions/raffle-admin/index.ts");
  const page = read("sorteos/index.html");
  assert.match(sql, /create table public\.raffle_numbers/);
  assert.match(sql, /generate_series\(0, 99\)/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /release_expired_raffle_reservations/);
  assert.match(sql, /public = false/);
  assert.match(sql, /revoke all on public\.raffles/);
  assert.match(publicFunction, /finalize_raffle_participation/);
  assert.match(publicFunction, /consent !== true/);
  assert.match(publicFunction, /pending_validation/);
  assert.match(adminFunction, /requireCrmOwner/);
  assert.match(adminFunction, /payment_status:"approved"/);
  assert.match(page, /Sorteos y Premios/);
});

test("storefront actions remain readable and use valid UTF-8", () => {
  const page = read("index.html");
  const script = read("app.js");
  const styles = read("styles.css");
  for (const source of [page, script, styles]) assert.doesNotMatch(source, /[ÃÂâ]/);
  assert.match(script, /Agregar a cotización/);
  assert.match(page, /Ver mi cotización/);
  assert.match(styles, /\.product-actions\{display:grid;grid-template-columns:1fr;/);
  assert.match(styles, /\.catalog-add,\.product-quote-link\{width:100%;/);
});
