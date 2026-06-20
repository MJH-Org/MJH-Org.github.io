-- Supabase setup for the quiz app.
-- Run this file in Supabase SQL Editor after creating the project.
-- Keep the service_role key out of frontend code. The browser only needs the
-- public anon/publishable key, and row-level security protects user data.

create table if not exists public.user_question_marks (
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_id text not null,
  question_id text not null,
  mark_type text not null check (mark_type in ('easy')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, subject_id, question_id, mark_type)
);

create index if not exists user_question_marks_lookup_idx
on public.user_question_marks (user_id, subject_id, mark_type);

grant usage on schema public to authenticated;
grant select, insert, update, delete
on public.user_question_marks
to authenticated;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_question_marks_updated_at
on public.user_question_marks;

create trigger set_user_question_marks_updated_at
before update on public.user_question_marks
for each row
execute function public.set_updated_at();

alter table public.user_question_marks enable row level security;

drop policy if exists "users can read own question marks"
on public.user_question_marks;

create policy "users can read own question marks"
on public.user_question_marks
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "users can insert own question marks"
on public.user_question_marks;

create policy "users can insert own question marks"
on public.user_question_marks
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "users can update own question marks"
on public.user_question_marks;

create policy "users can update own question marks"
on public.user_question_marks
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "users can delete own question marks"
on public.user_question_marks;

create policy "users can delete own question marks"
on public.user_question_marks
for delete
to authenticated
using (auth.uid() = user_id);
