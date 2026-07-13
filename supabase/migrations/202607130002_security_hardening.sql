-- Defense-in-depth for CRM data and public lead intake.
create index if not exists lead_requests_created_idx on public.lead_requests(created_at);

create or replace function public.check_lead_rate_limit(p_fingerprint text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_requests integer;
begin
  if p_fingerprint is null or char_length(p_fingerprint) <> 64 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_fingerprint, 0));
  delete from public.lead_requests where created_at < now() - interval '24 hours';
  select count(*) into recent_requests
  from public.lead_requests
  where fingerprint_hash = p_fingerprint
    and created_at >= now() - interval '15 minutes';

  if recent_requests >= 5 then
    return false;
  end if;

  insert into public.lead_requests (fingerprint_hash) values (p_fingerprint);
  return true;
end;
$$;

revoke all on function public.check_lead_rate_limit(text) from public, anon, authenticated;
grant execute on function public.check_lead_rate_limit(text) to service_role;

create or replace function public.set_record_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_record_updated_at() from public, anon, authenticated;
drop trigger if exists contacts_set_updated_at on public.contacts;
create trigger contacts_set_updated_at before update on public.contacts
for each row execute procedure public.set_record_updated_at();
drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at before update on public.conversations
for each row execute procedure public.set_record_updated_at();

alter table public.contacts
  add constraint contacts_text_limits check (
    char_length(full_name) between 2 and 100
    and (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{9,14}$')
    and (email is null or char_length(email) <= 180)
    and (company is null or char_length(company) <= 140)
    and (notes is null or char_length(notes) <= 5000)
  ) not valid;
alter table public.contacts validate constraint contacts_text_limits;

alter table public.messages
  add constraint messages_body_limit check (body is null or char_length(body) <= 4096) not valid;
alter table public.messages validate constraint messages_body_limit;

alter table public.activities
  add constraint activities_summary_limit check (char_length(summary) between 1 and 500) not valid;
alter table public.activities validate constraint activities_summary_limit;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.is_crm_member() from public, anon;
revoke all on function public.is_crm_owner() from public, anon;
grant execute on function public.is_crm_member() to authenticated;
grant execute on function public.is_crm_owner() to authenticated;

alter table public.profiles force row level security;
alter table public.contacts force row level security;
alter table public.conversations force row level security;
alter table public.messages force row level security;
alter table public.activities force row level security;
alter table public.lead_requests force row level security;

create policy "mfa required profiles" on public.profiles
as restrictive for all to authenticated
using ((select auth.jwt() ->> 'aal') = 'aal2')
with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy "mfa required contacts" on public.contacts
as restrictive for all to authenticated
using ((select auth.jwt() ->> 'aal') = 'aal2')
with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy "mfa required conversations" on public.conversations
as restrictive for all to authenticated
using ((select auth.jwt() ->> 'aal') = 'aal2')
with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy "mfa required messages" on public.messages
as restrictive for all to authenticated
using ((select auth.jwt() ->> 'aal') = 'aal2')
with check ((select auth.jwt() ->> 'aal') = 'aal2');
create policy "mfa required activities" on public.activities
as restrictive for all to authenticated
using ((select auth.jwt() ->> 'aal') = 'aal2')
with check ((select auth.jwt() ->> 'aal') = 'aal2');