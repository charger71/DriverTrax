-- ============================================================
-- DriverTrax Web Push subscriptions
--
-- One row per (user, device). The endpoint is unique — re-subscribing
-- on the same device overwrites the row. The edge function reads from
-- this table, filtered by audience role, and POSTs to each endpoint.
--
-- Run in the Supabase SQL editor. Idempotent.
-- ============================================================

create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
create index if not exists push_subscriptions_role_idx on public.push_subscriptions (role);

alter table public.push_subscriptions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'own subs insert') then
    create policy "own subs insert" on public.push_subscriptions
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'own subs update') then
    create policy "own subs update" on public.push_subscriptions
      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'own subs delete') then
    create policy "own subs delete" on public.push_subscriptions
      for delete using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'push_subscriptions' and policyname = 'own subs select') then
    create policy "own subs select" on public.push_subscriptions
      for select using (auth.uid() = user_id);
  end if;
end$$;
