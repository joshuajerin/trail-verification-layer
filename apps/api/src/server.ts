import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { ContextCompileRequestSchema, ContextVerifyRequestSchema, RetrievalRequestSchema, TrailSchema } from "@trail/contracts";
import { loadActiveGeneration, loadSourceManifest } from "@trail/skill-corpus";
import { config, preflight } from "./config.js";
import { TrailDatabase } from "./database.js";
import { createManualTrailDraft, previewTranscript } from "./adapters.js";
import { extractTrail, OpenAiUnavailableError, rerankTrails } from "./openai.js";
import { loadCorpus, publishTrail } from "./corpus.js";
import { retrieveTrails } from "./retrieval.js";
import { HarnessService } from "./harness.js";
import { ensureActivePolicy, evaluatePolicy, proposePolicy } from "./policy.js";
import { indexLocalSources } from "./source-index.js";
import { SkillIngestionService } from "./skill-ingestion.js";
import { runBenchmark } from "./benchmark.js";
import { compileContext, recoverContext } from "./context.js";
import { verifyContext } from "./verification.js";
import { getDomainEvalSetup, runDomainEvals, saveDomainEvalResult } from "./domain-evals.js";

mkdirSync(config.corpusPath, { recursive: true });
export const db = new TrailDatabase(config.databasePath);
const corpusCount = loadCorpus(db);
ensureActivePolicy(db);
const harness = new HarnessService(db);
export const skillIngestions = new SkillIngestionService(db);

export const app = Fastify({ logger: true, bodyLimit: 16 * 1024 * 1024 });
await app.register(cors, { origin: [config.allowedOrigin, "http://localhost:4173"] });

app.get("/api/health", async () => ({ status: "ok", corpusCount: db.getTrails().length || corpusCount, ...preflight(), sourceIndex: db.sourceSummary() }));
app.get("/api/trails", async () => ({ trails: db.getTrails() }));
app.get("/api/policies", async () => ({ policies: db.getPolicies(), active: db.getActivePolicy() }));
app.get("/api/sources", async () => ({ ...db.sourceSummary(), shortlist: db.sourceCandidates(), roots: preflight().sourceRoots }));
app.get("/api/research-corpus", async () => {
  const source = loadSourceManifest();
  const active = loadActiveGeneration();
  const stats = active ? JSON.parse(readFileSync(join(active.directory, active.manifest.stats.file), "utf8")) as Record<string, unknown> : null;
  return {
    status: active ? "ready" : "not-indexed",
    source: {
      id: source.id,
      dataset: source.dataset,
      revision: source.revision,
      expectedRows: source.rows,
      compilationLicense: source.compilationLicense,
      itemLicensePolicy: source.itemLicensePolicy,
      trustTier: source.trustTier,
    },
    stats,
    safety: { executable: false, promotable: false, rawBodiesReturnedByApi: false, automaticPromotion: false },
  };
});
app.get("/api/ingestions", async () => ({ ingestions: db.listIngestions() }));
app.get("/api/ingestions/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const ingestion = db.getIngestion(id);
  return ingestion ?? reply.code(404).send({ error: "Ingestion not found" });
});
app.get("/api/runs/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const run = db.getRun(id);
  return run ? { run, events: db.getRunEvents(id) } : reply.code(404).send({ error: "Run not found" });
});

app.post("/api/sources/index", async () => ({ ...indexLocalSources(db), roots: preflight().sourceRoots }));

app.post("/api/ingestions/sample", async () => {
  const path = join(config.benchmarkPath, "fixtures", "sample-codex.jsonl");
  const preview = previewTranscript("sample-codex.jsonl", readFileSync(path, "utf8"));
  db.saveIngestion(preview);
  return preview;
});

app.get("/api/skill-ingestions/latest", async () => ({ job: skillIngestions.latest() }));

app.get("/api/skill-ingestions/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const job = skillIngestions.get(id);
  return job ? { job } : reply.code(404).send({ error: "Skill ingestion not found" });
});

app.post("/api/skill-ingestions", async (request, reply) => {
  const body = (request.body ?? {}) as { rootPath?: string; expectedTotal?: number };
  if (!body.rootPath?.trim()) return reply.code(400).send({ error: "rootPath is required" });
  if (body.expectedTotal !== undefined && (!Number.isFinite(body.expectedTotal) || body.expectedTotal < 1 || body.expectedTotal > 10_000_000)) {
    return reply.code(400).send({ error: "expectedTotal must be between 1 and 10,000,000" });
  }
  try {
    const job = await skillIngestions.start(body.rootPath, body.expectedTotal);
    return reply.code(202).send({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start SKILL.md ingestion.";
    return reply.code(message.includes("already running") ? 409 : 400).send({ error: message });
  }
});

app.get("/api/skill-ingestions/:id/events", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!skillIngestions.get(id)) return reply.code(404).send({ error: "Skill ingestion not found" });
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": config.allowedOrigin });
  let previous = "";
  const emit = () => {
    const job = skillIngestions.get(id);
    if (!job) return;
    const payload = JSON.stringify(job);
    if (payload !== previous) {
      reply.raw.write(`data: ${payload}\n\n`);
      previous = payload;
    }
    if (job.status !== "scanning") {
      reply.raw.write(`event: complete\ndata: ${payload}\n\n`);
      clearInterval(interval);
      reply.raw.end();
    }
  };
  const interval = setInterval(emit, 150);
  emit();
  request.raw.on("close", () => clearInterval(interval));
});

app.post("/api/ingestions/preview", async (request, reply) => {
  const body = request.body as { sourceName?: string; text?: string };
  if (!body?.sourceName || !body?.text) return reply.code(400).send({ error: "sourceName and text are required" });
  const preview = previewTranscript(body.sourceName, body.text);
  db.saveIngestion(preview);
  return preview;
});

app.post("/api/ingestions/:id/extract", async (request, reply) => {
  const { id } = request.params as { id: string };
  const ingestion = db.getIngestion(id);
  if (!ingestion) return reply.code(404).send({ error: "Ingestion not found" });
  try {
    const trail = await extractTrail(ingestion);
    db.upsertTrail(trail);
    db.markIngestionDrafted(id, trail.id);
    return { trail, liveAi: true };
  } catch (error) {
    if (error instanceof OpenAiUnavailableError) return reply.code(503).send({ error: error.message, missing: ["OPENAI_API_KEY"], liveAi: false });
    throw error;
  }
});

app.post("/api/ingestions/:id/draft-template", async (request, reply) => {
  const { id } = request.params as { id: string };
  const ingestion = db.getIngestion(id);
  if (!ingestion) return reply.code(404).send({ error: "Ingestion not found" });
  const trail = createManualTrailDraft(ingestion);
  db.upsertTrail(trail);
  db.markIngestionDrafted(id, trail.id);
  return { trail, liveAi: false };
});

app.post("/api/trails/:id/approve", async (request, reply) => {
  const { id } = request.params as { id: string };
  const draft = TrailSchema.parse(request.body);
  if (draft.id !== id) return reply.code(400).send({ error: "Trail id does not match route" });
  const serialized = JSON.stringify(draft);
  if (draft.tags.includes("manual-template") || serialized.includes("Replace this template") || serialized.includes("Replace with an exact expected value")) {
    return reply.code(422).send({ error: "Replace every manual-template placeholder and remove the manual-template tag before approval." });
  }
  const published = publishTrail(db, draft);
  db.markIngestionApproved(published.trail.id);
  return published;
});

app.post("/api/retrieve", async (request) => {
  const parsed = RetrievalRequestSchema.parse(request.body);
  const result = retrieveTrails(db, parsed, db.getActivePolicy());
  if (!config.openAiKey || result.matches.length < 2) {
    return { ...result, policy: db.getActivePolicy(), rerankedByOpenAi: false };
  }
  try {
    const matches = await rerankTrails(parsed, result.matches);
    return { ...result, matches, policy: db.getActivePolicy(), rerankedByOpenAi: true };
  } catch (error) {
    return {
      ...result,
      policy: db.getActivePolicy(),
      rerankedByOpenAi: false,
      rerankerError: error instanceof Error ? error.message : "OpenAI reranker failed.",
    };
  }
});

app.post("/api/context/compile", async (request) => {
  const parsed = ContextCompileRequestSchema.parse(request.body);
  return compileContext(db, parsed);
});

app.get("/api/context/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const bundle = db.getContextBundle(id);
  return bundle ? { bundle, observations: db.getEvidenceObservations(id) } : reply.code(404).send({ error: "Context bundle not found" });
});

app.post("/api/context/:id/recover", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = (request.body ?? {}) as { failure?: string; evidenceState?: Record<string, boolean> };
  const bundle = db.getContextBundle(id);
  if (!bundle) return reply.code(404).send({ error: "Context bundle not found" });
  if (!body.failure?.trim()) return reply.code(400).send({ error: "failure is required" });
  return recoverContext(db, bundle, body.failure.trim(), body.evidenceState ?? {});
});

app.post("/api/context/:id/verify", async (request, reply) => {
  const { id } = request.params as { id: string };
  const bundle = db.getContextBundle(id);
  if (!bundle) return reply.code(404).send({ error: "Context bundle not found" });
  const parsed = ContextVerifyRequestSchema.parse(request.body);
  return verifyContext(db, bundle, parsed.workspace, parsed.adapters);
});

app.post("/api/runs", async (request, reply) => {
  const body = (request.body ?? {}) as { executor?: string; speedMs?: number };
  if (body.executor === "openai-responses") {
    const readiness = preflight();
    if (!readiness.liveAi) return reply.code(503).send({ error: `Live AI is unavailable: ${readiness.missing.join(", ")}.`, liveAi: false, missing: readiness.missing });
    return reply.code(202).send(harness.startOpenAiPairedRun());
  }
  return reply.code(202).send(harness.startPairedRun(body.speedMs ?? 170));
});

app.get("/api/runs/:id/events", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!db.getRun(id)) return reply.code(404).send({ error: "Run not found" });
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": config.allowedOrigin });
  let sequence = -1;
  const interval = setInterval(() => {
    const events = db.getRunEvents(id, sequence);
    for (const event of events) {
      sequence = event.sequence;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    const run = db.getRun(id);
    if (run && run.status !== "running") {
      reply.raw.write(`event: complete\ndata: ${JSON.stringify(run)}\n\n`);
      clearInterval(interval);
      reply.raw.end();
    }
  }, 120);
  request.raw.on("close", () => clearInterval(interval));
});

app.post("/api/policies/propose", async (request) => {
  const body = (request.body ?? {}) as { reason?: string; weights?: Record<string, number> };
  return { policy: proposePolicy(db, body.reason ?? "Increase environment fidelity after a wrong-checkout failure", body.weights) };
});

app.post("/api/policies/:id/evaluate", async (request, reply) => {
  const { id } = request.params as { id: string };
  const policy = db.getPolicies().find((item) => item.id === id);
  if (!policy) return reply.code(404).send({ error: "Policy not found" });
  return evaluatePolicy(db, policy, request.body as never);
});

app.post("/api/benchmarks/run", async () => runBenchmark(db));
app.get("/api/evals/domains", async () => getDomainEvalSetup());
app.post("/api/evals/domains/run", async (request, reply) => {
  const readiness = preflight();
  if (!readiness.liveAi) return reply.code(503).send({ error: `Live AI is unavailable: ${readiness.missing.join(", ")}.` });
  const repetitions = Number((request.body as { repetitions?: number } | undefined)?.repetitions ?? 3);
  const result = await runDomainEvals(db, repetitions);
  saveDomainEvalResult(result);
  return result;
});

app.setErrorHandler((error, _request, reply) => {
  const typed = error as Error & { issues?: unknown };
  const status = typed.issues ? 400 : 500;
  reply.code(status).send({ error: typed.message, issues: typed.issues });
});

if (process.env.NODE_ENV !== "test") {
  await app.listen({ port: config.port, host: "127.0.0.1" });
}
