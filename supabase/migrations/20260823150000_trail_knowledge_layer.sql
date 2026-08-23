-- TRAIL's hosted knowledge and verification layer.
-- Raw Codex/Claude transcripts, local paths, secrets, and private SQLite data
-- never belong in this database. Only redacted, reviewed knowledge can be
-- published here.

create extension if not exists pgcrypto;

create table if not exists knowledge_collections (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null,
  visibility text not null check (visibility in ('public', 'private')),
  owner_subject text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists knowledge_trails (
  id text primary key,
  collection_id uuid not null references knowledge_collections(id) on delete cascade,
  schema_version text not null,
  title text not null,
  summary text not null,
  task_family text not null,
  intent text not null,
  environment jsonb not null default '{}'::jsonb,
  provenance jsonb not null,
  contract jsonb not null,
  review_status text not null check (review_status in ('draft', 'approved', 'rejected')),
  redacted boolean not null default true check (redacted),
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  contract_sha256 text not null check (contract_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists trail_directives (
  id uuid primary key default gen_random_uuid(),
  trail_id text not null references knowledge_trails(id) on delete cascade,
  directive_type text not null check (directive_type in ('precondition', 'negative_constraint', 'applicability', 'invalidator', 'outcome')),
  directive_text text not null,
  source_kind text not null default 'approved_trail' check (source_kind = 'approved_trail'),
  source_range text not null,
  ordinal integer not null check (ordinal >= 0),
  unique (trail_id, directive_type, ordinal)
);

create table if not exists trail_workflow_steps (
  id uuid primary key default gen_random_uuid(),
  trail_id text not null references knowledge_trails(id) on delete cascade,
  step_id text not null,
  ordinal integer not null check (ordinal >= 0),
  action text not null,
  tool text not null check (tool in ('inspect', 'read', 'write', 'check', 'verify', 'escalate')),
  on_failure text not null check (on_failure in ('reroute', 'stop', 'escalate')),
  unique (trail_id, step_id),
  unique (trail_id, ordinal)
);

create table if not exists trail_evidence_gates (
  id uuid primary key default gen_random_uuid(),
  trail_id text not null references knowledge_trails(id) on delete cascade,
  step_id text not null,
  evidence_id text not null,
  evidence_kind text not null check (evidence_kind in ('environment', 'changed_scope', 'test', 'remote_ancestry', 'http', 'browser', 'provider', 'runtime')),
  description text not null,
  expected text not null,
  required boolean not null default true,
  unique (trail_id, evidence_id)
);

create table if not exists trajectory_episodes (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references knowledge_collections(id) on delete cascade,
  provider text not null check (provider in ('codex', 'claude', 'community', 'benchmark')),
  source_hash text not null check (source_hash ~ '^[a-f0-9]{8,128}$'),
  source_range text not null,
  redacted_excerpt text not null,
  selected_reason text not null,
  review_status text not null check (review_status in ('draft', 'approved', 'rejected')),
  raw_transcript_local_only boolean not null default true check (raw_transcript_local_only),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (collection_id, source_hash, source_range)
);

-- A bundle has an immutable public-safe fingerprint. The original prompt stays
-- on the agent's device unless a human explicitly redacts and publishes it.
create table if not exists route_bundles (
  id uuid primary key,
  collection_id uuid not null references knowledge_collections(id) on delete cascade,
  parent_id uuid references route_bundles(id),
  status text not null check (status in ('ready', 'no_applicable_trail', 'needs_environment', 'blocked')),
  trigger text not null check (trigger in ('start', 'failure', 'release')),
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  redacted_request text,
  environment jsonb not null default '{}'::jsonb,
  compiled_context text,
  recovery_count integer not null default 0 check (recovery_count between 0 and 1),
  created_at timestamptz not null default now()
);

create table if not exists routing_decisions (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references route_bundles(id) on delete cascade,
  trail_id text references knowledge_trails(id) on delete set null,
  decision text not null check (decision in ('selected', 'rejected')),
  rank integer,
  score numeric(8,5),
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (bundle_id, trail_id, decision)
);

create table if not exists verification_observations (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references route_bundles(id) on delete cascade,
  evidence_id text not null,
  verifier text not null,
  attestation text not null check (attestation in ('agent', 'harness', 'ci')),
  expected text not null,
  observed text not null,
  passed boolean not null,
  revision text,
  observed_at timestamptz not null default now()
);

create table if not exists verification_releases (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references route_bundles(id) on delete restrict,
  repository text not null,
  revision text not null,
  status_context text not null default 'trail/verification',
  state text not null check (state in ('pending', 'success', 'failure')),
  release_eligible boolean not null,
  published_at timestamptz not null default now(),
  unique (repository, revision, status_context)
);

create table if not exists routing_policy_versions (
  id text primary key,
  collection_id uuid not null references knowledge_collections(id) on delete cascade,
  version integer not null check (version > 0),
  parent_id text,
  status text not null check (status in ('candidate', 'active', 'rejected')),
  weights jsonb not null,
  rationale text not null,
  created_at timestamptz not null default now(),
  unique (collection_id, version)
);

create table if not exists policy_evaluations (
  id uuid primary key default gen_random_uuid(),
  policy_id text not null references routing_policy_versions(id) on delete cascade,
  fixture_label text not null,
  metrics jsonb not null,
  unsafe_approvals integer not null check (unsafe_approvals >= 0),
  regressions jsonb not null default '[]'::jsonb,
  accepted boolean not null,
  evaluated_at timestamptz not null default now()
);

create table if not exists knowledge_syncs (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references knowledge_collections(id) on delete cascade,
  source text not null,
  summary jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_trails_catalog_idx on knowledge_trails (collection_id, review_status, published_at desc);
create index if not exists knowledge_trails_environment_idx on knowledge_trails using gin (environment);
create index if not exists knowledge_trails_contract_idx on knowledge_trails using gin (contract jsonb_path_ops);
create index if not exists trail_directives_text_idx on trail_directives using gin (to_tsvector('english', directive_text));
create index if not exists trajectory_episodes_review_idx on trajectory_episodes (collection_id, review_status, created_at desc);
create index if not exists routing_decisions_bundle_idx on routing_decisions (bundle_id, decision, rank);
create index if not exists verification_observations_bundle_idx on verification_observations (bundle_id, observed_at desc);

create or replace view agent_safe_trails with (security_invoker = true) as
select
  trail.id,
  trail.title,
  trail.summary,
  trail.task_family,
  trail.intent,
  trail.environment,
  trail.provenance,
  trail.contract,
  trail.confidence,
  trail.published_at
from knowledge_trails trail
join knowledge_collections collection on collection.id = trail.collection_id
where trail.review_status = 'approved'
  and trail.redacted = true
  and collection.visibility = 'public';

-- Supabase clients may only read approved public trails. Writes are restricted
-- to the trusted router/service role, never a browser or coding agent.
alter table knowledge_collections enable row level security;
alter table knowledge_trails enable row level security;
alter table trail_directives enable row level security;
alter table trail_workflow_steps enable row level security;
alter table trail_evidence_gates enable row level security;
alter table trajectory_episodes enable row level security;
alter table route_bundles enable row level security;
alter table routing_decisions enable row level security;
alter table verification_observations enable row level security;
alter table verification_releases enable row level security;
alter table routing_policy_versions enable row level security;
alter table policy_evaluations enable row level security;
alter table knowledge_syncs enable row level security;

drop policy if exists "read approved public collections" on knowledge_collections;
create policy "read approved public collections" on knowledge_collections for select using (visibility = 'public');
drop policy if exists "read approved public trails" on knowledge_trails;
create policy "read approved public trails" on knowledge_trails for select using (
  review_status = 'approved' and redacted = true and exists (
    select 1 from knowledge_collections collection
    where collection.id = knowledge_trails.collection_id and collection.visibility = 'public'
  )
);
drop policy if exists "read public trail directives" on trail_directives;
create policy "read public trail directives" on trail_directives for select using (
  exists (select 1 from knowledge_trails trail join knowledge_collections collection on collection.id = trail.collection_id where trail.id = trail_directives.trail_id and trail.review_status = 'approved' and collection.visibility = 'public')
);
drop policy if exists "read public trail steps" on trail_workflow_steps;
create policy "read public trail steps" on trail_workflow_steps for select using (
  exists (select 1 from knowledge_trails trail join knowledge_collections collection on collection.id = trail.collection_id where trail.id = trail_workflow_steps.trail_id and trail.review_status = 'approved' and collection.visibility = 'public')
);
drop policy if exists "read public trail evidence" on trail_evidence_gates;
create policy "read public trail evidence" on trail_evidence_gates for select using (
  exists (select 1 from knowledge_trails trail join knowledge_collections collection on collection.id = trail.collection_id where trail.id = trail_evidence_gates.trail_id and trail.review_status = 'approved' and collection.visibility = 'public')
);

-- Supabase creates `anon` and `authenticated`; local PostgreSQL does not.
-- Apply grants only when those roles exist so local development remains usable.
do $$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on all tables in schema public from %I', role_name);
      execute format('grant select on knowledge_collections, knowledge_trails, trail_directives, trail_workflow_steps, trail_evidence_gates to %I', role_name);
      execute format('grant select on agent_safe_trails to %I', role_name);
    end if;
  end loop;
end $$;
