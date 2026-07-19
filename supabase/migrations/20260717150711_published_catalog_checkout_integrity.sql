-- A published page and its checkout must always use the same immutable
-- catalog snapshot. Draft changes stay invisible until the owner publishes.

alter table public.site_services
  add column if not exists archived boolean not null default false;

alter table public.site_media
  add column if not exists archived boolean not null default false;

create unique index if not exists site_services_checkout_product_code_unique_idx
  on public.site_services(checkout_product_code)
  where cta_type = 'checkout' and checkout_product_code is not null and archived = false;

alter table public.payment_orders
  add column if not exists description text,
  add column if not exists site_publication_id uuid references public.site_publications(id) on delete set null;

alter table public.payment_orders
  drop constraint if exists payment_orders_description_dynamic_check;

alter table public.payment_orders
  add constraint payment_orders_description_dynamic_check
  check (description is null or char_length(description) between 2 and 1200);

create index if not exists payment_orders_publication_idx
  on public.payment_orders(site_publication_id, created_at desc)
  where site_publication_id is not null;

drop function if exists public.create_payment_order(uuid, text, text, text, uuid, boolean, boolean, text, text);

create function public.create_payment_order(
  p_public_token uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_service_reference text,
  p_payment_mode text,
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
  v_existing_product_code text;
  v_conversation_id uuid;
  v_order_id uuid;
  v_publication_id uuid;
  v_snapshot jsonb;
  v_service jsonb;
  v_service_id uuid;
  v_product_code text;
  v_title text;
  v_description text;
  v_amount_text text;
  v_amount_cop bigint;
  v_currency text;
  v_now timestamptz := clock_timestamp();
  v_uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  v_product_pattern constant text := '^[a-z0-9]+(_[a-z0-9]+)*$';
begin
  if p_public_token is null
     or p_name is null or char_length(p_name) not between 2 and 100
     or p_email is null or char_length(p_email) not between 5 and 180
     or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
     or p_phone is null or p_phone !~ '^\+[1-9][0-9]{9,14}$'
     or p_service_reference is null
     or (p_service_reference !~* v_uuid_pattern and p_service_reference !~ v_product_pattern)
     or p_payment_mode not in ('test', 'live')
     or p_scope_accepted is distinct from true
     or p_privacy_accepted is distinct from true
     or p_scope_version not in ('web-starter-2026-07-16-v1', 'site-checkout-2026-07-17-v1')
     or p_privacy_version is distinct from 'privacy-2026-07-16-v1' then
    raise exception 'invalid_payment_input' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_public_token::text, 0));

  select o.contact_id, c.email, c.phone_e164, o.service_id, o.product_code
  into v_contact_id, v_contact_email, v_contact_phone, v_existing_service_id, v_existing_product_code
  from public.payment_orders o
  left join public.contacts c on c.id = o.contact_id
  where o.public_token = p_public_token
  for update of o;

  if found then
    if v_contact_id is null
       or lower(coalesce(v_contact_email, '')) <> lower(p_email)
       or coalesce(v_contact_phone, '') <> p_phone
       or (p_service_reference ~* v_uuid_pattern and v_existing_service_id::text is distinct from lower(p_service_reference))
       or (p_service_reference !~* v_uuid_pattern and v_existing_product_code is distinct from p_service_reference) then
      raise exception 'payment_identity_conflict' using errcode = '22023';
    end if;

    return query
      select o.id, o.public_token, o.external_reference, o.service_id, o.product_code, o.title,
             coalesce(o.description, 'Servicio CRK Publicity'), o.amount_cop, o.currency, o.status,
             o.provider_preference_id, o.checkout_url
      from public.payment_orders o
      where o.public_token = p_public_token;
    return;
  end if;

  select publication.id, publication.snapshot
  into v_publication_id, v_snapshot
  from public.site_publication_state state
  join public.site_publications publication on publication.id = state.active_publication_id
  where state.id is true
  for share of state, publication;

  if v_publication_id is null or v_snapshot is null then
    raise exception 'payment_service_unavailable' using errcode = '22023';
  end if;

  select item.value
  into v_service
  from jsonb_array_elements(coalesce(v_snapshot -> 'services', '[]'::jsonb)) as item(value)
  where item.value ->> 'id' = p_service_reference
     or item.value #>> '{cta,product_code}' = p_service_reference
  limit 1;

  if v_service is null
     or coalesce(v_service ->> 'id', '') !~* v_uuid_pattern
     or v_service #>> '{cta,type}' <> 'checkout' then
    raise exception 'payment_service_unavailable' using errcode = '22023';
  end if;

  v_service_id := (v_service ->> 'id')::uuid;
  v_product_code := v_service #>> '{cta,product_code}';
  v_title := v_service ->> 'title';
  v_description := v_service ->> 'description';
  v_amount_text := v_service ->> 'price_cop';
  v_currency := v_service ->> 'currency';

  if v_product_code !~ v_product_pattern
     or char_length(v_product_code) not between 2 and 80
     or char_length(v_title) not between 2 and 160
     or char_length(v_description) not between 2 and 1200
     or v_amount_text !~ '^[0-9]{4,11}$'
     or v_currency <> 'COP' then
    raise exception 'payment_service_unavailable' using errcode = '22023';
  end if;

  v_amount_cop := v_amount_text::bigint;
  if v_amount_cop not between 1000 and 10000000000 then
    raise exception 'payment_service_unavailable' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_snapshot -> 'payment_methods', '[]'::jsonb)) as method(value)
    where method.value ->> 'code' = 'mercado_pago'
      and method.value ->> 'provider' = 'mercado_pago'
      and method.value ->> 'mode' = p_payment_mode
  ) then
    raise exception 'payment_method_unavailable' using errcode = '22023';
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
    public_token, contact_id, service_id, site_publication_id, product_code, title, description,
    amount_cop, currency, scope_version, privacy_version, accepted_at, external_reference
  )
  values (
    p_public_token, v_contact_id, v_service_id, v_publication_id, v_product_code, v_title, v_description,
    v_amount_cop, v_currency, p_scope_version, p_privacy_version, v_now, 'crk_' || p_public_token::text
  )
  returning id into v_order_id;

  insert into public.messages(
    conversation_id, contact_id, direction, message_type, body, status, sent_at
  )
  values (
    v_conversation_id, v_contact_id, 'inbound', 'payment_order',
    format(E'Orden de pago iniciada\n\nProducto: %s\nValor: $%s %s\nCliente: %s\nCorreo: %s\nWhatsApp: %s',
      v_title, to_char(v_amount_cop, 'FM999G999G999G999'), v_currency, p_name, lower(p_email), p_phone),
    'received', v_now
  );

  insert into public.activities(contact_id, activity_type, summary, metadata)
  values (
    v_contact_id,
    'payment_created',
    format('Pago iniciado · %s · $%s %s', v_title, to_char(v_amount_cop, 'FM999G999G999G999'), v_currency),
    jsonb_build_object(
      'order', p_public_token,
      'service_id', v_service_id,
      'publication_id', v_publication_id,
      'product_code', v_product_code,
      'amount', v_amount_cop,
      'currency', v_currency,
      'scope_version', p_scope_version,
      'privacy_version', p_privacy_version
    )
  );

  return query
    select o.id, o.public_token, o.external_reference, o.service_id, o.product_code, o.title,
           o.description, o.amount_cop, o.currency, o.status, o.provider_preference_id, o.checkout_url
    from public.payment_orders o
    where o.id = v_order_id;
end;
$$;

revoke all on function public.create_payment_order(uuid, text, text, text, text, text, boolean, boolean, text, text) from public, anon, authenticated;
grant execute on function public.create_payment_order(uuid, text, text, text, text, text, boolean, boolean, text, text) to service_role;
