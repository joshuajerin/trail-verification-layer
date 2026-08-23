import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TrailEnvironment } from "@trail/contracts";
import { compileContext, recoverContext } from "./context.js";
import { TrailDatabase } from "./database.js";
import { verifyReportedEvidence } from "./verification.js";

const contextSchema = {
  client: z.string().min(1).optional(),
  repository: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  revision: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
  platform: z.string().min(1).optional(),
  runtime: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  deployment: z.string().min(1).optional(),
};

function environment(context: z.infer<z.ZodObject<typeof contextSchema>>): TrailEnvironment {
  return {
    ...(context.client ? { client: context.client } : {}),
    ...(context.repository ? { repository: context.repository } : {}),
    ...(context.branch ? { branch: context.branch } : {}),
    ...(context.revision ? { head: context.revision } : {}),
    ...(context.platform ? { os: context.platform } : {}),
    ...(context.runtime ? { runtime: context.runtime } : {}),
    ...(context.workspace ? { workspace: context.workspace } : {}),
    ...(context.deployment ? { deployment: context.deployment } : {}),
  };
}

function routeResult(result: Awaited<ReturnType<typeof compileContext>>) {
  const { bundle } = result;
  const goals = bundle.directives.filter((item) => item.type === "goal").map((item) => item.text);
  const mustDo = bundle.directives.filter((item) => item.type === "required_action" || item.type === "completion_criterion").map((item) => item.text);
  const mustNotDo = bundle.directives.filter((item) => item.type === "negative_constraint").map((item) => item.source.sourceQuote);
  return {
    decision: {
      ready: "route",
      needs_environment: "needs_context",
      no_applicable_trail: "no_match",
      blocked: "blocked",
    }[bundle.status],
    route_id: bundle.id,
    intent: goals.length ? goals : [bundle.originalPrompt],
    must_do: mustDo,
    must_not_do: mustNotDo,
    workflow: bundle.route.map((step) => ({ action: step.action, checkpoint: step.id, on_failure: step.onFailure })),
    proof_required: bundle.evidence,
    agent_context: bundle.compiledPrompt,
    sources: bundle.matchedTrails,
    rejected_near_matches: bundle.rejectedTrails,
    next_call: bundle.status === "blocked" ? "none" : bundle.status === "ready" ? "trail_verify" : "trail_route",
  };
}

function resultText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createTrailMcpServer(
  db: TrailDatabase,
  options: {
    routeSessionTtlMs?: number;
    privateHistory?: boolean;
    persistBundle?: (bundle: Awaited<ReturnType<typeof compileContext>>["bundle"]) => Promise<void>;
    persistObservations?: (observations: ReturnType<typeof verifyReportedEvidence>["observations"], revision?: string) => Promise<void>;
  } = {},
) {
  const routeSessionTtlMs = options.routeSessionTtlMs ?? Number(process.env.TRAIL_ROUTE_SESSION_TTL_MS ?? 15 * 60 * 1000);
  const purgeExpiredSessions = () => {
    if (!options.privateHistory) db.deleteExpiredContextBundles(new Date(Date.now() - routeSessionTtlMs).toISOString());
  };
  const server = new McpServer(
    { name: "trail-router", version: "1.0.0" },
    {
      instructions: "Call trail_route before taking action. Call trail_recover after a real failure or user correction. Call trail_verify before claiming completion or PR readiness. A blocked result is a stop condition.",
    },
  );

  server.registerTool(
    "trail_route",
    {
      title: "Route a coding task through reviewed human context",
      description: "Return a source-backed Do, Do Not, workflow, and proof contract. The caller supplies safe task and environment context; TRAIL never reads the caller's workspace.",
      inputSchema: {
        task: z.string().min(3),
        phase: z.enum(["start", "failure", "release"]).default("start"),
        context: z.object(contextSchema).default({}),
        failure: z.string().min(1).optional(),
        completed_checkpoints: z.array(z.string().min(1)).default([]),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ task, phase, context, failure, completed_checkpoints }) => {
      purgeExpiredSessions();
      const evidenceState = Object.fromEntries(completed_checkpoints.map((id) => [id, true]));
      const result = await compileContext(db, { task, environment: environment(context), trigger: phase, failure, evidenceState });
      await options.persistBundle?.(result.bundle);
      return resultText(routeResult(result));
    },
  );

  server.registerTool(
    "trail_recover",
    {
      title: "Request the one permitted recovery route",
      description: "Use after an observed failure, not speculation. A second recovery blocks and escalates.",
      inputSchema: {
        route_id: z.string().uuid(),
        failure: z.string().min(1),
        context: z.object(contextSchema).default({}),
        completed_checkpoints: z.array(z.string().min(1)).default([]),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ route_id, failure, context, completed_checkpoints }) => {
      purgeExpiredSessions();
      const bundle = db.getContextBundle(route_id);
      if (!bundle) return { content: [{ type: "text" as const, text: "Unknown route_id. Call trail_route to start a new route." }], isError: true };
      const evidenceState = Object.fromEntries(completed_checkpoints.map((id) => [id, true]));
      const result = await recoverContext(db, bundle, failure, evidenceState, environment(context));
      await options.persistBundle?.(result.bundle);
      return resultText(routeResult(result));
    },
  );

  server.registerTool(
    "trail_verify",
    {
      title: "Verify a route before completion or release",
      description: "Validate structured evidence against the route contract. Agent-provided evidence remains advisory; only CI or a registered trusted harness can create release-eligible proof.",
      inputSchema: {
        route_id: z.string().uuid(),
        revision: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
        evidence: z.array(z.object({
          evidence_id: z.string().min(1),
          verifier: z.string().min(1),
          observed: z.string(),
          passed: z.boolean(),
        })).default([]),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ route_id, revision, evidence }) => {
      purgeExpiredSessions();
      const bundle = db.getContextBundle(route_id);
      if (!bundle) return { content: [{ type: "text" as const, text: "Unknown route_id. Call trail_route to start a new route." }], isError: true };
      if (revision && bundle.environment.head && !bundle.environment.head.startsWith(revision) && !revision.startsWith(bundle.environment.head)) {
        return resultText({ decision: "blocked", release_eligible: false, reason: "The supplied revision does not match the routed revision." });
      }
      const verification = verifyReportedEvidence(
        db,
        bundle,
        evidence.map((item) => ({ evidenceId: item.evidence_id, verifier: item.verifier, observed: item.observed, passed: item.passed, attestation: "agent" as const })),
        [],
      );
      await options.persistObservations?.(verification.observations, revision);
      return resultText({
        decision: verification.releaseEligible ? "ready" : "blocked",
        release_eligible: verification.releaseEligible,
        gates: bundle.evidence.map((gate) => ({
          ...gate,
          observations: verification.observations.filter((observation) => observation.evidenceId === gate.id),
        })),
        missing_proof: verification.missingEvidence,
        next_call: verification.releaseEligible ? "none" : "trail_recover",
      });
    },
  );

  return server;
}
