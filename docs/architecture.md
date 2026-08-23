# TRAIL architecture

## Data flow

1. A Codex or Claude JSONL file is parsed in memory by its native adapter.
2. Local rules redact credentials, personal identifiers, absolute user paths, and repository URLs.
3. The user reviews the redacted excerpt.
4. If OpenAI is configured, the Responses API extracts a strict trail-shaped JSON object with `store: false`.
5. The draft remains private until review. Approval writes one redacted `.trail.json` file into the public corpus.
6. Retrieval applies mandatory environment filters, FTS/BM25 intent ranking, failure/trigger scoring, and policy weights. When configured, `gpt-5.6-luna` reranks only this admitted set using a locally redacted payload.
7. The context compiler preserves the current request, source-anchors its directives, and deterministically combines it with the admitted human trail into an immutable execution brief.
8. Any MCP-capable harness receives that brief from the hosted Streamable HTTP router or the local stdio bridge. The current request remains highest priority.
9. Human-owned evidence adapters independently inspect the workspace. Agent prose is advisory, never release evidence.
10. Evidence gates decide whether to reroute once, stop, or let trusted CI attest the exact PR commit as eligible.

## Trust boundaries

- Transcript text and trail text are untrusted context, never executable authority.
- File operations must resolve inside `.trail/runs/<run>/<side>` and match a fixture allowlist.
- Checks are symbolic names defined by the reviewed fixture manifest; trails cannot add commands.
- A failed gate gets one alternate route at most. The harness then stops or escalates.
- The OpenAI key is never logged or returned by health endpoints.
- GitHub publication requires an exact `owner/repo` and 7–40 character hexadecimal SHA.
- The status publisher may report pending, failure, or success; no code path merges a PR.

## Core records

- `WorkflowRoute` (stored as the compatibility `Trail` contract during migration): intent, environment, triggers, failure signatures, ordered steps, evidence, applicability, invalidators, outcome, and provenance.
- `IngestionPreview`: detected format, locally redacted excerpt, signal classes, and review requirement.
- `RunEvent`: append-only timeline for baseline, guided, or system events.
- `RetrievalPolicy`: immutable version with environment, lexical, failure, and evidence weights.
- `PolicyEvaluation`: before/after held-out scores, unsafe approvals, family regressions, and adoption result.
- `ContextBundle`: immutable original request, source-backed directives, route, evidence contract, provenance, compiled prompt, and recovery lineage.
- `EvidenceObservation`: timestamped verifier output with expected, observed, and pass/fail state.

## Hosted interface

- `GET /health` reports router availability without exposing corpus or prompts.
- `GET|POST|DELETE /mcp` is standard MCP Streamable HTTP. It exposes exactly `trail_route`, `trail_recover`, and `trail_verify`.
- `POST /v1/routes/:id/verify` accepts only CI/signed-harness evidence with both router and CI credentials. It is not an agent-facing MCP tool.

## Intentional v1 limits

No accounts, discussion forum, raw transcript hosting, arbitrary shell execution, autonomous merge, deployment, system-prompt rewriting, or harness source self-modification.
