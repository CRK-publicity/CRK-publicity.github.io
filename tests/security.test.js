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
  for (const file of ["index.html", "admin/index.html", "privacidad/index.html"]) {
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

test("database requires MFA and uses atomic lead rate limiting", () => {
  const sql = read("supabase/migrations/202607130002_security_hardening.sql");
  assert.match(sql, /as restrictive for all to authenticated/g);
  assert.match(sql, /auth\.jwt\(\) ->> 'aal'/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /force row level security/g);
});

test("cPanel package includes defensive HTTP headers", () => {
  const apache = read("public/.htaccess");
  for (const header of ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Permissions-Policy", "Strict-Transport-Security"]) assert.match(apache, new RegExp(header));
});
test("CRM renders the complete lead request", () => {
  const html = read("admin/index.html");
  const admin = read("admin/admin.js");
  const lead = read("supabase/functions/public-lead/index.ts");
  for (const id of ["client-detail", "detail-company", "detail-email", "detail-whatsapp", "detail-need", "request-list"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(admin, /from\("activities"\)/);
  assert.match(admin, /renderClientDetails/);
  assert.match(lead, /message_type: "lead_form"/);
  assert.match(lead, /metadata: \{ company, email, phone, consent_at: now/);
});
