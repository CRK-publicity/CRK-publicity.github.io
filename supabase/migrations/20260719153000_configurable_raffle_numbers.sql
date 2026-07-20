-- Configurable numbered inventory (1..1000), enforced fail-closed in PostgreSQL.
alter table public.raffles add column if not exists number_count smallint not null default 100 check (number_count between 1 and 1000);
alter table public.raffle_numbers drop constraint if exists raffle_numbers_number_check;
alter table public.raffle_numbers add constraint raffle_numbers_number_check check (number between 0 and 999);

create or replace function public.seed_raffle_numbers() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.raffle_numbers(raffle_id, number) select new.id, value::smallint from generate_series(0, new.number_count - 1) value;
  return new;
end; $$;

create or replace function public.resize_raffle_numbers() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.number_count = old.number_count then return new; end if;
  if new.number_count < old.number_count and exists (select 1 from public.raffle_numbers where raffle_id = new.id and number >= new.number_count and state <> 'available') then
    raise exception 'raffle_numbers_in_use';
  end if;
  delete from public.raffle_numbers where raffle_id = new.id and number >= new.number_count and state = 'available';
  insert into public.raffle_numbers(raffle_id, number) select new.id, value::smallint from generate_series(old.number_count, new.number_count - 1) value on conflict do nothing;
  return new;
end; $$;
drop trigger if exists raffle_resize_numbers on public.raffles;
create trigger raffle_resize_numbers after update of number_count on public.raffles for each row execute procedure public.resize_raffle_numbers();

create or replace function public.reserve_raffle_numbers(p_raffle_id uuid, p_numbers smallint[], p_fingerprint_hash text)
returns table(reservation_id uuid, reservation_code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare raffle_row public.raffles%rowtype; normalized smallint[]; new_id uuid := gen_random_uuid(); new_code text := encode(gen_random_bytes(12), 'hex'); expires timestamptz;
begin
  if p_raffle_id is null or coalesce(array_length(p_numbers, 1), 0) < 1 or coalesce(array_length(p_numbers, 1), 0) > 100 then raise exception 'invalid_numbers'; end if;
  perform pg_advisory_xact_lock(hashtext(p_raffle_id::text)); perform public.release_expired_raffle_reservations(p_raffle_id);
  select * into raffle_row from public.raffles where id = p_raffle_id and archived_at is null for update;
  if not found or raffle_row.status <> 'active' or (raffle_row.starts_at is not null and raffle_row.starts_at > now()) or (raffle_row.closes_at is not null and raffle_row.closes_at <= now()) then raise exception 'raffle_unavailable'; end if;
  select array_agg(distinct number order by number) into normalized from unnest(p_numbers) number where number between 0 and raffle_row.number_count - 1;
  if cardinality(normalized) <> cardinality(p_numbers) or cardinality(normalized) > raffle_row.max_numbers_per_participant then raise exception 'invalid_numbers'; end if;
  if (select count(*) from public.raffle_numbers where raffle_id = p_raffle_id and number = any(normalized) and state = 'available') <> cardinality(normalized) then raise exception 'numbers_unavailable'; end if;
  expires := now() + make_interval(mins => raffle_row.reservation_minutes);
  insert into public.raffle_reservations(id, raffle_id, reservation_code, numbers, expires_at, fingerprint_hash) values (new_id, p_raffle_id, new_code, normalized, expires, left(coalesce(p_fingerprint_hash,''), 128));
  update public.raffle_numbers set state = 'reserved', reservation_id = new_id, updated_at = now() where raffle_id = p_raffle_id and number = any(normalized) and state = 'available';
  return query select new_id, new_code, expires;
end; $$;
revoke all on function public.reserve_raffle_numbers(uuid, smallint[], text) from public, anon, authenticated;
