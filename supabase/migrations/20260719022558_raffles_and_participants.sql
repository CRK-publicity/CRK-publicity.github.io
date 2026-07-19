-- Sorteos y Premios. All public mutations run through Edge Functions using
-- service credentials; browser roles have no direct access to personal data.
create extension if not exists pgcrypto;

create table public.raffles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (char_length(title) between 2 and 140),
  description text not null check (char_length(description) between 2 and 3000),
  legal_type text not null default 'raffle' check (legal_type in ('raffle','promotional_draw','voluntary_donation','participation_sale')),
  status text not null default 'draft' check (status in ('draft','upcoming','active','sold_out','finished','archived')),
  banner_path text,
  prize_image_path text,
  prize_name text not null check (char_length(prize_name) between 2 and 160),
  price_cop integer not null check (price_cop >= 0 and price_cop <= 999999999),
  starts_at timestamptz,
  closes_at timestamptz,
  draw_at timestamptz,
  max_numbers_per_participant smallint not null default 1 check (max_numbers_per_participant between 1 and 100),
  reservation_minutes smallint not null default 20 check (reservation_minutes between 5 and 120),
  nequi_number text,
  payment_instructions text not null default '' check (char_length(payment_instructions) <= 2000),
  terms_text text not null default '' check (char_length(terms_text) <= 10000),
  terms_version text not null default 'v1' check (char_length(terms_version) between 1 and 40),
  privacy_text text not null default 'Autorizo de manera previa, expresa e informada el tratamiento de mis datos personales conforme a la política de tratamiento de datos.' check (char_length(privacy_text) between 20 and 2000),
  privacy_version text not null default 'v1' check (char_length(privacy_version) between 1 and 40),
  winner_participant_id uuid,
  winner_number smallint check (winner_number between 0 and 99),
  winner_published boolean not null default false,
  winner_drawn_at timestamptz,
  winner_drawn_by uuid references public.profiles(user_id) on delete set null,
  winner_evidence jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_by uuid references public.profiles(user_id) on delete set null,
  updated_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (closes_at is null or starts_at is null or closes_at > starts_at),
  check (draw_at is null or closes_at is null or draw_at >= closes_at)
);

create table public.raffle_numbers (
  raffle_id uuid not null references public.raffles(id) on delete cascade,
  number smallint not null check (number between 0 and 99),
  state text not null default 'available' check (state in ('available','reserved','pending_validation','paid','blocked','winner')),
  reservation_id uuid,
  participant_id uuid,
  updated_at timestamptz not null default now(),
  primary key (raffle_id, number)
);

create table public.raffle_reservations (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete restrict,
  reservation_code text not null unique,
  numbers smallint[] not null check (cardinality(numbers) between 1 and 100),
  state text not null default 'active' check (state in ('active','submitted','expired','cancelled')),
  expires_at timestamptz not null,
  fingerprint_hash text not null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  unique(id, raffle_id)
);
create index raffle_reservations_expiry_idx on public.raffle_reservations(raffle_id, state, expires_at);

create table public.raffle_public_requests (
  id bigint generated always as identity primary key,
  fingerprint_hash text not null,
  action text not null check (action in ('reserve','submit')),
  created_at timestamptz not null default now()
);
create index raffle_public_requests_rate_idx on public.raffle_public_requests(fingerprint_hash, action, created_at desc);

create table public.raffle_participants (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete restrict,
  reservation_id uuid not null unique references public.raffle_reservations(id) on delete restrict,
  contact_id uuid references public.contacts(id) on delete set null,
  full_name text not null check (char_length(full_name) between 2 and 140),
  phone_e164 text not null,
  email text,
  city text,
  participant_photo_path text,
  receipt_path text,
  payment_reference text,
  expected_amount_cop integer not null check (expected_amount_cop >= 0),
  reported_amount_cop integer check (reported_amount_cop >= 0),
  paid_at timestamptz,
  observations text,
  payment_status text not null default 'pending' check (payment_status in ('pending','review','approved','rejected','refunded')),
  participation_status text not null default 'pending_validation' check (participation_status in ('temporary_reservation','incomplete','pending_validation','confirmed','cancelled','winner')),
  consent_accepted_at timestamptz not null,
  consent_policy_version text not null,
  consent_evidence jsonb not null default '{}'::jsonb,
  marketing_consent boolean not null default false,
  marketing_consent_at timestamptz,
  internal_notes text not null default '',
  validated_at timestamptz,
  validated_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(raffle_id, phone_e164, reservation_id)
);
alter table public.raffle_numbers add constraint raffle_numbers_participant_fk foreign key (participant_id) references public.raffle_participants(id) on delete restrict;
alter table public.raffles add constraint raffles_winner_participant_fk foreign key (winner_participant_id) references public.raffle_participants(id) on delete restrict;
create index raffle_participants_raffle_idx on public.raffle_participants(raffle_id, created_at desc);
create index raffle_participants_phone_idx on public.raffle_participants(phone_e164);
create index raffle_participants_status_idx on public.raffle_participants(raffle_id, payment_status, participation_status);

create table public.raffle_files (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete restrict,
  participant_id uuid references public.raffle_participants(id) on delete cascade,
  kind text not null check (kind in ('participant_photo','payment_receipt','winner_certificate')),
  storage_path text not null unique,
  content_type text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 5242880),
  created_at timestamptz not null default now()
);

create table public.raffle_audit_log (
  id bigint generated always as identity primary key,
  raffle_id uuid references public.raffles(id) on delete set null,
  participant_id uuid references public.raffle_participants(id) on delete set null,
  actor_id uuid references public.profiles(user_id) on delete set null,
  action text not null check (char_length(action) between 2 and 100),
  before_data jsonb not null default '{}'::jsonb,
  after_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index raffle_audit_log_raffle_idx on public.raffle_audit_log(raffle_id, created_at desc);

create table public.raffle_notifications (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.raffle_participants(id) on delete cascade,
  template_key text not null,
  channel text not null check (channel in ('whatsapp','email')),
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create or replace function public.raffle_touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$ begin new.updated_at = now(); return new; end; $$;
create trigger raffle_touch before update on public.raffles for each row execute procedure public.raffle_touch_updated_at();
create trigger raffle_participant_touch before update on public.raffle_participants for each row execute procedure public.raffle_touch_updated_at();

create or replace function public.seed_raffle_numbers() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.raffle_numbers(raffle_id, number)
  select new.id, value::smallint from generate_series(0, 99) as value;
  return new;
end; $$;
create trigger raffle_seed_numbers after insert on public.raffles for each row execute procedure public.seed_raffle_numbers();

create or replace function public.release_expired_raffle_reservations(p_raffle_id uuid default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare released integer;
begin
  with expired as (
    update public.raffle_reservations set state = 'expired'
    where state = 'active' and expires_at <= now() and (p_raffle_id is null or raffle_id = p_raffle_id)
    returning id, raffle_id
  ), freed as (
    update public.raffle_numbers n set state = 'available', reservation_id = null, updated_at = now()
    from expired e where n.raffle_id = e.raffle_id and n.reservation_id = e.id and n.state = 'reserved'
    returning n.number
  ) select count(*) into released from freed;
  return released;
end; $$;

create or replace function public.reserve_raffle_numbers(p_raffle_id uuid, p_numbers smallint[], p_fingerprint_hash text)
returns table(reservation_id uuid, reservation_code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare raffle_row public.raffles%rowtype; normalized smallint[]; new_id uuid := gen_random_uuid(); new_code text := encode(gen_random_bytes(12), 'hex'); expires timestamptz;
begin
  if p_raffle_id is null or coalesce(array_length(p_numbers, 1), 0) < 1 or coalesce(array_length(p_numbers, 1), 0) > 100 then raise exception 'invalid_numbers'; end if;
  select array_agg(distinct number order by number) into normalized from unnest(p_numbers) number where number between 0 and 99;
  if cardinality(normalized) <> cardinality(p_numbers) then raise exception 'invalid_numbers'; end if;
  perform pg_advisory_xact_lock(hashtext(p_raffle_id::text));
  perform public.release_expired_raffle_reservations(p_raffle_id);
  select * into raffle_row from public.raffles where id = p_raffle_id and archived_at is null for update;
  if not found or raffle_row.status <> 'active' or (raffle_row.starts_at is not null and raffle_row.starts_at > now()) or (raffle_row.closes_at is not null and raffle_row.closes_at <= now()) then raise exception 'raffle_unavailable'; end if;
  if cardinality(normalized) > raffle_row.max_numbers_per_participant then raise exception 'selection_limit'; end if;
  if (select count(*) from public.raffle_numbers where raffle_id = p_raffle_id and number = any(normalized) and state = 'available') <> cardinality(normalized) then raise exception 'numbers_unavailable'; end if;
  expires := now() + make_interval(mins => raffle_row.reservation_minutes);
  insert into public.raffle_reservations(id, raffle_id, reservation_code, numbers, expires_at, fingerprint_hash) values (new_id, p_raffle_id, new_code, normalized, expires, left(coalesce(p_fingerprint_hash,''), 128));
  update public.raffle_numbers set state = 'reserved', reservation_id = new_id, updated_at = now() where raffle_id = p_raffle_id and number = any(normalized) and state = 'available';
  return query select new_id, new_code, expires;
end; $$;

create or replace function public.finalize_raffle_participation(p_reservation_id uuid, p_reservation_code text, p_participant_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare reservation_row public.raffle_reservations%rowtype;
begin
  select * into reservation_row from public.raffle_reservations where id = p_reservation_id and reservation_code = p_reservation_code for update;
  if not found or reservation_row.state <> 'active' or reservation_row.expires_at <= now() then raise exception 'reservation_expired'; end if;
  if (select count(*) from public.raffle_numbers where raffle_id = reservation_row.raffle_id and reservation_id = reservation_row.id and state = 'reserved') <> cardinality(reservation_row.numbers) then raise exception 'reservation_invalid'; end if;
  update public.raffle_numbers set state = 'pending_validation', participant_id = p_participant_id, updated_at = now() where raffle_id = reservation_row.raffle_id and reservation_id = reservation_row.id and state = 'reserved';
  update public.raffle_reservations set state = 'submitted', submitted_at = now() where id = reservation_row.id;
end; $$;

create or replace function public.raffle_participant_numbers(p_participant_id uuid) returns smallint[]
language sql security definer set search_path = public, pg_temp as $$ select coalesce(array_agg(number order by number), '{}') from public.raffle_numbers where participant_id = p_participant_id; $$;

alter table public.raffles enable row level security;
alter table public.raffle_numbers enable row level security;
alter table public.raffle_reservations enable row level security;
alter table public.raffle_public_requests enable row level security;
alter table public.raffle_participants enable row level security;
alter table public.raffle_files enable row level security;
alter table public.raffle_audit_log enable row level security;
alter table public.raffle_notifications enable row level security;
revoke all on public.raffles, public.raffle_numbers, public.raffle_reservations, public.raffle_public_requests, public.raffle_participants, public.raffle_files, public.raffle_audit_log, public.raffle_notifications from anon, authenticated;
revoke all on function public.reserve_raffle_numbers(uuid, smallint[], text), public.finalize_raffle_participation(uuid, text, uuid), public.release_expired_raffle_reservations(uuid), public.raffle_participant_numbers(uuid) from public, anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('raffle-private', 'raffle-private', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
