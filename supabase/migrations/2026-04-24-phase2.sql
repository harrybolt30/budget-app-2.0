alter table public.transactions
  add column if not exists notes text,
  add column if not exists split_group_id uuid;

alter table public.settings
  add column if not exists currency text not null default 'CAD';

alter table public.settings
  drop constraint if exists settings_currency_check;

alter table public.settings
  add constraint settings_currency_check
  check (currency in ('CAD', 'USD', 'AUD', 'EUR', 'GBP'));

create table if not exists public.recurring_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  description text not null,
  amount numeric not null,
  type text not null check (type in ('income', 'expense')),
  category_id uuid references public.categories(id) on delete set null,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly')),
  next_date date not null,
  active boolean not null default true,
  created_at timestamp default now()
);

create table if not exists public.category_budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  monthly_limit numeric not null,
  unique (user_id, category_id)
);

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  amount numeric not null,
  due_date date not null,
  category_id uuid references public.categories(id) on delete set null,
  paid boolean not null default false,
  created_at timestamp default now()
);

alter table public.recurring_transactions enable row level security;
alter table public.category_budgets enable row level security;
alter table public.bills enable row level security;

drop policy if exists "Users can only read and write rows where user_id = auth.uid()" on public.recurring_transactions;
create policy "Users can only read and write rows where user_id = auth.uid()" on public.recurring_transactions
for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Users can only read and write rows where user_id = auth.uid()" on public.category_budgets;
create policy "Users can only read and write rows where user_id = auth.uid()" on public.category_budgets
for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Users can only read and write rows where user_id = auth.uid()" on public.bills;
create policy "Users can only read and write rows where user_id = auth.uid()" on public.bills
for all using (user_id = auth.uid()) with check (user_id = auth.uid());
