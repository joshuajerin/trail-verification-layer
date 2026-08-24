# TRAIL

Trajectory Retrieval and Intent Alignment Layer: a runtime verification layer for coding agents.

TRAIL turns prior Codex and Claude trajectories into reviewed, machine-readable route contracts. It retrieves routes only when required environment fields match, then blocks progress and PR release until the contract's evidence exists.

## What works

- Native Codex and Claude JSONL adapters.
- A durable ingestion queue with local source discovery, batch upload, redaction review, and explicit `previewed → drafted → approved` promotion.
- A privacy-safe historical review manifest anchored to hashed, redacted record ranges from real local runs.
- Local redaction before any OpenAI request.
- Reviewed trail contracts with provenance, applicability, invalidators, actions, and evidence.
- SQLite FTS/BM25 retrieval with mandatory environment filtering, an optional final OpenAI reranker, and explained rejected near-matches.
- Deterministic paired hero harness plus a real OpenAI Responses tool loop using the same model on both sides.
- Disposable fixture workspaces with path-constrained reads/writes and named checks only.
- Hard environment, changed-scope, test, remote-ancestry, HTTP, browser, provider, and runtime gates.
- Immutable retrieval-policy proposals with accept-or-rollback evaluation.
- Real `trail/verification` GitHub Action job and commit-status CLI. TRAIL never merges.
- Live judge interface, corpus search, transcript review, benchmark results, and RSI policy screen.

## Run it

Requirements: Node 22 and pnpm 10.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The API runs at `http://127.0.0.1:4317`.

Open **Data intake** to scan local Codex/Claude history metadata, upload up to eight transcripts at a time, or load the checked-in sample run. Source scans keep only hashes, timestamps, sizes, and route signals; uploaded raw transcript text is parsed in memory and only its redacted review payload is retained. If an OpenAI key is not configured, start a guarded manual template instead; unresolved placeholders are rejected at the approval boundary.

Without `OPENAI_API_KEY`, deterministic proof and retrieval remain available, while extraction and live agent runs return an explicit unavailable state. Nothing is presented as live AI.

## CLI

```bash
# Hash and index local metadata/signals; raw transcripts are not copied.
pnpm trail ingest --scan

# Preview one transcript after local redaction.
pnpm trail ingest ~/.codex/sessions/.../rollout.jsonl

# Run the 8-task × 3-repeat × 2-condition fixture benchmark.
pnpm trail benchmark

# Run the paired deterministic hero scenario.
pnpm trail run

# Run the live K3/OpenAI-compatible domain evaluation: robotics, SaaS, and AI/ML.
# Each domain runs baseline and TRAIL-guided conditions from the same snapshot.
pnpm trail eval --repetitions 3

# Run the same controlled fixtures through real Codex CLI sessions.
# Baseline has no TRAIL server; guided must complete a stdio MCP context call.
pnpm --filter @trail/mcp build
pnpm trail eval-codex --repetitions 1 --api-base http://127.0.0.1:4317 --model gpt-5.6-terra

# Publish a real status for an exact commit after configuring a remote.
pnpm trail verify-pr \
  --repo owner/repository \
  --sha 0123456789abcdef \
  --state success \
  --description "All TRAIL evidence passed"
```

## CLI-first MCP session

TRAIL does not require its web app. Start the API in one terminal, then let Codex or Claude call the local stdio MCP server from another.

```bash
# Terminal 1: local API and SQLite state.
pnpm --filter @trail/api dev

# Terminal 2: build and exercise a source-backed execution context.
pnpm --filter @trail/mcp build
TRAIL_API_BASE=http://127.0.0.1:4317 pnpm --filter @trail/mcp start
```

Codex MCP configuration:

```json
{
  "mcpServers": {
    "trail": {
      "command": "node",
      "args": ["/absolute/path/to/trail-verification-layer/apps/mcp/dist/index.js"],
      "env": { "TRAIL_API_BASE": "http://127.0.0.1:4317" }
    }
  }
}
```

The MCP server exposes `trail_build_context`, `trail_recover`, `trail_verify`, and `trail_run_domain_evals`. The last tool runs the same real K3/OpenAI-compatible harness as `trail eval`; it returns observed gate results for robotics, SaaS, and AI/ML.

`trail eval-codex` is the agent-harness A/B. It launches isolated, ephemeral Codex CLI sessions with the same model, reasoning effort, six repository-action calls, task text, and starting commit. Only the guided condition receives the TRAIL stdio MCP server and an instruction to call `trail_build_context`; TRAIL calls are measured and reported separately rather than pretending context retrieval is free. The evaluator reruns human-owned fixture checks, inspects the Git diff, requires the expected reviewed trail, and treats agent prose as no evidence. Attempted calls that trigger the hard limit remain visible, and token averages exclude budget-terminated streams that never emit Codex's final usage event. Raw JSONL transcripts and reports stay under gitignored `.trail/evals/`.

## Quarantined research corpus

TRAIL can also build a metadata-only discovery index from the pinned SkillMD-138K source. These records never become instructions, installs, or runtime routes, and raw skill bodies are not stored in the index or returned by its API.

```bash
pnpm skills sync
pnpm skills index
pnpm skills status
pnpm skills search "browser verification" --max-risk medium
```

See [the corpus trust, provenance, and license notes](docs/skill-corpus.md). The compilation is CC-BY-4.0, but individual-file licenses are unresolved; every result remains quarantined and non-promotable.

The repository's GitHub workflow exposes a check named `trail/verification`. Configure that check as required in the repository ruleset to block merge until it passes.

## Current fixture benchmark

The checked-in benchmark is deterministic and intended to prove orchestration and gating, not model intelligence.

| Metric | Baseline | TRAIL-guided |
| --- | ---: | ---: |
| Verified tasks | 6/24 (25%) | 24/24 (100%) |
| Unsafe approvals | 12 | 0 |
| Retrieval Recall@1 | — | 23/24 (95.83%) |
| MRR | — | 0.9583 |

Live OpenAI results must be measured separately with the configured model and may not reuse these numbers.

## Live controlled domain evaluation

`trail eval` and the `trail_run_domain_evals` MCP tool run three purpose-built, executable failure families in parallel:

- Robotics: a firmware build is insufficient until serial/runtime sensor evidence is observed.
- SaaS: a local or preview change is insufficient until the unauthenticated production route is verified.
- AI/ML: a notebook fallback is insufficient until the serving provider returns an observed response.

For every pair, TRAIL holds the task, model, reasoning effort, six-call tool budget, and starting fixture constant. The guided side receives an approved human lesson with provenance; both sides must satisfy the same independent file-scope and named-check gates. Agent prose cannot pass a gate. Pair order is randomized, and the domains execute concurrently.

These are controlled fixtures designed to expose those failure modes. The screen distinguishes a live measured result from the evaluation target, and it explicitly says that small-sample results are not statistical significance or a broad model-performance claim. Live results are stored only under gitignored `.trail/evals/`.

## Privacy boundary

- Raw transcripts remain at their original paths and are never modified or copied.
- The local index stores only a path hash, provider, basename, size, modified timestamp, and route signals.
- Secrets, tokens, emails, phone numbers, personal paths, and repository URLs are redacted locally.
- OpenAI extraction and reranking use `store: false`; transcript extraction receives only the redacted excerpt and reranking receives redacted query fields plus approved trail metadata.
- Drafts and run databases live under gitignored `.trail/`.
- Only an explicitly approved trail is exported to `corpus/public/`.

See [the architecture notes](docs/architecture.md) for data flow and trust boundaries.
The checked-in [historical review manifest](corpus/reviews/historical-review-manifest.json) records the observed failure/recovery shapes that informed the seed corpus without publishing transcript text or local paths.
