import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { hostname, platform } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ContextBundleSchema,
  type ContextBundle,
  type ContextCompileRequest,
  type IntentDirective,
  type RetrievalMatch,
  type TrailEnvironment,
} from "@trail/contracts";
import { TrailDatabase } from "./database.js";
import { extractIntentDirectives, rerankTrails } from "./openai.js";
import { retrieveTrails } from "./retrieval.js";

function git(cwd: string, args: string[]) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

function repositoryName(remote: string) {
  return remote.replace(/^git@[^:]+:/, "").replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
}

export function detectEnvironment(workspace?: string, supplied: TrailEnvironment = {}): TrailEnvironment {
  const cwd = workspace ? resolve(workspace) : process.cwd();
  const root = existsSync(cwd) ? git(cwd, ["rev-parse", "--show-toplevel"]) : "";
  const remote = root ? git(root, ["config", "--get", "remote.origin.url"]) : "";
  const detected: TrailEnvironment = {
    os: platform(),
    host: hostname(),
    client: process.env.TRAIL_CLIENT ?? "codex",
    path: root || cwd,
    workspace: basename(root || cwd),
    ...(remote ? { repository: repositoryName(remote) } : {}),
    ...(root ? { branch: git(root, ["branch", "--show-current"]) || "detached" } : {}),
    ...(root ? { head: git(root, ["rev-parse", "HEAD"]) } : {}),
    runtime: `node-${process.versions.node}`,
  };
  return { ...detected, ...supplied };
}

function fallbackDirectives(task: string): IntentDirective[] {
  const directives: IntentDirective[] = [{
    id: "request-1",
    text: task.trim(),
    type: "goal",
    source: { kind: "current_request", sourceQuote: task.trim() },
  }];
  for (const sentence of task.split(/[.!?]+/)) {
    const index = sentence.search(/\b(?:do not|don't|never|without|must not|nothing left)\b/i);
    const quote = index >= 0 ? sentence.slice(index).trim() : "";
    if (!quote || directives.some((item) => item.source.sourceQuote === quote)) continue;
    directives.push({
      id: `request-${directives.length + 1}`,
      text: quote,
      type: "negative_constraint",
      source: { kind: "current_request", sourceQuote: quote },
    });
  }
  return directives;
}

async function currentRequestDirectives(task: string) {
  try {
    const extracted = await extractIntentDirectives(task);
    if (extracted.length > 0) return { directives: extracted, providerUsed: true };
  } catch { /* The source-anchored deterministic fallback remains usable offline. */ }
  return { directives: fallbackDirectives(task), providerUsed: false };
}

function trailDirectives(matches: RetrievalMatch[]): IntentDirective[] {
  const directives: IntentDirective[] = [];
  for (const match of matches) {
    const source = { kind: "approved_trail" as const, trailId: match.trail.id, sourceRange: match.trail.provenance.sourceRange };
    for (const value of match.trail.preconditions) directives.push({ id: `${match.trail.id}-pre-${directives.length}`, text: value, type: "required_action", source: { ...source, sourceQuote: value } });
    for (const value of match.trail.negativeConstraints) directives.push({ id: `${match.trail.id}-neg-${directives.length}`, text: value, type: "negative_constraint", source: { ...source, sourceQuote: value } });
    directives.push({ id: `${match.trail.id}-done`, text: match.trail.outcome, type: "completion_criterion", source: { ...source, sourceQuote: match.trail.outcome } });
  }
  return directives;
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => { const value = key(item); if (seen.has(value)) return false; seen.add(value); return true; });
}

function renderBundle(input: {
  task: string;
  environment: TrailEnvironment;
  directives: IntentDirective[];
  route: ContextBundle["route"];
  evidence: ContextBundle["evidence"];
  status: ContextBundle["status"];
  missingEnvironment: string[];
  stopConditions: string[];
}) {
  const list = (values: string[], empty: string) => values.length ? values.map((value, index) => `${index + 1}. ${value}`).join("\n") : empty;
  const required = input.directives.filter((item) => item.type === "required_action").map((item) => item.text);
  const negative = input.directives.filter((item) => item.type === "negative_constraint").map((item) => item.source.sourceQuote);
  const criteria = input.directives.filter((item) => item.type === "completion_criterion").map((item) => item.text);
  const route = input.route.map((step) => `${step.action} [approved trail: ${step.trailId}]`);
  const evidence = input.evidence.map((item) => `${item.description} — expected: ${item.expected}`);
  const environment = Object.entries(input.environment).map(([key, value]) => `${key}: ${value}`).join("\n");
  const environmentNote = input.missingEnvironment.length ? `Inspect these fields before continuing: ${input.missingEnvironment.join(", ")}.` : "Environment requirements are resolved.";
  return `<TRAIL_CONTEXT>
CURRENT USER REQUEST — HIGHEST PRIORITY
${input.task}

ENVIRONMENT
${environment || "No environment details detected."}

CONTEXT STATUS
${input.status}. ${environmentNote}

DO
${list([...required, ...criteria], "Follow the current user request exactly; no applicable historical route was forced.")}

DO NOT
${list(negative, "Do not invent completion evidence or expand the requested scope.")}

ROUTE
${list(route, "No applicable historical route. Continue with a bounded baseline route.")}

EVIDENCE REQUIRED
${list(evidence, "Inspect the actual environment, verify changed scope, and run the user-requested checks before claiming completion.")}

IF LOST OR A CHECK FAILS
${list(input.stopConditions, "Stop, report the missing evidence, and request a new TRAIL recovery context. Do not loop indefinitely.")}

RELEASE RULE
Do not claim completion or release until every required gate passes.
</TRAIL_CONTEXT>`;
}

function missingEnvironmentFrom(rejected: RetrievalMatch[]) {
  return [...new Set(rejected.flatMap((match) => match.rejectedReasons.flatMap((reason) => {
    const field = reason.match(/^missing required environment field: (.+)$/)?.[1];
    return field ? [field] : [];
  })))];
}

export async function compileContext(db: TrailDatabase, request: ContextCompileRequest, options: { parentId?: string | null; recoveryCount?: number } = {}) {
  const environment = detectEnvironment(request.workspace, request.environment);
  const retrievalRequest = {
    intent: [request.task, request.failure].filter(Boolean).join("\nFailure: "),
    environment,
    trigger: request.trigger,
    evidenceState: request.evidenceState,
    limit: 3,
  } as const;
  const retrieved = retrieveTrails(db, retrievalRequest, db.getActivePolicy());
  let matches = retrieved.matches;
  let reranked = false;
  if (matches.length > 1) {
    try { matches = await rerankTrails(retrievalRequest, matches); reranked = true; } catch { /* Deterministic order is the safe fallback. */ }
  }
  const rankedMatches = matches;
  matches = rankedMatches.filter((match) => match.matchReasons.some((reason) => reason === "intent and failure language overlap" || /^(?:client|workspace|repository|branch|host) matches /.test(reason)));
  const bestScore = matches[0]?.score ?? 0;
  const admitted = matches.filter((match, index) => index === 0 || match.score >= bestScore - 0.08);
  const finalRejected = [
    ...retrieved.rejected,
    ...rankedMatches.filter((match) => !matches.includes(match)).map((match) => ({ ...match, rejectedReasons: ["no exact intent or identity match"] })),
    ...matches.filter((match) => !admitted.includes(match)).map((match) => ({ ...match, rejectedReasons: ["not selected after final applicability margin"] })),
  ];
  matches = admitted;
  const missingEnvironment = missingEnvironmentFrom(retrieved.rejected);
  if (missingEnvironment.length > 0 && !matches.some((match) => match.matchReasons.some((reason) => reason.startsWith("workspace matches ")))) {
    finalRejected.push(...matches.map((match) => ({ ...match, rejectedReasons: ["required environment is unresolved"] })));
    matches = [];
  }
  const status: ContextBundle["status"] = matches.length ? "ready" : missingEnvironment.length ? "needs_environment" : "no_applicable_trail";
  const current = await currentRequestDirectives(request.task);
  const directives = uniqueBy([...current.directives, ...trailDirectives(matches)], (item) => `${item.type}:${item.text.toLowerCase()}`);
  const route = matches.flatMap((match) => match.trail.steps.map((step) => ({ id: step.id, action: step.action, tool: step.tool, trailId: match.trail.id, onFailure: step.onFailure })))
    .filter((step, index, steps) => steps.findIndex((item) => `${item.trailId}:${item.id}` === `${step.trailId}:${step.id}`) === index);
  const evidence = uniqueBy(matches.flatMap((match) => match.trail.steps.flatMap((step) => step.evidence)), (item) => item.id);
  const stopConditions = uniqueBy([
    ...route.filter((step) => step.onFailure !== "reroute").map((step) => `${step.id} failure requires ${step.onFailure}.`),
    "Only one recovery context is allowed; a second failure stops and escalates.",
  ], (item) => item);
  const bundle = ContextBundleSchema.parse({
    schemaVersion: "1.0",
    id: randomUUID(),
    parentId: options.parentId ?? null,
    status,
    originalPrompt: request.task,
    trigger: request.trigger,
    ...(request.failure ? { failure: request.failure } : {}),
    environment,
    missingEnvironment,
    directives,
    route,
    evidence,
    stopConditions,
    matchedTrails: matches.map((match) => ({ id: match.trail.id, title: match.trail.title, sourceRange: match.trail.provenance.sourceRange, provider: match.trail.provenance.provider, score: match.score, reasons: match.matchReasons })),
    rejectedTrails: finalRejected.map((match) => ({ id: match.trail.id, title: match.trail.title, reasons: match.rejectedReasons })),
    compiledPrompt: "pending",
    recoveryCount: options.recoveryCount ?? 0,
    createdAt: new Date().toISOString(),
  });
  bundle.compiledPrompt = renderBundle({ task: bundle.originalPrompt, environment: bundle.environment, directives: bundle.directives, route: bundle.route, evidence: bundle.evidence, status: bundle.status, missingEnvironment: bundle.missingEnvironment, stopConditions: bundle.stopConditions });
  const validated = ContextBundleSchema.parse(bundle);
  db.saveContextBundle(validated);
  return { bundle: validated, provider: { intentExtraction: current.providerUsed, reranked }, matches, rejected: finalRejected };
}

export async function recoverContext(
  db: TrailDatabase,
  bundle: ContextBundle,
  failure: string,
  evidenceState: Record<string, boolean>,
  currentEnvironment: TrailEnvironment = {},
) {
  if (bundle.recoveryCount >= 1) {
    const blocked = ContextBundleSchema.parse({ ...bundle, id: randomUUID(), parentId: bundle.id, status: "blocked", failure, recoveryCount: 1, createdAt: new Date().toISOString(), compiledPrompt: `${bundle.compiledPrompt}\n\nRECOVERY LIMIT REACHED\nStop and escalate; no second reroute is permitted.` });
    db.saveContextBundle(blocked);
    return { bundle: blocked, provider: { intentExtraction: false, reranked: false }, matches: [], rejected: [] };
  }
  return compileContext(
    db,
    {
      task: bundle.originalPrompt,
      // The recovery call wins for values that can legitimately change during a
      // run (for example, branch or deployed revision). The original route
      // remains immutable and linked as the parent bundle.
      environment: { ...bundle.environment, ...currentEnvironment },
      trigger: "failure",
      failure,
      evidenceState,
    },
    { parentId: bundle.id, recoveryCount: 1 },
  );
}
