import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import type { ContextBundle, ContextVerification, EvidenceArtifact, EvidenceContract, EvidenceObservation } from "@trail/contracts";
import { TrailDatabase } from "./database.js";
import { detectEnvironment } from "./context.js";

const CommandSchema = z.object({ name: z.string(), command: z.array(z.string()).min(1) });
const HttpSchema = z.object({ name: z.string(), url: z.string().url(), expectedStatus: z.number().int().min(100).max(599).default(200), contains: z.string().optional(), headerEnv: z.string().optional() });
const RuntimeSchema = z.object({ name: z.string(), command: z.array(z.string()).min(1).optional(), artifact: z.string().optional(), contains: z.string().optional() });
const TrailConfigSchema = z.object({
  version: z.literal(1),
  allowedChangedScopes: z.array(z.string()).default([]),
  forbiddenPaths: z.array(z.string()).default([".env", ".trail/"]),
  checks: z.array(CommandSchema).default([]),
  http: z.array(HttpSchema).default([]),
  browser: z.array(HttpSchema).default([]),
  provider: z.array(HttpSchema).default([]),
  runtime: z.array(RuntimeSchema).default([]),
});
type TrailConfig = z.infer<typeof TrailConfigSchema>;

function command(cwd: string, argv: string[]) {
  if (!argv[0]) return { passed: false, output: "empty command" };
  try {
    const output = execFileSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    return { passed: true, output: output.trim().slice(-4_000) || "exit 0" };
  } catch (error) {
    const typed = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    return { passed: false, output: `${String(typed.stdout ?? "")}\n${String(typed.stderr ?? "")}`.trim().slice(-4_000) || `exit ${typed.status ?? "error"}` };
  }
}

function loadConfig(workspace: string): TrailConfig {
  const path = join(workspace, ".trailrc.json");
  if (!existsSync(path)) return TrailConfigSchema.parse({ version: 1 });
  return TrailConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function changedFiles(workspace: string) {
  const result = command(workspace, ["git", "status", "--porcelain"]);
  if (!result.passed) return [];
  return result.output.split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").at(-1) ?? "");
}

function observation(bundle: ContextBundle, evidence: EvidenceContract, verifier: string, observed: string, passed: boolean, attestation: EvidenceObservation["attestation"] = "harness"): EvidenceObservation {
  return { id: randomUUID(), bundleId: bundle.id, evidenceId: evidence.id, verifier, expected: evidence.expected, observed, passed, attestation, timestamp: new Date().toISOString() };
}

function selected<T extends { name: string }>(items: T[], requested: string[]) {
  return requested.length ? items.filter((item) => requested.includes(item.name)) : items.slice(0, 1);
}

async function httpObservation(bundle: ContextBundle, evidence: EvidenceContract, adapter: z.infer<typeof HttpSchema>, kind: string) {
  try {
    const headers: Record<string, string> = {};
    if (adapter.headerEnv && process.env[adapter.headerEnv]) headers.Authorization = `Bearer ${process.env[adapter.headerEnv]}`;
    const response = await fetch(adapter.url, { headers, signal: AbortSignal.timeout(12_000) });
    const body = await response.text();
    const passed = response.status === adapter.expectedStatus && (!adapter.contains || body.includes(adapter.contains));
    return observation(bundle, evidence, `${kind}:${adapter.name}`, `HTTP ${response.status}${adapter.contains ? `; contains=${body.includes(adapter.contains)}` : ""}`, passed);
  } catch (error) {
    return observation(bundle, evidence, `${kind}:${adapter.name}`, error instanceof Error ? error.message : "request failed", false);
  }
}

export async function verifyContext(db: TrailDatabase, bundle: ContextBundle, workspaceInput: string, requestedAdapters: string[]): Promise<ContextVerification> {
  const workspace = resolve(workspaceInput);
  if (!existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`);
  const config = loadConfig(workspace);
  const observations: EvidenceObservation[] = [];
  const files = changedFiles(workspace);
  const environment = detectEnvironment(workspace, {});
  for (const evidence of bundle.evidence.filter((item) => item.required)) {
    if (evidence.kind === "environment") {
      const observed = JSON.stringify(environment);
      const passed = Object.values(environment).some((value) => value?.toLowerCase().includes(evidence.expected.toLowerCase()));
      observations.push(observation(bundle, evidence, "builtin:environment", observed, passed));
    } else if (evidence.kind === "changed_scope") {
      const allowed = evidence.expected.split(",").map((value) => value.trim()).filter(Boolean);
      const configuredAllowed = config.allowedChangedScopes;
      const forbidden = files.filter((file) => config.forbiddenPaths.some((entry) => file === entry || file.startsWith(entry)));
      const passed = files.length > 0 && forbidden.length === 0 && files.every((file) => allowed.some((prefix) => file.startsWith(prefix))) && (!configuredAllowed.length || files.every((file) => configuredAllowed.some((prefix) => file.startsWith(prefix))));
      observations.push(observation(bundle, evidence, "builtin:git-changed-scope", files.join(", ") || "no changed files", passed));
    } else if (evidence.kind === "remote_ancestry") {
      const result = command(workspace, ["git", "branch", "-r", "--contains", "HEAD"]);
      observations.push(observation(bundle, evidence, "builtin:git-remote-ancestry", result.output, result.passed && result.output.length > 0));
    } else if (evidence.kind === "test") {
      const checks = selected(config.checks, requestedAdapters);
      if (!checks.length) observations.push(observation(bundle, evidence, "named-check", "no approved named check configured", false));
      for (const check of checks) {
        const result = command(workspace, check.command);
        observations.push(observation(bundle, evidence, `check:${check.name}`, result.output, result.passed));
      }
    } else if (evidence.kind === "http" || evidence.kind === "browser" || evidence.kind === "provider") {
      const adapters = selected(config[evidence.kind], requestedAdapters);
      if (!adapters.length) observations.push(observation(bundle, evidence, `${evidence.kind}:unconfigured`, "no approved adapter configured", false));
      for (const adapter of adapters) observations.push(await httpObservation(bundle, evidence, adapter, evidence.kind));
    } else if (evidence.kind === "runtime") {
      const adapters = selected(config.runtime, requestedAdapters);
      if (!adapters.length) observations.push(observation(bundle, evidence, "runtime:unconfigured", "no approved runtime or hardware adapter configured", false));
      for (const adapter of adapters) {
        if (adapter.command) {
          const result = command(workspace, adapter.command);
          observations.push(observation(bundle, evidence, `runtime:${adapter.name}`, result.output, result.passed && (!adapter.contains || result.output.includes(adapter.contains))));
        } else if (adapter.artifact) {
          const artifact = resolve(workspace, adapter.artifact);
          const contents = existsSync(artifact) ? readFileSync(artifact, "utf8") : "artifact missing";
          observations.push(observation(bundle, evidence, `runtime:${adapter.name}`, `${basename(artifact)}: ${contents.slice(-2_000)}`, existsSync(artifact) && (!adapter.contains || contents.includes(adapter.contains))));
        }
      }
    }
  }
  for (const item of observations) db.saveEvidenceObservation(item);
  const evidencePasses = bundle.evidence.filter((item) => item.required).map((item) => {
    const results = observations.filter((result) => result.evidenceId === item.id);
    return results.length > 0 && results.every((result) => result.passed);
  });
  const passed = evidencePasses.length > 0 && evidencePasses.every(Boolean);
  return {
    bundleId: bundle.id,
    passed,
    status: passed ? "passed" : "blocked",
    observations,
    missingEvidence: bundle.evidence.filter((item, index) => item.required && !evidencePasses[index]).map((item) => item.id),
    releaseEligible: passed,
  };
}

/**
 * Validates evidence sent by a remote harness without executing anything on the
 * router host. Agent-reported artifacts are useful progress signals, but only
 * explicitly trusted attestation kinds can make a route release-eligible.
 */
export function verifyReportedEvidence(
  db: TrailDatabase,
  bundle: ContextBundle,
  artifacts: EvidenceArtifact[],
  trustedAttestations: Array<EvidenceArtifact["attestation"]>,
): ContextVerification {
  const observations = artifacts
    .filter((artifact) => bundle.evidence.some((evidence) => evidence.id === artifact.evidenceId && evidence.required))
    .map((artifact) => {
      const evidence = bundle.evidence.find((item) => item.id === artifact.evidenceId)!;
      const trusted = trustedAttestations.includes(artifact.attestation);
      return observation(
        bundle,
        evidence,
        `${trusted ? "attested" : "advisory"}:${artifact.verifier}`,
        artifact.observed,
        trusted && artifact.passed,
        artifact.attestation,
      );
    });
  for (const item of observations) db.saveEvidenceObservation(item);
  const missingEvidence = bundle.evidence
    .filter((evidence) => evidence.required)
    .filter((evidence) => !observations.some((item) => item.evidenceId === evidence.id && item.passed))
    .map((evidence) => evidence.id);
  const releaseEligible = missingEvidence.length === 0 && bundle.evidence.some((evidence) => evidence.required);
  return {
    bundleId: bundle.id,
    passed: releaseEligible,
    status: releaseEligible ? "passed" : "blocked",
    observations,
    missingEvidence,
    releaseEligible,
  };
}
