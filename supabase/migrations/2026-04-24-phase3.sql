alter table public.settings
  add column if not exists payday_frequency text not null default 'monthly',
  add column if not exists payday_anchor_date date,
  add column if not exists payday_day_of_month int,
  add column if not exists safety_amount numeric not null default 0;

alter table public.settings
  drop constraint if exists settings_payday_frequency_check;

alter table public.settings
  add constraint settings_payday_frequency_check
  check (payday_frequency in ('monthly', 'weekly', 'biweekly'));

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  merchant_key text not null,
  name text not null,
  amount numeric not null,
  frequency text not null check (frequency in ('weekly', 'monthly')),
  category_id uuid references public.categories(id) on delete set null,
  status text not null default 'confirmed' check (status in ('pending', 'confirmed', 'ignored')),
  source text not null default 'manual' check (source in ('manual', 'detected')),
  last_charged_date date,
  created_at timestamp default now(),
  unique (user_id, merchant_key)
);

create table if not exists public.transaction_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  amount numeric not null,
  type text not null check (type in ('income', 'expense')),
  category_id uuid references public.categories(id) on delete set null,
  notes text,
  created_at timestamp default now()
);

alter table public.subscriptions enable row level security;
alter table public.transaction_templates enable row level security;

drop policy if exists "Users can only read and write rows where user_id = auth.uid()" on public.subscriptions;
create policy "Users can only read and write rows where user_id = auth.uid()" on public.subscriptions
for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Users can only read and write rows where user_id = auth.uid()" on public.transaction_templates;
create policy "Users can only read and write rows where user_id = auth.uid()" on public.transaction_templates
for all using (user_id = auth.uid()) with check (user_id = auth.uid());
