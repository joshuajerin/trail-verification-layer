import { z } from "zod";

export const TriggerSchema = z.enum(["start", "failure", "release"]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const EnvironmentSchema = z.object({
  os: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  client: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  repository: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  head: z.string().regex(/^[a-f0-9]{7,40}$/i).optional(),
  runtime: z.string().min(1).optional(),
  deployment: z.string().min(1).optional(),
  authSurface: z.string().min(1).optional(),
});
export type TrailEnvironment = z.infer<typeof EnvironmentSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "environment",
    "changed_scope",
    "test",
    "remote_ancestry",
    "http",
    "browser",
    "provider",
    "runtime",
  ]),
  description: z.string().min(1),
  required: z.boolean().default(true),
  expected: z.string().min(1),
});
export type EvidenceContract = z.infer<typeof EvidenceSchema>;

export const TrailStepSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  tool: z.enum(["inspect", "read", "write", "check", "verify", "escalate"]),
  evidence: z.array(EvidenceSchema).min(1),
  onFailure: z.enum(["reroute", "stop", "escalate"]),
});
export type TrailStep = z.infer<typeof TrailStepSchema>;

export const TrailSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  taskFamily: z.string().min(1),
  intent: z.string().min(1),
  provenance: z.object({
    provider: z.enum(["codex", "claude", "community", "benchmark"]),
    sourceHash: z.string().min(8),
    sourceRange: z.string().min(1),
    redacted: z.literal(true),
  }),
  environment: EnvironmentSchema,
  preconditions: z.array(z.string()),
  negativeConstraints: z.array(z.string()),
  triggers: z.array(TriggerSchema).min(1),
  failureSignatures: z.array(z.string()),
  steps: z.array(TrailStepSchema).min(1),
  applicability: z.array(z.string()),
  invalidators: z.array(z.string()),
  outcome: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reviewStatus: z.enum(["draft", "approved", "rejected"]),
  reviewedAt: z.string().datetime().optional(),
  tags: z.array(z.string()).default([]),
});
// WorkflowRoute is the product name. Trail remains a compatibility alias for
// existing reviewed corpus files while curators migrate their filenames.
export const WorkflowRouteSchema = TrailSchema;
export type WorkflowRoute = z.infer<typeof WorkflowRouteSchema>;
export type Trail = WorkflowRoute;

export const RetrievalRequestSchema = z.object({
  intent: z.string().min(3),
  environment: EnvironmentSchema.default({}),
  trigger: TriggerSchema,
  evidenceState: z.record(z.string(), z.boolean()).default({}),
  limit: z.number().int().min(1).max(10).default(3),
});
export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>;

export const RetrievalMatchSchema = z.object({
  trail: TrailSchema,
  score: z.number(),
  matchReasons: z.array(z.string()),
  rejectedReasons: z.array(z.string()),
});
export type RetrievalMatch = z.infer<typeof RetrievalMatchSchema>;

export const RunEventSchema = z.object({
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  side: z.enum(["baseline", "guided", "system"]),
  type: z.enum([
    "run_started",
    "observation",
    "retrieval",
    "action",
    "gate_blocked",
    "gate_passed",
    "reroute",
    "run_finished",
    "error",
  ]),
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.string().datetime(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunMetricsSchema = z.object({
  verified: z.boolean(),
  unsafeReleaseApproved: z.boolean(),
  toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

export const PolicyWeightsSchema = z.object({
  environment: z.number().min(0).max(1),
  lexical: z.number().min(0).max(1),
  failure: z.number().min(0).max(1),
  evidence: z.number().min(0).max(1),
});

export const PolicySchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  parentId: z.string().nullable(),
  status: z.enum(["candidate", "active", "rejected"]),
  weights: PolicyWeightsSchema,
  reason: z.string(),
  createdAt: z.string().datetime(),
});
export type RetrievalPolicy = z.infer<typeof PolicySchema>;

export const IngestionPreviewSchema = z.object({
  id: z.string(),
  format: z.enum(["codex", "claude", "unknown"]),
  sourceName: z.string(),
  redactedText: z.string(),
  redactionCount: z.number().int().nonnegative(),
  candidateSignals: z.array(z.string()),
  requiresReview: z.boolean(),
});
export type IngestionPreview = z.infer<typeof IngestionPreviewSchema>;

export const DirectiveSourceSchema = z.object({
  kind: z.enum(["current_request", "approved_trail"]),
  sourceQuote: z.string().min(1),
  trailId: z.string().min(1).optional(),
  sourceRange: z.string().min(1).optional(),
});

export const IntentDirectiveSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  type: z.enum(["goal", "required_action", "negative_constraint", "completion_criterion"]),
  source: DirectiveSourceSchema,
});
export type IntentDirective = z.infer<typeof IntentDirectiveSchema>;

export const ContextStatusSchema = z.enum(["ready", "no_applicable_trail", "needs_environment", "blocked"]);
export type ContextStatus = z.infer<typeof ContextStatusSchema>;

export const EvidenceObservationSchema = z.object({
  id: z.string().min(1),
  bundleId: z.string().min(1),
  evidenceId: z.string().min(1),
  verifier: z.string().min(1),
  expected: z.string().min(1),
  observed: z.string(),
  passed: z.boolean(),
  attestation: z.enum(["agent", "harness", "ci"]).default("agent"),
  timestamp: z.string().datetime(),
});
export type EvidenceObservation = z.infer<typeof EvidenceObservationSchema>;

export const EvidenceArtifactSchema = z.object({
  evidenceId: z.string().min(1),
  verifier: z.string().min(1),
  observed: z.string(),
  passed: z.boolean(),
  attestation: z.enum(["agent", "harness", "ci"]).default("agent"),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

export const ContextBundleSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  status: ContextStatusSchema,
  originalPrompt: z.string().min(3),
  trigger: TriggerSchema,
  failure: z.string().optional(),
  environment: EnvironmentSchema,
  missingEnvironment: z.array(z.string()),
  directives: z.array(IntentDirectiveSchema).min(1),
  route: z.array(z.object({
    id: z.string().min(1),
    action: z.string().min(1),
    tool: TrailStepSchema.shape.tool,
    trailId: z.string().min(1),
    onFailure: TrailStepSchema.shape.onFailure,
  })),
  evidence: z.array(EvidenceSchema),
  stopConditions: z.array(z.string()),
  matchedTrails: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    sourceRange: z.string().min(1),
    provider: z.string().min(1),
    score: z.number(),
    reasons: z.array(z.string()),
  })),
  rejectedTrails: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    reasons: z.array(z.string()),
  })),
  compiledPrompt: z.string().min(1),
  recoveryCount: z.number().int().min(0).max(1),
  createdAt: z.string().datetime(),
});
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

export const ContextCompileRequestSchema = z.object({
  task: z.string().min(3),
  workspace: z.string().min(1).optional(),
  environment: EnvironmentSchema.default({}),
  trigger: TriggerSchema.default("start"),
  failure: z.string().min(1).optional(),
  evidenceState: z.record(z.string(), z.boolean()).default({}),
});
export type ContextCompileRequest = z.infer<typeof ContextCompileRequestSchema>;

export const ContextVerifyRequestSchema = z.object({
  workspace: z.string().min(1).optional(),
  adapters: z.array(z.string().min(1)).default([]),
  artifacts: z.array(EvidenceArtifactSchema).default([]),
});
export type ContextVerifyRequest = z.infer<typeof ContextVerifyRequestSchema>;

export const ContextVerificationSchema = z.object({
  bundleId: z.string().min(1),
  passed: z.boolean(),
  status: z.enum(["passed", "blocked"]),
  observations: z.array(EvidenceObservationSchema),
  missingEvidence: z.array(z.string()),
  releaseEligible: z.boolean().default(false),
});
export type ContextVerification = z.infer<typeof ContextVerificationSchema>;
