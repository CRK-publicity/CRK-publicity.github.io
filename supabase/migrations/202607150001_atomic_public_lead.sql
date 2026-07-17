create or replace function public.ingest_public_lead(
  p_name text,
  p_email text,
  p_phone text,
  p_company text,
  p_need text
)
returns table(contact_id uuid, conversation_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
  v_conversation_id uuid;
  v_now timestamptz := clock_timestamp();
  v_message text;
begin
  if p_name is null or length(p_name) not between 2 and 100
     or p_email is null or length(p_email) not between 5 and 180
     or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
     or p_phone is null or p_phone !~ '^\+[1-9][0-9]{9,14}$'
     or p_company is null or length(p_company) not between 2 and 140
     or p_need is null or length(p_need) not between 2 and 240 then
    raise exception 'invalid_lead_input' using errcode = '22023';
  end if;

  -- Lock both normalized identifiers in a fixed order so overlapping requests cannot race.
  perform pg_advisory_xact_lock(hashtextextended('contact-email:' || lower(p_email), 0));
  perform pg_advisory_xact_lock(hashtextextended('contact-phone:' || p_phone, 0));

  select id into v_contact_id
  from public.contacts
  where phone_e164 = p_phone and lower(email) = lower(p_email)
  limit 1
  for update;

  if v_contact_id is null then
    if exists (
      select 1 from public.contacts
      where phone_e164 = p_phone or lower(email) = lower(p_email)
    ) then
      raise exception 'lead_identity_conflict' using errcode = '22023';
    end if;

    insert into public.contacts
      (full_name, phone_e164, email, company, source, consent_status, consent_at, last_seen_at)
    values
      (p_name, p_phone, lower(p_email), p_company, 'web', 'granted', v_now, v_now)
    returning id into v_contact_id;
  else
    -- Public submissions may refresh consent/activity but never master identity fields.
    update public.contacts
    set consent_status = 'granted',
        consent_at = v_now,
        last_seen_at = v_now
    where id = v_contact_id;
  end if;

  insert into public.conversations
    (contact_id, channel, status, unread_count, last_message_at)
  values
    (v_contact_id, 'web', 'open', 1, v_now)
  on conflict (contact_id, channel) do update
  set status = 'open',
      unread_count = public.conversations.unread_count + 1,
      last_message_at = excluded.last_message_at
  returning id into v_conversation_id;

  v_message := format(
    E'Nueva solicitud desde la web\n\nServicio: %s\nNegocio: %s\nCliente: %s\nCorreo: %s\nWhatsApp: %s',
    p_need, p_company, p_name, lower(p_email), p_phone
  );

  insert into public.messages
    (conversation_id, contact_id, direction, message_type, body, status, sent_at)
  values
    (v_conversation_id, v_contact_id, 'inbound', 'lead_form', v_message, 'received', v_now);

  insert into public.activities
    (contact_id, activity_type, summary, metadata)
  values
    (v_contact_id, 'lead_form', p_need, jsonb_build_object(
      'company', p_company,
      'email', lower(p_email),
      'phone', p_phone,
      'consent_at', v_now,
      'page', 'portfolio'
    ));

  return query select v_contact_id, v_conversation_id;
end;
$$;

revoke all on function public.ingest_public_lead(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ingest_public_lead(text, text, text, text, text) to service_role;