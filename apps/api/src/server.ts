import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ContextVerifyRequestSchema } from "@trail/contracts";
import { config, preflight } from "./config.js";
import { loadCorpus } from "./corpus.js";
import { TrailDatabase } from "./database.js";
import { createTrailMcpServer } from "./mcp-server.js";
import { ensureActivePolicy } from "./policy.js";
import { HostedPostgresStore } from "./hosted-store.js";
import { verifyReportedEvidence } from "./verification.js";

mkdirSync(config.corpusPath, { recursive: true });
export const db = new TrailDatabase(config.databasePath);
loadCorpus(db);
ensureActivePolicy(db);
export const hostedStore = await HostedPostgresStore.connect(config.postgresUrl);
if (process.env.NODE_ENV === "production" && !hostedStore) throw new Error("TRAIL_POSTGRES_URL is required in production; do not run the shared router on local SQLite.");
if (hostedStore) await hostedStore.hydrateApprovedRoutes(db);

export const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
await app.register(rateLimit, {
  global: false,
  max: config.rateLimitMax,
  timeWindow: config.rateLimitWindow,
  keyGenerator: (request) => String(request.headers.authorization ?? request.ip),
});

function secureEqual(left: string, right: string) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function bearer(request: { headers: Record<string, string | string[] | undefined> }) {
  const value = request.headers.authorization;
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.replace(/^Bearer\s+/i, "") ?? "";
}

function routerAuthorized(request: { headers: Record<string, string | string[] | undefined> }) {
  if (!config.requireApiKey) return true;
  return config.apiKey ? secureEqual(bearer(request), config.apiKey) : false;
}

function ciAuthorized(request: { headers: Record<string, string | string[] | undefined> }) {
  const value = request.headers["x-trail-ci-key"];
  return config.ciKey && secureEqual(Array.isArray(value) ? value[0] ?? "" : value ?? "", config.ciKey);
}

app.get("/health", async () => ({
  status: "ok",
  transport: "streamable-http",
  corpusCount: db.getTrails().length,
  ...preflight(),
}));

app.route({
  method: ["GET", "POST", "DELETE"],
  url: "/mcp",
  config: { rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindow } },
  handler: async (request, reply) => {
    if (!routerAuthorized(request)) {
      return reply.code(config.apiKey ? 401 : 503).send({ error: config.apiKey ? "Unauthorized TRAIL API key." : "TRAIL_API_KEY is required in hosted mode." });
    }
    // Stateless transport keeps the hosted router horizontally scalable. Route
    // state is persisted as immutable bundles in the database, never in an MCP
    // connection or the agent's process.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
    const server = createTrailMcpServer(db, {
      routeSessionTtlMs: config.routeSessionTtlMs,
      privateHistory: config.privateHistory,
      ...(hostedStore ? {
        persistBundle: (bundle: Parameters<typeof hostedStore.recordBundle>[0]) => hostedStore.recordBundle(bundle),
        persistObservations: (observations: Parameters<typeof hostedStore.recordObservations>[0], revision?: string) => hostedStore.recordObservations(observations, revision),
      } : {}),
    });
    await server.connect(transport as never);
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await server.close();
    }
  },
});

// This endpoint is intentionally not exposed as an MCP tool. CI proves an
// exact revision using a deployment secret; a model's tool output is advisory.
app.post("/v1/routes/:id/verify", { config: { rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindow } } }, async (request, reply) => {
  if (!routerAuthorized(request) || !ciAuthorized(request)) return reply.code(401).send({ error: "Trusted CI attestation is required." });
  const { id } = request.params as { id: string };
  const bundle = db.getContextBundle(id);
  if (!bundle) return reply.code(404).send({ error: "Route not found." });
  const parsed = ContextVerifyRequestSchema.parse(request.body);
  if (parsed.artifacts.length === 0) return reply.code(400).send({ error: "At least one CI evidence artifact is required." });
  const verification = verifyReportedEvidence(db, bundle, parsed.artifacts, ["ci"]);
  await hostedStore?.recordObservations(verification.observations);
  return verification;
});

app.setErrorHandler((error, _request, reply) => {
  const typed = error as Error & { issues?: unknown };
  reply.code(typed.issues ? 400 : 500).send({ error: typed.message, issues: typed.issues });
});

if (process.env.NODE_ENV !== "test") {
  await app.listen({ port: config.port, host: "0.0.0.0" });
}
