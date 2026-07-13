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