-- Owner-managed CMS configuration for the public CRK site.
-- The browser must use authenticated Edge Functions for writes.  No CMS table is
-- exposed to anon/authenticated Data API roles, and published media stays private.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.is_short_text_array(
  p_value jsonb,
  p_max_items integer,
  p_max_item_length integer
)
returns boolean
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case
    when jsonb_typeof(p_value) <> 'array' then false
    when jsonb_array_length(p_value) > p_max_items then false
    else not exists (
      select 1
      from jsonb_array_elements(p_value) as item(value)
      where jsonb_typeof(item.value) <> 'string'
         or char_length(item.value #>> '{}') not between 1 and p_max_item_length
    )
  end;
$$;

create or replace function private.is_valid_public_snapshot(p_snapshot jsonb)
returns boolean
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case
    when jsonb_typeof(p_snapshot) <> 'object' then false
    when not (p_snapshot ? 'schema_version'
              and p_snapshot ? 'content'
              and p_snapshot ? 'services'
              and p_snapshot ? 'media'
              and p_snapshot ? 'payment_methods') then false
    when jsonb_typeof(p_snapshot -> 'content') <> 'object' then false
    when jsonb_typeof(p_snapshot -> 'services') <> 'array' then false
    when jsonb_typeof(p_snapshot -> 'media') <> 'array' then false
    when jsonb_typeof(p_snapshot -> 'payment_methods') <> 'array' then false
    when octet_length(convert_to(p_snapshot::text, 'UTF8')) > 524288 then false
    -- Keep credentials and privileged configuration out of anything that may be
    -- returned by the public site configuration endpoint.
    when p_snapshot::text ~* '"(access_token|api_key|secret|password|private_key|client_secret)"[[:space:]]*:' then false
    else true
  end;
$$;

create table if not exists public.site_content (
  content_key text primary key check (content_key in ('site', 'hero', 'contact', 'footer')),
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object'
    and octet_length(convert_to(payload::text, 'UTF8')) <= 16384
  ),
  version integer not null default 1 check (version between 1 and 2147483647),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(user_id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(user_id) on delete set null default auth.uid()
);

create table if not exists public.site_services (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (
    char_length(slug) between 2 and 80
    and slug = lower(slug)
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  title text not null check (char_length(title) between 2 and 120),
  description text not null check (char_length(description) between 2 and 1200),
  features jsonb not null default '[]'::jsonb check (private.is_short_text_array(features, 12, 160)),
  price_cop bigint check (price_cop is null or price_cop between 0 and 10000000000),
  currency text not null default 'COP' check (currency = 'COP'),
  cta_type text not null default 'quote' check (cta_type in ('quote', 'checkout', 'link')),
  checkout_product_code text check (
    checkout_product_code is null
    or (char_length(checkout_product_code) between 2 and 80
        and checkout_product_code = lower(checkout_product_code)
        and checkout_product_code ~ '^[a-z0-9]+(_[a-z0-9]+)*$')
  ),
  cta_url text check (
    cta_url is null
    or (char_length(cta_url) <= 2048
        and cta_url ~* '^https://[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?(/|$)')
  ),
  sort_order smallint not null default 0 check (sort_order between 0 and 9999),
  published boolean not null default false,
  version integer not null default 1 check (version between 1 and 2147483647),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(user_id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(user_id) on delete set null default auth.uid(),
  check (
    (cta_type = 'quote' and checkout_product_code is null and cta_url is null)
    or (cta_type = 'checkout' and checkout_product_code is not null and cta_url is null)
    or (cta_type = 'link' and checkout_product_code is null and cta_url is not null)
  )
);

create table if not exists public.site_media (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 120),
  storage_path text not null unique check (
    char_length(storage_path) between 74 and 260
    and storage_path = lower(storage_path)
    and storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$'
  ),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  width integer,
  height integer,
  alt_text text not null check (char_length(alt_text) between 2 and 240),
  section text not null check (
    char_length(section) between 2 and 32
    and section = lower(section)
    and section ~ '^[a-z][a-z0-9_-]*$'
  ),
  sort_order smallint not null default 0 check (sort_order between 0 and 9999),
  published boolean not null default false,
  version integer not null default 1 check (version between 1 and 2147483647),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(user_id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(user_id) on delete set null default auth.uid(),
  check (
    (width is null and height is null)
    or (width between 1 and 20000 and height between 1 and 20000)
  )
);

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (
    char_length(code) between 2 and 80
    and code = lower(code)
    and code ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
  ),
  label text not null check (char_length(label) between 2 and 100),
  provider text not null check (provider in ('mercado_pago', 'bank_transfer', 'whatsapp', 'external')),
  mode text not null default 'live' check (mode in ('test', 'live')),
  enabled boolean not null default false,
  checkout_url text check (
    checkout_url is null
    or (char_length(checkout_url) <= 2048
        and checkout_url ~* '^https://[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?(/|$)')
  ),
  instructions text check (instructions is null or char_length(instructions) between 2 and 2000),
  sort_order smallint not null default 0 check (sort_order between 0 and 9999),
  version integer not null default 1 check (version between 1 and 2147483647),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(user_id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(user_id) on delete set null default auth.uid(),
  check (
    provider <> 'external'
    or checkout_url is not null
  )
);

create table if not exists public.site_publications (
  id uuid primary key default gen_random_uuid(),
  snapshot jsonb not null check (private.is_valid_public_snapshot(snapshot)),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  published_by uuid references public.profiles(user_id) on delete set null,
  published_at timestamptz not null default now()
);

create table if not exists public.site_publication_state (
  id boolean primary key default true check (id is true),
  active_publication_id uuid references public.site_publications(id) on delete restrict
);

create table if not exists public.site_audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid references public.profiles(user_id) on delete set null,
  action text not null check (action in ('insert', 'update', 'delete')),
  entity_type text not null check (entity_type in (
    'site_content', 'site_services', 'site_media', 'payment_methods',
    'site_publications', 'site_publication_state'
  )),
  entity_id text not null check (char_length(entity_id) between 1 and 160),
  before_data jsonb,
  after_data jsonb,
  check (before_data is null or jsonb_typeof(before_data) = 'object'),
  check (after_data is null or jsonb_typeof(after_data) = 'object'),
  check (octet_length(convert_to(coalesce(before_data, '{}'::jsonb)::text, 'UTF8')) <= 1048576),
  check (octet_length(convert_to(coalesce(after_data, '{}'::jsonb)::text, 'UTF8')) <= 1048576)
);

create index if not exists site_services_public_idx
  on public.site_services(published, sort_order, updated_at desc);
create index if not exists site_media_public_idx
  on public.site_media(published, section, sort_order, updated_at desc);
create index if not exists payment_methods_enabled_idx
  on public.payment_methods(enabled, sort_order, updated_at desc);
create index if not exists site_audit_events_entity_idx
  on public.site_audit_events(entity_type, entity_id, occurred_at desc);
create index if not exists site_audit_events_actor_idx
  on public.site_audit_events(actor_id, occurred_at desc) where actor_id is not null;

-- Trusted seed content preserves the present static site as the initial CMS state.
insert into public.site_content (content_key, payload)
values
  ('hero', jsonb_build_object(
    'eyebrow', 'Diseño, producción y estrategia digital',
    'title', 'Tu negocio ya es bueno.',
    'highlight', 'Hagamos que se note.',
    'description', 'Creamos tu web, tu identidad y piezas impresas; además organizamos tus clientes y el seguimiento para que puedas vender más.',
    'primaryLabel', 'Ver productos',
    'primaryUrl', '#productos',
    'secondaryLabel', 'Ver trabajos',
    'secondaryUrl', '#trabajos'
  )),
  ('contact', jsonb_build_object(
    'eyebrow', 'Hablemos de tu negocio',
    'title', 'Cuéntanos dónde estás. Te mostramos el siguiente paso.',
    'description', 'Respondemos en un día hábil. Sin presión y sin compromisos.'
  ))
on conflict (content_key) do nothing;

insert into public.site_services (
  slug, title, description, features, price_cop, cta_type, checkout_product_code, sort_order, published
)
values
  (
    'presencia-que-convierte',
    'Presencia que convierte',
    'Un sitio de captación a medida, con estrategia, contenido y recorrido comercial diseñados para tu negocio.',
    '["Arquitectura y contenido estratégico", "Diseño personalizado", "CRM, analítica y SEO local"]'::jsonb,
    1200000, 'quote', null, 10, true
  ),
  (
    'clientes-bien-organizados',
    'Clientes bien organizados',
    'Configuramos tu CRM para que sepas quién preguntó, qué necesita y cuándo debes contactarlo.',
    '["Contactos y propiedades", "Pipeline comercial", "Dashboard de ventas"]'::jsonb,
    850000, 'quote', null, 20, true
  ),
  (
    'seguimiento-automatico',
    'Seguimiento automático',
    'Conecta formularios, respuestas y tareas para que ningún prospecto quede olvidado.',
    '["Integración web–CRM", "Correo de respuesta", "Alertas de seguimiento"]'::jsonb,
    650000, 'quote', null, 30, true
  ),
  (
    'pagina-web-inicial',
    'Página web inicial',
    'Una landing esencial de una página, basada en una estructura prediseñada y personalizada con tu marca.',
    '["Una página responsive", "Colores, logo, formulario y WhatsApp", "SEO local esencial"]'::jsonb,
    200000, 'checkout', 'web_starter', 40, true
  )
on conflict (slug) do nothing;

insert into public.payment_methods (code, label, provider, mode, enabled, sort_order)
values ('mercado_pago', 'Mercado Pago', 'mercado_pago', 'live', false, 10)
on conflict (code) do nothing;

insert into public.site_publication_state (id, active_publication_id)
values (true, null)
on conflict (id) do nothing;

create or replace function private.bump_site_record_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.version := old.version + 1;
    new.updated_at := clock_timestamp();
    if new.updated_by is null then
      new.updated_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.log_site_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_actor_text text;
  v_actor uuid;
  v_entity_id text;
begin
  if tg_op = 'INSERT' then
    v_after := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
  else
    v_before := to_jsonb(old);
  end if;

  v_entity_id := coalesce(
    v_after ->> 'id',
    v_before ->> 'id',
    v_after ->> 'content_key',
    v_before ->> 'content_key'
  );

  v_actor_text := coalesce(
    nullif(v_after ->> 'updated_by', ''),
    nullif(v_after ->> 'created_by', ''),
    nullif(v_after ->> 'published_by', ''),
    nullif(v_before ->> 'updated_by', ''),
    nullif(v_before ->> 'created_by', ''),
    nullif(v_before ->> 'published_by', ''),
    auth.uid()::text
  );

  if v_actor_text is not null then
    v_actor := v_actor_text::uuid;
  end if;

  insert into public.site_audit_events (
    actor_id, action, entity_type, entity_id, before_data, after_data
  )
  values (
    v_actor, lower(tg_op), tg_table_name, v_entity_id, v_before, v_after
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.is_short_text_array(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function private.is_valid_public_snapshot(jsonb) from public, anon, authenticated;
revoke all on function private.bump_site_record_version() from public, anon, authenticated;
revoke all on function private.log_site_audit() from public, anon, authenticated;

drop trigger if exists site_content_set_version on public.site_content;
create trigger site_content_set_version
before update on public.site_content
for each row execute procedure private.bump_site_record_version();
drop trigger if exists site_services_set_version on public.site_services;
create trigger site_services_set_version
before update on public.site_services
for each row execute procedure private.bump_site_record_version();
drop trigger if exists site_media_set_version on public.site_media;
create trigger site_media_set_version
before update on public.site_media
for each row execute procedure private.bump_site_record_version();
drop trigger if exists payment_methods_set_version on public.payment_methods;
create trigger payment_methods_set_version
before update on public.payment_methods
for each row execute procedure private.bump_site_record_version();

drop trigger if exists site_content_audit on public.site_content;
create trigger site_content_audit
after insert or update or delete on public.site_content
for each row execute procedure private.log_site_audit();
drop trigger if exists site_services_audit on public.site_services;
create trigger site_services_audit
after insert or update or delete on public.site_services
for each row execute procedure private.log_site_audit();
drop trigger if exists site_media_audit on public.site_media;
create trigger site_media_audit
after insert or update or delete on public.site_media
for each row execute procedure private.log_site_audit();
drop trigger if exists payment_methods_audit on public.payment_methods;
create trigger payment_methods_audit
after insert or update or delete on public.payment_methods
for each row execute procedure private.log_site_audit();
drop trigger if exists site_publications_audit on public.site_publications;
create trigger site_publications_audit
after insert or update or delete on public.site_publications
for each row execute procedure private.log_site_audit();
drop trigger if exists site_publication_state_audit on public.site_publication_state;
create trigger site_publication_state_audit
after insert or update or delete on public.site_publication_state
for each row execute procedure private.log_site_audit();

alter table public.site_content enable row level security;
alter table public.site_content force row level security;
alter table public.site_services enable row level security;
alter table public.site_services force row level security;
alter table public.site_media enable row level security;
alter table public.site_media force row level security;
alter table public.payment_methods enable row level security;
alter table public.payment_methods force row level security;
alter table public.site_publications enable row level security;
alter table public.site_publications force row level security;
alter table public.site_publication_state enable row level security;
alter table public.site_publication_state force row level security;
alter table public.site_audit_events enable row level security;
alter table public.site_audit_events force row level security;

revoke all on table public.site_content from public, anon, authenticated;
revoke all on table public.site_services from public, anon, authenticated;
revoke all on table public.site_media from public, anon, authenticated;
revoke all on table public.payment_methods from public, anon, authenticated;
revoke all on table public.site_publications from public, anon, authenticated;
revoke all on table public.site_publication_state from public, anon, authenticated;
revoke all on table public.site_audit_events from public, anon, authenticated;

-- Only trusted Edge Functions, using the service role key server-side, receive
-- table grants. The browser has no direct CMS table access.
grant select, insert, update, delete on table public.site_content to service_role;
grant select, insert, update, delete on table public.site_services to service_role;
grant select, insert, update, delete on table public.site_media to service_role;
grant select, insert, update, delete on table public.payment_methods to service_role;
grant select on table public.site_publications to service_role;
grant select on table public.site_publication_state to service_role;
grant select on table public.site_audit_events to service_role;

create policy "cms owners read site content" on public.site_content
for select to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');
create policy "cms owners write site content" on public.site_content
for all to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2')
with check (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');

create policy "cms owners read services" on public.site_services
for select to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');
create policy "cms owners write services" on public.site_services
for all to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2')
with check (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');

create policy "cms owners read media" on public.site_media
for select to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');
create policy "cms owners write media" on public.site_media
for all to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2')
with check (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');

create policy "cms owners read payment methods" on public.payment_methods
for select to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');
create policy "cms owners write payment methods" on public.payment_methods
for all to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2')
with check (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');

create policy "cms owners read publications" on public.site_publications
for select to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');
create policy "cms owners read publication state" on public.site_publication_state
for select to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');
create policy "cms owners read audit events" on public.site_audit_events
for select to authenticated
using (public.is_crm_owner() and (select auth.jwt() ->> 'aal') = 'aal2');

-- Private media is served to the public only through short-lived signed URLs
-- generated by the public configuration Edge Function after it selects published rows.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'site-media',
  'site-media',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "cms owners read site media objects" on storage.objects;
drop policy if exists "cms owners upload site media objects" on storage.objects;
drop policy if exists "cms owners update site media objects" on storage.objects;
drop policy if exists "cms owners delete site media objects" on storage.objects;

create policy "cms owners read site media objects" on storage.objects
for select to authenticated
using (
  bucket_id = 'site-media'
  and public.is_crm_owner()
  and (select auth.jwt() ->> 'aal') = 'aal2'
);
create policy "cms owners upload site media objects" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'site-media'
  and public.is_crm_owner()
  and (select auth.jwt() ->> 'aal') = 'aal2'
  and lower(storage.extension(name)) = any (array['jpg', 'jpeg', 'png', 'webp'])
  and split_part(name, '/', 1) = auth.uid()::text
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$'
);
create policy "cms owners update site media objects" on storage.objects
for update to authenticated
using (
  bucket_id = 'site-media'
  and public.is_crm_owner()
  and (select auth.jwt() ->> 'aal') = 'aal2'
)
with check (
  bucket_id = 'site-media'
  and public.is_crm_owner()
  and (select auth.jwt() ->> 'aal') = 'aal2'
  and lower(storage.extension(name)) = any (array['jpg', 'jpeg', 'png', 'webp'])
  and split_part(name, '/', 1) = auth.uid()::text
  and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$'
);
create policy "cms owners delete site media objects" on storage.objects
for delete to authenticated
using (
  bucket_id = 'site-media'
  and public.is_crm_owner()
  and (select auth.jwt() ->> 'aal') = 'aal2'
);

create or replace function public.publish_site_snapshot(
  p_snapshot jsonb,
  p_checksum text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_snapshot jsonb;
  v_actor uuid;
  v_actor_text text;
  v_checksum text;
  v_publication_id uuid;
begin
  if p_snapshot is null
     or p_checksum is null
     or lower(p_checksum) !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_publication_input' using errcode = '22023';
  end if;

  -- A trusted Edge Function may place the authenticated owner id here. It is
  -- validated, used for audit attribution, and removed before the snapshot is stored.
  v_actor_text := nullif(p_snapshot ->> '__actor_id', '');
  if v_actor_text is not null then
    begin
      v_actor := v_actor_text::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_publication_actor' using errcode = '22023';
    end;

    if not exists (
      select 1 from public.profiles p where p.user_id = v_actor and p.role = 'owner'
    ) then
      raise exception 'invalid_publication_actor' using errcode = '22023';
    end if;
  else
    v_actor := auth.uid();
  end if;

  v_snapshot := p_snapshot - '__actor_id';
  if not private.is_valid_public_snapshot(v_snapshot) then
    raise exception 'invalid_publication_snapshot' using errcode = '22023';
  end if;

  -- The database, not the caller, is authoritative for the persisted checksum.
  v_checksum := encode(extensions.digest(convert_to(v_snapshot::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.site_publications (snapshot, checksum, published_by)
  values (v_snapshot, v_checksum, v_actor)
  returning id into v_publication_id;

  insert into public.site_publication_state (id, active_publication_id)
  values (true, v_publication_id)
  on conflict (id) do update
  set active_publication_id = excluded.active_publication_id;

  return v_publication_id;
end;
$$;

revoke all on function public.publish_site_snapshot(jsonb, text) from public, anon, authenticated;
grant execute on function public.publish_site_snapshot(jsonb, text) to service_role;
