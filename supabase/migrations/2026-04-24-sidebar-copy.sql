alter table public.settings
  add column if not exists sidebar_title text not null default 'Your money, in motion.',
  add column if not exists sidebar_description text not null default 'Track spending, protect goals, stay ahead of bills, and keep your monthly plan simple.';
