# PostgreSQL knowledge layer

TRAIL uses PostgreSQL as the shared, durable layer for reviewed human context. It is not a raw-transcript archive and it is not a place for an agent to write arbitrary memory.

## What belongs in the hosted database

- Approved, redacted trail contracts: intent, do-not constraints, ordered route, failure signatures, recovery edges, and required evidence.
- Redacted episodes that a human has explicitly approved for a collection.
- Immutable routing bundles with a request hash, environment fingerprint, selection/rejection reasons, and bounded recovery lineage.
- Harness or CI-attested verification observations and exact revision release status.
- Versioned retrieval policies and held-out evaluation results.

## What never leaves the laptop automatically

- Raw Codex or Claude transcripts.
- Secrets, private payloads, emails, phone numbers, local paths, repository URLs, or unredacted prompts.
- Agent prose as release evidence.
- Any draft trail before human approval.

## Local development

The migration is Supabase-compatible and can also run against the local PostgreSQL service:

```bash
createdb trail_knowledge
psql -d trail_knowledge -v ON_ERROR_STOP=1 -f supabase/migrations/20260823150000_trail_knowledge_layer.sql
node scripts/seed-postgres.mjs --database trail_knowledge
```

This seeds the reviewed public corpus only. It does not copy local sessions.

## Supabase deployment

Use a Supabase Postgres connection string only in the trusted router environment:

```bash
export TRAIL_POSTGRES_URL='postgresql://postgres.<project-ref>:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres'
npx supabase@latest link --project-ref PROJECT_REF
npx supabase@latest db push
node scripts/seed-postgres.mjs --url "$TRAIL_POSTGRES_URL"
```

The migration enables RLS. Anonymous and authenticated clients can read only approved public trails; browser and agent writes are denied. The hosted MCP router and CI retain their own credentials and are the only writers for bundles, observations, and release attestations.
