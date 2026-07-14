-- Privacy-friendly aggregate analytics for the public portfolio.
create table if not exists public.analytics_daily (
  metric_date date primary key,
  visits bigint not null default 0 check (visits >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.analytics_visitors_daily (
  metric_date date not null,
  fingerprint_hash text not null check (char_length(fingerprint_hash) = 64),
  visit_counted boolean not null default false,
  click_count integer not null default 0 check (click_count between 0 and 100),
  created_at timestamptz not null default now(),
  primary key (metric_date, fingerprint_hash)
);

alter table public.analytics_daily enable row level security;
alter table public.analytics_daily force row level security;
alter table public.analytics_visitors_daily enable row level security;
alter table public.analytics_visitors_daily force row level security;

revoke all on public.analytics_daily from anon, authenticated;
revoke all on public.analytics_visitors_daily from anon, authenticated;
grant select on public.analytics_daily to authenticated;

create policy "crm analytics read" on public.analytics_daily
for select to authenticated using (public.is_crm_member());
create policy "mfa required analytics" on public.analytics_daily
as restrictive for select to authenticated
using ((select auth.jwt() ->> 'aal') = 'aal2');

create or replace function public.record_site_event(p_fingerprint text, p_event_type text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  event_day date := (now() at time zone 'UTC')::date;
  changed_rows integer := 0;
  current_clicks integer := 0;
begin
  if p_fingerprint is null or char_length(p_fingerprint) <> 64 or p_event_type not in ('visit', 'click') then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(event_day::text || ':' || p_fingerprint, 0));
  delete from public.analytics_visitors_daily where metric_date < event_day - 7;
  insert into public.analytics_daily (metric_date) values (event_day) on conflict (metric_date) do nothing;

  if p_event_type = 'visit' then
    insert into public.analytics_visitors_daily (metric_date, fingerprint_hash, visit_counted)
    values (event_day, p_fingerprint, true)
    on conflict (metric_date, fingerprint_hash) do update
      set visit_counted = true
      where public.analytics_visitors_daily.visit_counted = false;
    get diagnostics changed_rows = row_count;
    if changed_rows > 0 then
      update public.analytics_daily set visits = visits + 1, updated_at = now() where metric_date = event_day;
    end if;
    return true;
  end if;

  insert into public.analytics_visitors_daily (metric_date, fingerprint_hash)
  values (event_day, p_fingerprint)
  on conflict (metric_date, fingerprint_hash) do nothing;
  select click_count into current_clicks
  from public.analytics_visitors_daily
  where metric_date = event_day and fingerprint_hash = p_fingerprint
  for update;
  if current_clicks >= 100 then
    return false;
  end if;
  update public.analytics_visitors_daily
    set click_count = click_count + 1
    where metric_date = event_day and fingerprint_hash = p_fingerprint;
  update public.analytics_daily set clicks = clicks + 1, updated_at = now() where metric_date = event_day;
  return true;
end;
$$;

revoke all on function public.record_site_event(text, text) from public, anon, authenticated;
grant execute on function public.record_site_event(text, text) to service_role;
