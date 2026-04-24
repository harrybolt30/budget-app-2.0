create extension if not exists pgcrypto;

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  amount numeric not null,
  type text not null check (type in ('income', 'expense')),
  category_id uuid,
  description text not null,
  created_at timestamp default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null,
  emoji text not null,
  type text not null check (type in ('income', 'expense'))
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  target_amount numeric not null,
  current_amount numeric not null default 0,
  deadline date
);

create table if not exists public.goal_contributions (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  month int not null check (month between 1 and 12),
  year int not null,
  amount numeric not null
);

create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  theme text not null default 'light' check (theme in ('light', 'dark')),
  accent_color text not null default 'blue' check (accent_color in ('blue', 'green', 'purple'))
);

alter table public.transactions enable row level security;
alter table public.categories enable row level security;
alter table public.goals enable row level security;
alter table public.goal_contributions enable row level security;
alter table public.settings enable row level security;

create policy "Users can only read and write rows where user_id = auth.uid()" on public.transactions
for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Users can only read and write rows where user_id = auth.uid()" on public.categories
for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Users can only read and write rows where user_id = auth.uid()" on public.goals
for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Users can only read and write rows where user_id = auth.uid()" on public.settings
for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Users can only read and write rows where user_id = auth.uid()" on public.goal_contributions
for all
using (
  exists (
    select 1
    from public.goals
    where goals.id = goal_contributions.goal_id
      and goals.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.goals
    where goals.id = goal_contributions.goal_id
      and goals.user_id = auth.uid()
  )
);
