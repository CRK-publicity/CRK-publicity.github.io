-- CMS writes and reads are intentionally mediated by authenticated Edge Functions.
-- Keeping these public-schema tables reachable through the browser would create a
-- second, unnecessary authorization path beside the owner + MFA backend check.

drop policy if exists "cms owners read site content" on public.site_content;
drop policy if exists "cms owners write site content" on public.site_content;
drop policy if exists "cms owners read services" on public.site_services;
drop policy if exists "cms owners write services" on public.site_services;
drop policy if exists "cms owners read media" on public.site_media;
drop policy if exists "cms owners write media" on public.site_media;
drop policy if exists "cms owners read payment methods" on public.payment_methods;
drop policy if exists "cms owners write payment methods" on public.payment_methods;
drop policy if exists "cms owners read publications" on public.site_publications;
drop policy if exists "cms owners read publication state" on public.site_publication_state;
drop policy if exists "cms owners read audit events" on public.site_audit_events;

-- Uploaded portfolio media also goes through site-media-upload.  The bucket is
-- private and public delivery happens only through short-lived signed URLs.
drop policy if exists "cms owners read site media objects" on storage.objects;
drop policy if exists "cms owners upload site media objects" on storage.objects;
drop policy if exists "cms owners update site media objects" on storage.objects;
drop policy if exists "cms owners delete site media objects" on storage.objects;

revoke all on table public.site_content from anon, authenticated;
revoke all on table public.site_services from anon, authenticated;
revoke all on table public.site_media from anon, authenticated;
revoke all on table public.payment_methods from anon, authenticated;
revoke all on table public.site_publications from anon, authenticated;
revoke all on table public.site_publication_state from anon, authenticated;
revoke all on table public.site_audit_events from anon, authenticated;
