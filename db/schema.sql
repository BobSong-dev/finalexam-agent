-- Production PostgreSQL schema for Finale Agent.
-- Use the application service account for writes; expose only scoped views/RLS
-- policies to authenticated clients. Shared copies deliberately have their own
-- object key so deleting a private original does not silently alter a valid
-- contribution during its authorized semester.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists vector;

create type material_status as enum ('queued', 'processing', 'analyzed', 'needs_review', 'failed', 'deleted');
create type share_status as enum ('pending', 'approved', 'review', 'blocked', 'unlisted', 'archived');
create type task_status as enum ('pending', 'completed', 'missed');
create type ledger_kind as enum ('contribution', 'quality_bonus', 'unlock', 'reversal', 'admin_adjustment');

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  display_name text not null,
  school_name text not null,
  school_verified_at timestamptz,
  timezone text not null default 'Asia/Shanghai',
  is_frozen boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  code text not null,
  teacher text not null,
  term text not null,
  exam_at timestamptz not null,
  priority smallint not null check (priority between 1 and 3),
  daily_minutes smallint not null default 120 check (daily_minutes between 15 and 720),
  created_at timestamptz not null default now(),
  unique (user_id, code, term, teacher)
);
create index courses_scope_idx on courses (user_id, code, term);

create table materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  object_key text not null unique,
  sha256 char(64) not null,
  page_count integer,
  status material_status not null default 'queued',
  processing_error text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index materials_user_course_idx on materials (user_id, course_id) where deleted_at is null;
create index materials_hash_idx on materials (sha256);

create table material_sources (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references materials(id) on delete cascade,
  page_number integer not null check (page_number > 0),
  source_type text not null check (source_type in ('page', 'slide', 'question', 'image_region')),
  locator jsonb not null default '{}'::jsonb,
  excerpt text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);
create index material_sources_material_idx on material_sources (material_id, page_number);

create table knowledge_mastery (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  knowledge_key text not null,
  title text not null,
  mastery numeric(5,2) not null default 50 check (mastery between 0 and 100),
  frequency integer not null default 0 check (frequency >= 0),
  last_practiced_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, course_id, knowledge_key)
);

create table study_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  knowledge_mastery_id uuid references knowledge_mastery(id) on delete set null,
  scheduled_at timestamptz not null,
  duration_minutes smallint not null check (duration_minutes between 5 and 240),
  task_type text not null check (task_type in ('review', 'practice', 'recall', 'mock')),
  status task_status not null default 'pending',
  plan_version integer not null default 1,
  reason jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index study_tasks_schedule_idx on study_tasks (user_id, scheduled_at) where status = 'pending';

create table assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  question_payload jsonb not null,
  answer_payload jsonb not null,
  score numeric(5,2),
  self_rating smallint check (self_rating between 1 and 5),
  created_at timestamptz not null default now()
);

create table shared_materials (
  id uuid primary key default gen_random_uuid(),
  contributor_id uuid not null references users(id) on delete restrict,
  school_name text not null,
  course_name text not null,
  course_code text not null,
  teacher text not null,
  term text not null,
  title text not null,
  mime_type text not null,
  shared_object_key text not null unique,
  preview_object_key text,
  sha256 char(64) not null,
  page_count integer,
  status share_status not null default 'pending',
  consented_at timestamptz not null,
  access_ends_on date not null,
  archive_requested_at timestamptz,
  moderation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shared_materials_catalog_idx on shared_materials (school_name, course_code, status, access_ends_on);
create unique index shared_materials_unique_active_hash on shared_materials (school_name, course_code, sha256) where status in ('pending', 'approved', 'review');

create table credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  amount integer not null check (amount <> 0),
  kind ledger_kind not null,
  shared_material_id uuid references shared_materials(id) on delete set null,
  idempotency_key text not null unique,
  description text not null,
  created_at timestamptz not null default now()
);
create index credit_ledger_user_created_idx on credit_ledger (user_id, created_at desc);

create table unlock_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  shared_material_id uuid not null references shared_materials(id) on delete cascade,
  credit_ledger_id uuid not null references credit_ledger(id) on delete restrict,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, shared_material_id)
);

create table shared_material_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references users(id) on delete cascade,
  shared_material_id uuid not null references shared_materials(id) on delete cascade,
  reason text not null,
  detail text,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz not null default now(),
  unique (reporter_id, shared_material_id)
);

-- RLS template for direct client access. The API's authenticated user id must be
-- made available as app.user_id for each transaction, or replaced by auth.uid()
-- when using an auth provider with compatible policies.
alter table courses enable row level security;
alter table materials enable row level security;
alter table material_sources enable row level security;
alter table knowledge_mastery enable row level security;
alter table study_tasks enable row level security;
alter table assessment_attempts enable row level security;
alter table credit_ledger enable row level security;
alter table unlock_grants enable row level security;

create policy course_owner_only on courses using (user_id = current_setting('app.user_id', true)::uuid);
create policy material_owner_only on materials using (user_id = current_setting('app.user_id', true)::uuid);
create policy mastery_owner_only on knowledge_mastery using (user_id = current_setting('app.user_id', true)::uuid);
create policy task_owner_only on study_tasks using (user_id = current_setting('app.user_id', true)::uuid);
create policy attempt_owner_only on assessment_attempts using (user_id = current_setting('app.user_id', true)::uuid);
create policy ledger_owner_only on credit_ledger using (user_id = current_setting('app.user_id', true)::uuid);
create policy grant_owner_only on unlock_grants using (user_id = current_setting('app.user_id', true)::uuid);
