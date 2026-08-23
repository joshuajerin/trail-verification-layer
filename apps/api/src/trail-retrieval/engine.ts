import {
  EnvironmentSchema,
  TrailSchema,
  TriggerSchema,
  type Trail,
  type TrailEnvironment,
  type Trigger,
} from "@trail/contracts";
import { z } from "zod";

const MINIMUM_SCORE = 0.34;

const RetrievalInputSchema = z.object({
  task: z.string().trim().min(3),
  trigger: TriggerSchema,
  environment: EnvironmentSchema.strict(),
  candidates: z.array(TrailSchema),
}).strict();

const ENVIRONMENT_FIELDS = [
  "os",
  "host",
  "client",
  "path",
  "workspace",
  "repository",
  "branch",
  "head",
  "runtime",
  "authSurface",
] as const satisfies readonly (keyof TrailEnvironment)[];

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "but", "by", "for", "from",
  "in", "is", "it", "of", "on", "or", "the", "their", "then", "this", "to", "with",
]);

const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  authenticated: "auth",
  authentication: "auth",
  authorization: "auth",
  deployed: "deploy",
  deployment: "deploy",
  preparing: "prepare",
  preparation: "prepare",
  proof: "prove",
  pr: "pullrequest",
  prs: "pullrequest",
};

export type TrailRetrievalInput = {
  task: string;
  trigger: Trigger;
  environment: TrailEnvironment;
  candidates: readonly Trail[];
};

export type RetrievalSignalScores = {
  taskFamily: number;
  intent: number;
  failureLanguage: number;
  trigger: number;
  environment: number;
};

export type ApplicableTrail = {
  trail: Trail;
  score: number;
  signals: RetrievalSignalScores;
  matchReasons: string[];
};

export type RejectedNearMatch = {
  trail: Trail;
  score: number | null;
  signals: RetrievalSignalScores | null;
  matchReasons: string[];
  rejectionReasons: string[];
};

export type TrailRetrievalResult = {
  applicableTrails: ApplicableTrail[];
  selectedTrail: ApplicableTrail | null;
  rejectedNearMatches: RejectedNearMatch[];
  noMatch: {
    isNoMatch: boolean;
    reason: string | null;
  };
};

export class TrailRetrievalInputError extends TypeError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Malformed retrieval input: ${issues.join("; ")}`);
    this.name = "TrailRetrievalInputError";
    this.issues = issues;
  }
}

type EvaluationContext = {
  task: string;
  trigger: Trigger;
  environment: TrailEnvironment;
};

type HardFilterResult = {
  matchReasons: string[];
  rejectionReasons: string[];
  matchedEnvironmentFields: number;
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/refs\/heads\//g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string): string[] {
  return [...new Set(normalize(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map((token) => TOKEN_ALIASES[token] ?? token))];
}

function includesTerm(haystack: string, term: string): boolean {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  const normalizedHaystack = normalize(haystack);
  if (` ${normalizedHaystack} `.includes(` ${normalizedTerm} `)) return true;
  const termTokens = tokens(term);
  if (termTokens.length === 0) return false;
  const haystackTokens = new Set(tokens(haystack));
  return termTokens.every((token) => haystackTokens.has(token));
}

function overlapRatio(reference: string, observed: string): { score: number; matched: string[]; total: number } {
  const referenceTokens = tokens(reference);
  const observedTokens = new Set(tokens(observed));
  const matched = referenceTokens.filter((token) => observedTokens.has(token));
  return {
    score: referenceTokens.length === 0 ? 0 : matched.length / referenceTokens.length,
    matched,
    total: referenceTokens.length,
  };
}

function boundedQueryOverlap(task: string, trailText: string) {
  const taskTokens = tokens(task);
  const trailTokens = new Set(tokens(trailText));
  const matched = taskTokens.filter((token) => trailTokens.has(token));
  return {
    score: taskTokens.length === 0 ? 0 : matched.length / taskTokens.length,
    matched,
    total: taskTokens.length,
  };
}

function environmentValue(environment: TrailEnvironment, field: string): string | undefined {
  if (!ENVIRONMENT_FIELDS.includes(field as keyof TrailEnvironment)) return undefined;
  return environment[field as keyof TrailEnvironment];
}

function conditionMatches(condition: string, context: EvaluationContext): boolean {
  const trimmed = condition.trim();
  const taskGroup = trimmed.match(/^task:(any|all|phrase)\((.*)\)$/i);
  if (taskGroup) {
    const mode = taskGroup[1]?.toLowerCase();
    const terms = (taskGroup[2] ?? "").split("|").map((term) => term.trim()).filter(Boolean);
    if (terms.length === 0) return false;
    if (mode === "all") return terms.every((term) => includesTerm(context.task, term));
    if (mode === "phrase") return terms.length === 1 && normalize(context.task).includes(normalize(terms[0] ?? ""));
    return terms.some((term) => includesTerm(context.task, term));
  }

  const triggerCondition = trimmed.match(/^trigger:(start|failure|release)$/i);
  if (triggerCondition) return triggerCondition[1]?.toLowerCase() === context.trigger;

  const environmentCondition = trimmed.match(/^environment\.([A-Za-z]+):(.+)$/);
  if (environmentCondition) {
    const actual = environmentValue(context.environment, environmentCondition[1] ?? "");
    return actual !== undefined && normalize(actual) === normalize(environmentCondition[2] ?? "");
  }

  // Existing v1 trails use human prose rather than a condition grammar. Treat
  // those clauses as deterministic keyword requirements for compatibility.
  return overlapRatio(trimmed, context.task).score > 0;
}

function hardFilter(trail: Trail, context: EvaluationContext): HardFilterResult {
  const matchReasons: string[] = [];
  const rejectionReasons: string[] = [];
  let matchedEnvironmentFields = 0;

  if (trail.reviewStatus !== "approved") {
    rejectionReasons.push(`review status "${trail.reviewStatus}" is not approved`);
  }

  for (const field of ENVIRONMENT_FIELDS) {
    const expected = trail.environment[field];
    if (expected === undefined) continue;
    const actual = context.environment[field];
    if (actual === undefined) {
      rejectionReasons.push(`missing required environment field "${field}" (expected "${expected}")`);
    } else if (normalize(actual) !== normalize(expected)) {
      rejectionReasons.push(`environment mismatch for ${field}: expected "${expected}", received "${actual}"`);
    } else {
      matchedEnvironmentFields += 1;
      matchReasons.push(`environment ${field} matched required value "${expected}"`);
    }
  }

  for (const condition of trail.applicability) {
    if (conditionMatches(condition, context)) {
      matchReasons.push(`applicability condition matched: ${condition}`);
    } else {
      rejectionReasons.push(`applicability condition not met: ${condition}`);
    }
  }

  for (const invalidator of trail.invalidators) {
    if (conditionMatches(invalidator, context)) {
      rejectionReasons.push(`active invalidator: ${invalidator}`);
    }
  }

  return { matchReasons, rejectionReasons, matchedEnvironmentFields };
}

function scoreTrail(trail: Trail, context: EvaluationContext, filtered: HardFilterResult): ApplicableTrail {
  const taskFamily = overlapRatio(trail.taskFamily, context.task);
  const intentText = [trail.title, trail.summary, trail.intent, trail.outcome, ...trail.tags].join(" ");
  const intent = boundedQueryOverlap(context.task, intentText);
  const failureMatches = context.trigger === "failure"
    ? trail.failureSignatures.map((signature) => ({ signature, ...overlapRatio(signature, context.task) }))
    : [];
  const bestFailure = failureMatches.sort((left, right) => right.score - left.score || left.signature.localeCompare(right.signature))[0];
  const environmentFieldCount = ENVIRONMENT_FIELDS.filter((field) => trail.environment[field] !== undefined).length;
  const signals: RetrievalSignalScores = {
    taskFamily: taskFamily.score,
    intent: intent.score,
    failureLanguage: bestFailure?.score ?? 0,
    trigger: trail.triggers.includes(context.trigger) ? 1 : 0,
    environment: environmentFieldCount === 0 ? 0.25 : filtered.matchedEnvironmentFields / environmentFieldCount,
  };
  const score = Number((
    signals.taskFamily * 0.28
    + signals.intent * 0.32
    + signals.failureLanguage * 0.14
    + signals.trigger * 0.16
    + signals.environment * 0.10
  ).toFixed(4));
  const matchReasons = [...filtered.matchReasons];

  if (taskFamily.matched.length > 0) {
    matchReasons.push(`task-family signal matched ${taskFamily.matched.length} of ${taskFamily.total} terms: ${taskFamily.matched.join(", ")}`);
  }
  if (intent.matched.length > 0) {
    matchReasons.push(`intent signal matched ${intent.matched.length} of ${intent.total} task terms: ${intent.matched.join(", ")}`);
  }
  if (bestFailure && bestFailure.score > 0) {
    matchReasons.push(`failure-language signal matched "${bestFailure.signature}"`);
  }
  matchReasons.push(trail.triggers.includes(context.trigger)
    ? `trigger "${context.trigger}" is supported`
    : `trigger "${context.trigger}" is not listed; no trigger points awarded`);

  return { trail, score, signals, matchReasons };
}

function rejectionSort(left: RejectedNearMatch, right: RejectedNearMatch): number {
  if (left.score !== null || right.score !== null) {
    if (left.score === null) return 1;
    if (right.score === null) return -1;
    if (left.score !== right.score) return right.score - left.score;
  }
  if (left.rejectionReasons.length !== right.rejectionReasons.length) {
    return left.rejectionReasons.length - right.rejectionReasons.length;
  }
  return left.trail.id.localeCompare(right.trail.id);
}

function parseInput(input: TrailRetrievalInput): z.infer<typeof RetrievalInputSchema> {
  const parsed = RetrievalInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new TrailRetrievalInputError(parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    }));
  }
  const seen = new Set<string>();
  for (const candidate of parsed.data.candidates) {
    if (seen.has(candidate.id)) throw new TrailRetrievalInputError([`duplicate candidate trail id: ${candidate.id}`]);
    seen.add(candidate.id);
  }
  return parsed.data;
}

/**
 * Pure deterministic TRAIL retrieval. `release` is the existing contract value
 * for the pre-release trigger. Applicability/invalidator expressions support:
 * `task:any(a|b)`, `task:all(a|b)`, `task:phrase(text)`, `trigger:value`, and
 * `environment.field:value`; legacy prose clauses use deterministic token overlap.
 */
export function retrieveTrailsDeterministically(input: TrailRetrievalInput): TrailRetrievalResult {
  const parsed = parseInput(input);
  const context: EvaluationContext = {
    task: parsed.task,
    trigger: parsed.trigger,
    environment: parsed.environment,
  };
  const applicable: ApplicableTrail[] = [];
  const rejected: RejectedNearMatch[] = [];

  for (const trail of parsed.candidates) {
    const filtered = hardFilter(trail, context);
    if (filtered.rejectionReasons.length > 0) {
      rejected.push({
        trail,
        score: null,
        signals: null,
        matchReasons: filtered.matchReasons,
        rejectionReasons: filtered.rejectionReasons,
      });
      continue;
    }

    const scored = scoreTrail(trail, context, filtered);
    const hasRelevanceAnchor = scored.signals.taskFamily >= 0.25
      || scored.signals.intent >= 0.2
      || scored.signals.failureLanguage >= 0.5;
    const weakReasons: string[] = [];
    if (!hasRelevanceAnchor) {
      weakReasons.push("weak match: no meaningful task-family, intent, or failure-language signal");
    }
    if (scored.score < MINIMUM_SCORE) {
      weakReasons.push(`weak match: score ${scored.score.toFixed(4)} is below selection threshold ${MINIMUM_SCORE.toFixed(4)}`);
    }
    if (weakReasons.length > 0) {
      rejected.push({ ...scored, rejectionReasons: weakReasons });
    } else {
      applicable.push(scored);
    }
  }

  applicable.sort((left, right) => right.score - left.score
    || right.signals.taskFamily - left.signals.taskFamily
    || right.signals.intent - left.signals.intent
    || right.trail.confidence - left.trail.confidence
    || left.trail.id.localeCompare(right.trail.id));
  rejected.sort(rejectionSort);

  const selectedTrail = applicable[0] ?? null;
  return {
    applicableTrails: applicable,
    selectedTrail,
    rejectedNearMatches: rejected,
    noMatch: {
      isNoMatch: selectedTrail === null,
      reason: selectedTrail === null
        ? parsed.candidates.length === 0
          ? "No candidate trails were supplied."
          : "No approved trail passed mandatory filters, invalidators, and the minimum relevance threshold."
        : null,
    },
  };
}
