-- Bind checkout orders to owner-managed services.  The browser can identify a
-- service, but its title, amount and currency are always read by the server.
alter table public.payment_orders
  add column if not exists service_id uuid references public.site_services(id) on delete set null;

create index if not exists payment_orders_service_idx
  on public.payment_orders(service_id, created_at desc);

alter table public.payment_orders
  drop constraint if exists payment_orders_product_code_check,
  drop constraint if exists payment_orders_title_check,
  drop constraint if exists payment_orders_amount_cop_check,
  drop constraint if exists payment_orders_scope_version_check,
  drop constraint if exists payment_orders_product_code_dynamic_check,
  drop constraint if exists payment_orders_title_dynamic_check,
  drop constraint if exists payment_orders_amount_cop_dynamic_check,
  drop constraint if exists payment_orders_scope_version_dynamic_check;

alter table public.payment_orders
  add constraint payment_orders_product_code_dynamic_check
    check (product_code ~ '^[a-z0-9]+(_[a-z0-9]+)*$' and char_length(product_code) between 2 and 80),
  add constraint payment_orders_title_dynamic_check
    check (char_length(title) between 2 and 160),
  add constraint payment_orders_amount_cop_dynamic_check
    check (amount_cop between 1000 and 10000000000),
  add constraint payment_orders_scope_version_dynamic_check
    check (scope_version in ('web-starter-2026-07-16-v1', 'site-checkout-2026-07-17-v1'));

drop function if exists public.create_payment_order(uuid, text, text, text, boolean, boolean, text, text);

create function public.create_payment_order(
  p_public_token uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_service_id uuid,
  p_scope_accepted boolean,
  p_privacy_accepted boolean,
  p_scope_version text,
  p_privacy_version text
)
returns table(
  order_id uuid,
  order_public_token uuid,
  external_reference text,
  service_id uuid,
  product_code text,
  title text,
  description text,
  amount_cop bigint,
  currency text,
  status text,
  provider_preference_id text,
  checkout_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_contact_id uuid;
  v_contact_email text;
  v_contact_phone text;
  v_existing_service_id uuid;
  v_conversation_id uuid;
  v_order_id uuid;
  v_service public.site_services%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_public_token is null
     or p_name is null or char_length(p_name) not between 2 and 100
     or p_email is null or char_length(p_email) not between 5 and 180
     or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
     or p_phone is null or p_phone !~ '^\+[1-9][0-9]{9,14}$'
     or p_service_id is null
     or p_scope_accepted is distinct from true
     or p_privacy_accepted is distinct from true
     or p_scope_version not in ('web-starter-2026-07-16-v1', 'site-checkout-2026-07-17-v1')
     or p_privacy_version is distinct from 'privacy-2026-07-16-v1' then
    raise exception 'invalid_payment_input' using errcode = '22023';
  end if;

  select * into v_service
  from public.site_services
  where id = p_service_id
    and published = true
    and cta_type = 'checkout'
    and checkout_product_code is not null
    and price_cop is not null
    and currency = 'COP'
  for share;

  if not found then
    raise exception 'payment_service_unavailable' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.payment_methods
    where code = 'mercado_pago'
      and provider = 'mercado_pago'
      and enabled = true
  ) then
    raise exception 'payment_method_unavailable' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_public_token::text, 0));

  select o.contact_id, c.email, c.phone_e164, o.service_id
  into v_contact_id, v_contact_email, v_contact_phone, v_existing_service_id
  from public.payment_orders o
  left join public.contacts c on c.id = o.contact_id
  where o.public_token = p_public_token
  for update of o;

  if found then
    if v_contact_id is null
       or lower(coalesce(v_contact_email, '')) <> lower(p_email)
       or coalesce(v_contact_phone, '') <> p_phone
       or v_existing_service_id is distinct from v_service.id then
      raise exception 'payment_identity_conflict' using errcode = '22023';
    end if;

    return query
      select o.id, o.public_token, o.external_reference, o.service_id, o.product_code, o.title,
             v_service.description, o.amount_cop, o.currency, o.status, o.provider_preference_id, o.checkout_url
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
    public_token, contact_id, service_id, product_code, title, amount_cop, currency,
    scope_version, privacy_version, accepted_at, external_reference
  )
  values (
    p_public_token, v_contact_id, v_service.id, v_service.checkout_product_code, v_service.title, v_service.price_cop, v_service.currency,
    p_scope_version, p_privacy_version, v_now, 'crk_' || p_public_token::text
  )
  returning id into v_order_id;

  insert into public.messages(
    conversation_id, contact_id, direction, message_type, body, status, sent_at
  )
  values (
    v_conversation_id, v_contact_id, 'inbound', 'payment_order',
    format(E'Orden de pago iniciada\n\nProducto: %s\nValor: $%s %s\nCliente: %s\nCorreo: %s\nWhatsApp: %s',
      v_service.title, to_char(v_service.price_cop, 'FM999G999G999G999'), v_service.currency, p_name, lower(p_email), p_phone),
    'received', v_now
  );

  insert into public.activities(contact_id, activity_type, summary, metadata)
  values (
    v_contact_id,
    'payment_created',
    format('Pago iniciado · %s · $%s %s', v_service.title, to_char(v_service.price_cop, 'FM999G999G999G999'), v_service.currency),
    jsonb_build_object(
      'order', p_public_token,
      'service_id', v_service.id,
      'product_code', v_service.checkout_product_code,
      'amount', v_service.price_cop,
      'currency', v_service.currency,
      'scope_version', p_scope_version,
      'privacy_version', p_privacy_version
    )
  );

  return query
    select o.id, o.public_token, o.external_reference, o.service_id, o.product_code, o.title,
           v_service.description, o.amount_cop, o.currency, o.status, o.provider_preference_id, o.checkout_url
    from public.payment_orders o
    where o.id = v_order_id;
end;
$$;

revoke all on function public.create_payment_order(uuid, text, text, text, uuid, boolean, boolean, text, text) from public, anon, authenticated;
grant execute on function public.create_payment_order(uuid, text, text, text, uuid, boolean, boolean, text, text) to service_role;
