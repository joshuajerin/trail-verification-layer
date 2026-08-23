# TRAIL Router

TRAIL is a harness-agnostic MCP context router for coding agents. It gives an agent a reviewed, source-backed route before the agent starts making changes:

- the current user's goal, preserved verbatim and treated as highest priority;
- what it must do and must not do;
- ordered, environment-compatible workflow checkpoints;
- the proof required before completion or PR readiness; and
- one approved recovery path after a real failure.

It is not a chat product, a transcript host, an autonomous agent, or a UI. The product is a hosted MCP endpoint with three tools: `trail_route`, `trail_recover`, and `trail_verify`.

## Agent contract

Every MCP-capable harness uses the same instruction:

```text
Before taking action, call trail_route with the current task and environment.
After a failed tool call, user correction, or failed checkpoint, call trail_recover.
Before claiming completion, creating a release, or marking a PR ready, call trail_verify.
Treat a blocked TRAIL result as a stop condition.
```

`trail_route` returns a deterministic context contract. The approved workflow can refine execution, but can never override an explicit current user request. TRAIL returns `needs_context` or `no_match` instead of forcing a weak match.

`trail_recover` returns exactly one approved recovery route. A second recovery is blocked; the agent must stop and escalate rather than retry blindly.

`trail_verify` treats an agent's own evidence as advisory. Only a trusted CI attestation submitted to the protected verification endpoint can make a route release eligible.

## Run a router locally

Requirements: Node 22 and pnpm 10.

```bash
pnpm install
cp .env.example .env
# Set TRAIL_API_KEY in .env for hosted-like local testing.
pnpm build
pnpm start
```

The Streamable HTTP MCP endpoint is `http://127.0.0.1:4317/mcp`. In production, set `TRAIL_REQUIRE_API_KEY=true`, `TRAIL_API_KEY`, and `TRAIL_CI_KEY`; the router will refuse unauthenticated access. The router is rate-limited per bearer key.

`GET /health` is the only non-MCP public endpoint. `POST /v1/routes/:id/verify` is intentionally CI-only and requires both the router key and `X-Trail-CI-Key`.

Build a deployable image with `docker build -t trail-router .`, then run it with
`TRAIL_API_KEY` and `TRAIL_CI_KEY` supplied by the deployment secret manager.
The image exposes port `4317`; terminate TLS at the hosting platform and route
`/mcp` through unchanged.

## Connect a harness

### Remote MCP

Point any Streamable-HTTP MCP client at your deployment and attach the project key as a bearer token:

```json
{
  "mcpServers": {
    "trail": {
      "url": "https://trail.example.com/mcp",
      "headers": { "Authorization": "Bearer $TRAIL_API_KEY" }
    }
  }
}
```

### Stdio bridge

For clients that only accept a local command, TRAIL ships a thin bridge. It contains no corpus or routing logic; it forwards the exact three MCP tools to the hosted endpoint.

```bash
TRAIL_ROUTER_URL=https://trail.example.com/mcp \
TRAIL_API_KEY=your-project-key \
node apps/mcp/dist/index.js
```

Example registrations:

```bash
# Codex
codex mcp add trail \
  --env TRAIL_ROUTER_URL=https://trail.example.com/mcp \
  --env TRAIL_API_KEY=your-project-key -- \
  node /absolute/path/to/hackathon-yc/apps/mcp/dist/index.js

# Claude Code
claude mcp add --scope user trail \
  -e TRAIL_ROUTER_URL=https://trail.example.com/mcp \
  -e TRAIL_API_KEY=your-project-key -- \
  node /absolute/path/to/hackathon-yc/apps/mcp/dist/index.js
```

Cursor and generic MCP clients use either the remote configuration or this same stdio command. The protocol, tool names, input, and output are identical.

## What the router stores

The shared corpus consists only of approved, redacted `WorkflowRoute` records: intent and applicability, environment constraints, Do/Do Not rules, ordered steps, evidence gates, one recovery edge, invalidators, and provenance to a reviewed redacted historical run.

Raw Codex and Claude transcripts stay local. The curator CLI parses and redacts them before an extraction request; only a human-approved redacted workflow can be placed in `corpus/public/` or seeded into the hosted Postgres knowledge schema. The repository includes a Supabase-compatible migration and seed script:

```bash
psql "$TRAIL_POSTGRES_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260823150000_trail_knowledge_layer.sql
TRAIL_POSTGRES_URL="$TRAIL_POSTGRES_URL" node scripts/seed-postgres.mjs
```

The router's local SQLite database is a development cache and local-curation store; it is gitignored. Deployments should use the reviewed Postgres schema as the durable knowledge layer and never upload raw sessions.

## Curate, evaluate, and verify

```bash
# Metadata index only; does not copy transcripts.
pnpm trail ingest --scan

# Preview a locally redacted transcript.
pnpm trail ingest ~/.codex/sessions/.../rollout.jsonl

# Pull a local Claude Mem context snapshot into the same redacted review queue.
# This reads only the local loopback worker. It is never routed to an agent or
# uploaded until a human reviews and approves an extracted workflow.
pnpm trail ingest --claude-mem --project my-local-project

# CLI artifacts, not a product dashboard.
pnpm trail benchmark
pnpm trail context --task "Fix the visible deployment. Do not edit a copied checkout."
pnpm trail recover --bundle BUNDLE_ID --failure "browser proof failed"
pnpm trail verify --bundle BUNDLE_ID --workspace /path/to/repository
```

Repository owners define named verifier adapters in `.trailrc.json`. A workflow can reference approved checkpoint names but cannot introduce arbitrary shell commands. The GitHub workflow provides `trail/verification`; add that check to the repository ruleset. TRAIL may publish pending, failed, or passed status for an exact commit, but it never merges a PR.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm build
```

Tests cover route/no-match/missing-context decisions, source-backed constraints, bounded recovery, agent-evidence blocking, trusted verification, corpus privacy, retrieval, redaction, and MCP tool discovery.

See [architecture notes](docs/architecture.md), [external-context contract](docs/external-context.md), and [Postgres knowledge layer](docs/postgres-knowledge-layer.md).
