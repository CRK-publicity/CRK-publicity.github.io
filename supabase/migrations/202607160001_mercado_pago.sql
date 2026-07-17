-- Secure Mercado Pago Checkout Pro orders, audit events and rate limiting.
create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  public_token uuid not null unique,
  contact_id uuid references public.contacts(id) on delete set null,
  provider text not null default 'mercado_pago' check (provider = 'mercado_pago'),
  product_code text not null check (product_code = 'web_starter'),
  title text not null check (title = 'Página web inicial'),
  amount_cop bigint not null check (amount_cop = 200000),
  currency text not null default 'COP' check (currency = 'COP'),
  scope_version text not null check (scope_version = 'web-starter-2026-07-16-v1'),
  privacy_version text not null check (privacy_version = 'privacy-2026-07-16-v1'),
  accepted_at timestamptz not null,
  status text not null default 'created' check (status in (
    'created', 'processing', 'checkout_ready', 'pending', 'approved',
    'rejected', 'cancelled', 'refunded', 'charged_back', 'error'
  )),
  external_reference text not null unique check (char_length(external_reference) between 8 and 80),
  provider_preference_id text unique check (provider_preference_id is null or char_length(provider_preference_id) <= 120),
  provider_collector_id text check (provider_collector_id is null or provider_collector_id ~ '^[0-9]{1,30}$'),
  latest_provider_payment_id text check (latest_provider_payment_id is null or latest_provider_payment_id ~ '^[0-9]{1,40}$'),
  provider_status text check (provider_status is null or char_length(provider_status) <= 60),
  provider_status_detail text check (provider_status_detail is null or char_length(provider_status_detail) <= 120),
  provider_updated_at timestamptz,
  checkout_url text check (
    checkout_url is null or (
      char_length(checkout_url) <= 2048
      and checkout_url ~* '^https://(www|sandbox)\.mercadopago\.com(\.co)?/'
    )
  ),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_orders_contact_idx on public.payment_orders(contact_id, created_at desc);
create index if not exists payment_orders_status_idx on public.payment_orders(status, created_at desc);
create unique index if not exists payment_orders_provider_payment_unique
  on public.payment_orders(latest_provider_payment_id)
  where latest_provider_payment_id is not null;

create table if not exists public.payment_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.payment_orders(id) on delete restrict,
  provider text not null default 'mercado_pago' check (provider = 'mercado_pago'),
  provider_event_key text not null unique check (char_length(provider_event_key) between 8 and 240),
  provider_payment_id text check (provider_payment_id is null or provider_payment_id ~ '^[0-9]{1,40}$'),
  event_type text check (event_type is null or char_length(event_type) <= 60),
  event_action text check (event_action is null or char_length(event_action) <= 100),
  provider_status text check (provider_status is null or char_length(provider_status) <= 60),
  outcome text not null check (outcome in (
    'applied', 'duplicate', 'stale', 'amount_mismatch', 'collector_mismatch',
    'duplicate_payment', 'unsupported_status', 'ignored'
  )),
  payload_hash text not null check (char_length(payload_hash) = 64),
  refunded_amount_cop bigint not null default 0 check (refunded_amount_cop >= 0),
  provider_updated_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists payment_events_order_idx on public.payment_events(order_id, received_at desc);
create index if not exists payment_events_provider_payment_idx on public.payment_events(provider_payment_id, received_at desc);

create table if not exists public.payment_requests (
  id bigint generated always as identity primary key,
  fingerprint_hash text not null check (char_length(fingerprint_hash) = 64),
  request_kind text not null check (request_kind in ('create', 'status')),
  public_token uuid,
  created_at timestamptz not null default now()
);

create index if not exists payment_requests_rate_idx
  on public.payment_requests(fingerprint_hash, request_kind, created_at desc);

alter table public.payment_orders enable row level security;
alter table public.payment_orders force row level security;
alter table public.payment_events enable row level security;
alter table public.payment_events force row level security;
alter table public.payment_requests enable row level security;
alter table public.payment_requests force row level security;

revoke all on public.payment_orders from anon, authenticated;
revoke all on public.payment_events from anon, authenticated;
revoke all on public.payment_requests from anon, authenticated;
grant select on public.payment_orders to authenticated;
grant select on public.payment_events to authenticated;

create policy "crm payment orders read" on public.payment_orders
for select to authenticated using (public.is_crm_member());
create policy "mfa required payment orders" on public.payment_orders
as restrictive for select to authenticated
using ((select auth.jwt() ->> 'aal') = 'aal2');

create policy "crm payment events read" on public.payment_events
for select to authenticated using (public.is_crm_member());
create policy "mfa required payment events" on public.payment_events
as restrictive for select to authenticated
using ((select auth.jwt() ->> 'aal') = 'aal2');

drop trigger if exists payment_orders_set_updated_at on public.payment_orders;
create trigger payment_orders_set_updated_at before update on public.payment_orders
for each row execute procedure public.set_record_updated_at();

create or replace function public.check_payment_rate_limit(
  p_fingerprint text,
  p_request_kind text,
  p_public_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_requests integer;
  request_limit integer;
begin
  if p_fingerprint is null or char_length(p_fingerprint) <> 64
     or p_request_kind not in ('create', 'status')
     or (p_request_kind = 'create' and p_public_token is null) then
    return false;
  end if;


  perform pg_advisory_xact_lock(hashtextextended(p_fingerprint || ':' || p_request_kind, 0));
  delete from public.payment_requests where created_at < now() - interval '24 hours';

  if p_request_kind = 'create' and exists (
    select 1 from public.payment_orders where public_token = p_public_token
  ) then
    -- A known UUID may retry transient failures without consuming the three-attempt new-order quota.
    request_limit := 10;
    select count(*) into recent_requests
    from public.payment_requests
    where fingerprint_hash = p_fingerprint
      and request_kind = p_request_kind
      and public_token = p_public_token
      and created_at >= now() - interval '15 minutes';
  else
    request_limit := case when p_request_kind = 'create' then 3 else 60 end;
    select count(*) into recent_requests
    from public.payment_requests
    where fingerprint_hash = p_fingerprint
      and request_kind = p_request_kind
      and created_at >= now() - interval '15 minutes';
  end if;

  if recent_requests >= request_limit then
    return false;
  end if;

  insert into public.payment_requests(fingerprint_hash, request_kind, public_token)
  values (p_fingerprint, p_request_kind, p_public_token);
  return true;
end;
$$;

create or replace function public.create_payment_order(
  p_public_token uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_scope_accepted boolean,
  p_privacy_accepted boolean,
  p_scope_version text,
  p_privacy_version text
)
returns table(
  order_id uuid,
  order_public_token uuid,
  external_reference text,
  product_code text,
  title text,
  amount_cop bigint,
  currency text,
  status text,
  provider_preference_id text,
  checkout_url text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
  v_contact_email text;
  v_contact_phone text;
  v_conversation_id uuid;
  v_order_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_public_token is null
     or p_name is null or char_length(p_name) not between 2 and 100
     or p_email is null or char_length(p_email) not between 5 and 180
     or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
     or p_phone is null or p_phone !~ '^\+[1-9][0-9]{9,14}$'
     or p_scope_accepted is distinct from true
     or p_privacy_accepted is distinct from true
     or p_scope_version is distinct from 'web-starter-2026-07-16-v1'
     or p_privacy_version is distinct from 'privacy-2026-07-16-v1' then
    raise exception 'invalid_payment_input' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_public_token::text, 0));

  select o.contact_id, c.email, c.phone_e164
  into v_contact_id, v_contact_email, v_contact_phone
  from public.payment_orders o
  left join public.contacts c on c.id = o.contact_id
  where o.public_token = p_public_token
  for update of o;

  if found then
    if v_contact_id is null
       or lower(coalesce(v_contact_email, '')) <> lower(p_email)
       or coalesce(v_contact_phone, '') <> p_phone then
      raise exception 'payment_identity_conflict' using errcode = '22023';
    end if;

    return query
      select o.id, o.public_token, o.external_reference, o.product_code, o.title,
             o.amount_cop, o.currency, o.status, o.provider_preference_id, o.checkout_url
      from public.payment_orders o
      where o.public_token = p_public_token;
    return;
  end if;

  -- Lock both normalized identifiers in a fixed order so overlapping requests cannot race.
  perform pg_advisory_xact_lock(hashtextextended('contact-email:' || lower(p_email), 0));
  perform pg_advisory_xact_lock(hashtextextended('contact-phone:' || p_phone, 0));

  select c.id into v_contact_id
  from public.contacts c
  where c.phone_e164 = p_phone and lower(c.email) = lower(p_email)
  limit 1
  for update;

  if v_contact_id is null then
    if exists (
      select 1 from public.contacts c
      where c.phone_e164 = p_phone or lower(c.email) = lower(p_email)
    ) then
      raise exception 'payment_identity_conflict' using errcode = '22023';
    end if;

    insert into public.contacts
      (full_name, phone_e164, email, source, consent_status, consent_at, last_seen_at)
    values
      (p_name, p_phone, lower(p_email), 'payment', 'granted', v_now, v_now)
    returning id into v_contact_id;
  else
    update public.contacts
    set consent_status = 'granted',
        consent_at = v_now,
        last_seen_at = v_now
    where id = v_contact_id;
  end if;

  insert into public.conversations(contact_id, channel, status, unread_count, last_message_at)
  values (v_contact_id, 'web', 'open', 1, v_now)
  on conflict (contact_id, channel) do update
  set status = 'open',
      unread_count = public.conversations.unread_count + 1,
      last_message_at = excluded.last_message_at
  returning id into v_conversation_id;

  insert into public.payment_orders(
    public_token, contact_id, product_code, title, amount_cop, currency,
    scope_version, privacy_version, accepted_at, external_reference
  )
  values (
    p_public_token, v_contact_id, 'web_starter', 'Página web inicial', 200000, 'COP',
    p_scope_version, p_privacy_version, v_now, 'crk_' || p_public_token::text
  )
  returning id into v_order_id;

  insert into public.messages(
    conversation_id, contact_id, direction, message_type, body, status, sent_at
  )
  values (
    v_conversation_id, v_contact_id, 'inbound', 'payment_order',
    format(E'Orden de pago iniciada\n\nProducto: Página web inicial\nValor: $200.000 COP\nCliente: %s\nCorreo: %s\nWhatsApp: %s',
      p_name, lower(p_email), p_phone),
    'received', v_now
  );

  insert into public.activities(contact_id, activity_type, summary, metadata)
  values (
    v_contact_id,
    'payment_created',
    'Pago iniciado · Página web inicial · $200.000 COP',
    jsonb_build_object(
      'order', p_public_token,
      'product_code', 'web_starter',
      'amount', 200000,
      'currency', 'COP',
      'scope_version', p_scope_version,
      'privacy_version', p_privacy_version
    )
  );

  return query
    select o.id, o.public_token, o.external_reference, o.product_code, o.title,
           o.amount_cop, o.currency, o.status, o.provider_preference_id, o.checkout_url
    from public.payment_orders o
    where o.id = v_order_id;
end;
$$;
create or replace function public.claim_payment_preference(p_order_id uuid)
returns table(claimed boolean, current_status text, existing_checkout_url text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.payment_orders%rowtype;
begin
  if p_order_id is null then
    return query select false, 'invalid'::text, null::text;
    return;
  end if;

  select * into v_order
  from public.payment_orders
  where id = p_order_id
  for update;

  if not found then
    return query select false, 'missing'::text, null::text;
    return;
  end if;

  if v_order.status = 'checkout_ready' and v_order.checkout_url is not null then
    return query select false, v_order.status, v_order.checkout_url;
    return;
  end if;

  if v_order.status in ('created', 'error')
     or (v_order.status = 'processing' and v_order.updated_at < now() - interval '2 minutes') then
    update public.payment_orders
    set status = 'processing'
    where id = v_order.id;
    return query select true, 'processing'::text, null::text;
    return;
  end if;

  return query select false, v_order.status, v_order.checkout_url;
end;
$$;
create or replace function public.set_payment_preference(
  p_order_id uuid,
  p_preference_id text,
  p_collector_id text,
  p_checkout_url text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed integer;
begin
  if p_order_id is null
     or p_preference_id is null or char_length(p_preference_id) not between 5 and 120
     or p_collector_id is null or p_collector_id !~ '^[0-9]{1,30}$'
     or p_checkout_url is null or char_length(p_checkout_url) > 2048
     or p_checkout_url !~* '^https://(www|sandbox)\.mercadopago\.com(\.co)?/' then
    return false;
  end if;

  update public.payment_orders
  set provider_preference_id = p_preference_id,
      provider_collector_id = p_collector_id,
      checkout_url = p_checkout_url,
      status = 'checkout_ready'
  where id = p_order_id
    and status = 'processing'
    and (provider_preference_id is null or provider_preference_id = p_preference_id);

  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$$;
create or replace function public.apply_mercado_pago_payment(
  p_external_reference text,
  p_provider_payment_id text,
  p_internal_status text,
  p_provider_status text,
  p_provider_status_detail text,
  p_provider_updated_at timestamptz,
  p_amount_cop bigint,
  p_refunded_amount_cop bigint,
  p_currency text,
  p_collector_id text,
  p_event_key text,
  p_event_type text,
  p_event_action text,
  p_payload_hash text
)
returns table(outcome text, order_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.payment_orders%rowtype;
  v_event_id bigint;
  v_outcome text := 'applied';
  v_now timestamptz := clock_timestamp();
  v_summary text;
begin
  if p_external_reference is null or char_length(p_external_reference) not between 8 and 80
     or p_provider_payment_id is null or p_provider_payment_id !~ '^[0-9]{1,40}$'
     or (p_internal_status is not null and p_internal_status not in ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back', 'error'))
     or p_provider_status is null or char_length(p_provider_status) > 60
     or p_provider_status_detail is null or char_length(p_provider_status_detail) > 120
     or p_provider_updated_at is null
     or p_amount_cop is null
     or p_refunded_amount_cop is null or p_refunded_amount_cop < 0 or p_refunded_amount_cop > p_amount_cop
     or p_currency is null
     or p_collector_id is null or p_collector_id !~ '^[0-9]{1,30}$'
     or p_event_key is null or char_length(p_event_key) not between 8 and 240
     or p_payload_hash is null or char_length(p_payload_hash) <> 64 then
    raise exception 'invalid_payment_event' using errcode = '22023';
  end if;

  if p_internal_status is null then
    v_outcome := 'unsupported_status';
  end if;

  select * into v_order
  from public.payment_orders
  where external_reference = p_external_reference
  for update;

  if not found then
    return query select 'ignored'::text, null::uuid;
    return;
  end if;

  if p_amount_cop <> v_order.amount_cop or p_currency <> v_order.currency then
    v_outcome := 'amount_mismatch';
  elsif v_order.provider_collector_id is null or p_collector_id <> v_order.provider_collector_id then
    v_outcome := 'collector_mismatch';
  elsif v_order.latest_provider_payment_id is not null
        and v_order.latest_provider_payment_id <> p_provider_payment_id
        and (
          v_order.status in ('approved', 'refunded', 'charged_back')
          or p_internal_status in ('refunded', 'charged_back')
        ) then
    -- The first approved payment wins; another payment ID cannot refund or reverse it.
    v_outcome := 'duplicate_payment';
  elsif v_order.provider_updated_at is not null and p_provider_updated_at < v_order.provider_updated_at then
    v_outcome := 'stale';
  elsif v_order.status = 'approved' and p_internal_status not in ('approved', 'refunded', 'charged_back') then
    v_outcome := 'stale';
  elsif v_order.status in ('refunded', 'charged_back') and p_internal_status not in ('refunded', 'charged_back') then
    v_outcome := 'stale';
  end if;

  insert into public.payment_events(
    order_id, provider_event_key, provider_payment_id, event_type, event_action,
    provider_status, outcome, payload_hash, refunded_amount_cop, provider_updated_at, processed_at,
    metadata
  )
  values (
    v_order.id, p_event_key, p_provider_payment_id, left(p_event_type, 60),
    left(p_event_action, 100), p_provider_status, v_outcome, p_payload_hash,
    p_refunded_amount_cop, p_provider_updated_at, v_now,
    jsonb_build_object('currency', p_currency, 'amount', p_amount_cop, 'refunded_amount', p_refunded_amount_cop)
  )
  on conflict (provider_event_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return query select 'duplicate'::text, v_order.id;
    return;
  end if;

  if v_outcome <> 'applied' then
    if v_outcome in ('duplicate_payment', 'unsupported_status') and v_order.contact_id is not null then
      insert into public.activities(contact_id, activity_type, summary, metadata)
      values (
        v_order.contact_id,
        'payment_status',
        case
          when v_outcome = 'duplicate_payment' then 'Alerta · posible pago duplicado en Mercado Pago'
          when p_provider_status_detail like 'partial_refund:%' then 'Alerta · reembolso parcial en Mercado Pago'
          else 'Alerta · estado de pago no reconocido'
        end,
        jsonb_build_object(
          'order', v_order.public_token,
          'provider_payment_id', p_provider_payment_id,
          'status', p_provider_status,
          'status_detail', p_provider_status_detail,
          'refunded_amount', p_refunded_amount_cop
        )
      );
    end if;
    return query select v_outcome, v_order.id;
    return;
  end if;

  update public.payment_orders
  set status = p_internal_status,
      latest_provider_payment_id = p_provider_payment_id,
      provider_status = p_provider_status,
      provider_status_detail = p_provider_status_detail,
      provider_updated_at = p_provider_updated_at,
      paid_at = case when p_internal_status = 'approved' then coalesce(paid_at, v_now) else paid_at end
  where id = v_order.id;

  if v_order.status is distinct from p_internal_status and v_order.contact_id is not null then
    v_summary := case p_internal_status
      when 'approved' then 'Pago aprobado · Página web inicial · $200.000 COP'
      when 'pending' then 'Pago pendiente · Página web inicial'
      when 'rejected' then 'Pago rechazado · Página web inicial'
      when 'cancelled' then 'Pago cancelado · Página web inicial'
      when 'refunded' then 'Pago devuelto · Página web inicial'
      when 'charged_back' then 'Pago reversado · Página web inicial'
      else 'Pago con novedad · Página web inicial'
    end;

    insert into public.activities(contact_id, activity_type, summary, metadata)
    values (
      v_order.contact_id,
      case when p_internal_status = 'approved' then 'payment_approved' else 'payment_status' end,
      v_summary,
      jsonb_build_object(
        'order', v_order.public_token,
        'product_code', v_order.product_code,
        'status', p_internal_status,
        'amount', v_order.amount_cop,
        'currency', v_order.currency
      )
    );

    if p_internal_status = 'approved' then
      update public.contacts
      set lifecycle_stage = 'customer', last_seen_at = v_now
      where id = v_order.contact_id;
    end if;
  end if;

  return query select 'applied'::text, v_order.id;
end;
$$;

revoke all on function public.check_payment_rate_limit(text, text, uuid) from public, anon, authenticated;
revoke all on function public.create_payment_order(uuid, text, text, text, boolean, boolean, text, text) from public, anon, authenticated;
revoke all on function public.claim_payment_preference(uuid) from public, anon, authenticated;
revoke all on function public.set_payment_preference(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.apply_mercado_pago_payment(text, text, text, text, text, timestamptz, bigint, bigint, text, text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.check_payment_rate_limit(text, text, uuid) to service_role;
grant execute on function public.create_payment_order(uuid, text, text, text, boolean, boolean, text, text) to service_role;
grant execute on function public.claim_payment_preference(uuid) to service_role;
grant execute on function public.set_payment_preference(uuid, text, text, text) to service_role;
grant execute on function public.apply_mercado_pago_payment(text, text, text, text, text, timestamptz, bigint, bigint, text, text, text, text, text, text) to service_role;