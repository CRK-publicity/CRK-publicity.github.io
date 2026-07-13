create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'pending' check (role in ('pending','owner','agent')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_crm_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where user_id = auth.uid() and role in ('owner','agent'));
$$;
create or replace function public.is_crm_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where user_id = auth.uid() and role = 'owner');
$$;

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone_e164 text unique,
  email text,
  company text,
  source text not null default 'web',
  lifecycle_stage text not null default 'lead' check (lifecycle_stage in ('lead','qualified','proposal','customer','inactive')),
  consent_status text not null default 'pending' check (consent_status in ('pending','granted','revoked')),
  consent_at timestamptz,
  tags text[] not null default '{}',
  notes text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists contacts_email_unique on public.contacts(lower(email)) where email is not null;
create index if not exists contacts_stage_idx on public.contacts(lifecycle_stage, updated_at desc);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel text not null check (channel in ('web','whatsapp')),
  status text not null default 'open' check (status in ('open','bot','waiting','closed')),
  assigned_to uuid references public.profiles(user_id) on delete set null,
  unread_count integer not null default 0 check (unread_count >= 0),
  bot_state jsonb not null default '{}'::jsonb,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(contact_id, channel)
);
create index if not exists conversations_inbox_idx on public.conversations(status, last_message_at desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  provider_message_id text unique,
  direction text not null check (direction in ('inbound','outbound')),
  message_type text not null default 'text',
  body text,
  status text not null default 'received',
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_idx on public.messages(conversation_id, sent_at);

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  activity_type text not null,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists activities_contact_idx on public.activities(contact_id, created_at desc);

create table if not exists public.lead_requests (
  id bigint generated always as identity primary key,
  fingerprint_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists lead_requests_rate_idx on public.lead_requests(fingerprint_hash, created_at desc);

alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.activities enable row level security;
alter table public.lead_requests enable row level security;

create policy "profiles read self or owner" on public.profiles for select to authenticated using (user_id = auth.uid() or public.is_crm_owner());
create policy "owners update profiles" on public.profiles for update to authenticated using (public.is_crm_owner()) with check (public.is_crm_owner());
create policy "crm contacts read" on public.contacts for select to authenticated using (public.is_crm_member());
create policy "crm contacts insert" on public.contacts for insert to authenticated with check (public.is_crm_member());
create policy "crm contacts update" on public.contacts for update to authenticated using (public.is_crm_member()) with check (public.is_crm_member());
create policy "crm conversations read" on public.conversations for select to authenticated using (public.is_crm_member());
create policy "crm conversations insert" on public.conversations for insert to authenticated with check (public.is_crm_member());
create policy "crm conversations update" on public.conversations for update to authenticated using (public.is_crm_member()) with check (public.is_crm_member());
create policy "crm messages read" on public.messages for select to authenticated using (public.is_crm_member());
create policy "crm messages insert" on public.messages for insert to authenticated with check (public.is_crm_member());
create policy "crm activities read" on public.activities for select to authenticated using (public.is_crm_member());
create policy "crm activities insert" on public.activities for insert to authenticated with check (public.is_crm_member());

revoke all on public.lead_requests from anon, authenticated;
grant execute on function public.is_crm_member() to authenticated;
grant execute on function public.is_crm_owner() to authenticated;