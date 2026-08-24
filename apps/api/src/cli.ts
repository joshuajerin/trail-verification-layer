#!/usr/bin/env node
import { resolve } from "node:path";
import { config } from "./config.js";
import { TrailDatabase } from "./database.js";
import { loadCorpus } from "./corpus.js";
import { previewTranscriptFile } from "./adapters.js";
import { indexLocalSources } from "./source-index.js";
import { runBenchmark } from "./benchmark.js";
import { HarnessService } from "./harness.js";
import { assertSuccessEligible, publishVerificationStatus } from "./github-status.js";
import { ensureActivePolicy } from "./policy.js";
import { compileContext, recoverContext } from "./context.js";
import { verifyContext } from "./verification.js";
import { preflight } from "./config.js";
import { execFileSync } from "node:child_process";
import { runDomainEvals, saveDomainEvalResult } from "./domain-evals.js";
import { runCodexCliEvals } from "./codex-cli-evals.js";

const db = new TrailDatabase(config.databasePath);
loadCorpus(db);
ensureActivePolicy(db);
const [command, ...args] = process.argv.slice(2);

const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

try {
  if (command === "ingest" && args[0] === "--scan") {
    console.log(JSON.stringify(indexLocalSources(db), null, 2));
  } else if (command === "ingest" && args[0]) {
    const preview = previewTranscriptFile(resolve(args[0]));
    db.saveIngestion(preview);
    console.log(JSON.stringify(preview, null, 2));
  } else if (command === "benchmark") {
    console.log(JSON.stringify(runBenchmark(db), null, 2));
  } else if (command === "eval") {
    const repetitions = Number(option("--repetitions") ?? 3);
    const result = await runDomainEvals(db, repetitions);
    const path = saveDomainEvalResult(result);
    console.log(JSON.stringify({ path, result }, null, 2));
  } else if (command === "eval-codex") {
    const repetitions = Number(option("--repetitions") ?? 1);
    const apiBase = option("--api-base") ?? process.env.TRAIL_API_BASE ?? "http://127.0.0.1:4317";
    const model = option("--model") ?? process.env.CODEX_EVAL_MODEL;
    console.log(JSON.stringify(await runCodexCliEvals(repetitions, apiBase, model), null, 2));
  } else if (command === "run") {
    const result = new HarnessService(db).startPairedRun(0);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    console.log(JSON.stringify({ ...result, run: db.getRun(result.runId), events: db.getRunEvents(result.runId) }, null, 2));
  } else if (command === "context") {
    const task = option("--task");
    if (!task) throw new Error("Usage: trail context --task \"...\" [--workspace PATH] [--trigger start|failure|release]");
    const trigger = (option("--trigger") ?? "start") as "start" | "failure" | "release";
    console.log(JSON.stringify(await compileContext(db, { task, workspace: option("--workspace"), environment: {}, trigger, evidenceState: {} }), null, 2));
  } else if (command === "recover") {
    const bundleId = option("--bundle");
    const failure = option("--failure");
    const bundle = bundleId ? db.getContextBundle(bundleId) : null;
    if (!bundle || !failure) throw new Error("Usage: trail recover --bundle ID --failure \"...\"");
    console.log(JSON.stringify(await recoverContext(db, bundle, failure, {}), null, 2));
  } else if (command === "verify") {
    const bundleId = option("--bundle");
    const workspace = option("--workspace") ?? process.cwd();
    const bundle = bundleId ? db.getContextBundle(bundleId) : null;
    if (!bundle) throw new Error("Usage: trail verify --bundle ID [--workspace PATH]");
    console.log(JSON.stringify(await verifyContext(db, bundle, workspace, option("--adapter") ? [option("--adapter")!] : []), null, 2));
  } else if (command === "doctor") {
    let github = false;
    try { execFileSync("gh", ["auth", "status"], { stdio: "ignore" }); github = true; } catch { /* reported below */ }
    console.log(JSON.stringify({ apiConfiguration: preflight(), corpus: db.getTrails().length, database: true, github, mcpCommand: "node apps/mcp/dist/index.js" }, null, 2));
  } else if (command === "verify-pr") {
    const repo = option("--repo");
    const sha = option("--sha");
    const state = option("--state") as "pending" | "success" | "failure" | undefined;
    const bundleId = option("--bundle");
    if (!repo || !sha || !state || !["pending", "success", "failure"].includes(state)) throw new Error("Usage: trail verify-pr --repo owner/name --sha COMMIT --state pending|success|failure [--bundle ID]");
    if (state === "success") {
      const bundle = bundleId ? db.getContextBundle(bundleId) : null;
      assertSuccessEligible(bundle, bundleId ? db.getEvidenceObservations(bundleId) : []);
    }
    console.log(JSON.stringify(publishVerificationStatus({ repo, sha, state, description: option("--description") ?? `TRAIL verification ${state}` }), null, 2));
  } else {
    console.log("TRAIL CLI\n  trail context --task \"...\" [--workspace PATH]\n  trail recover --bundle ID --failure \"...\"\n  trail verify --bundle ID [--workspace PATH]\n  trail doctor\n  trail ingest --scan\n  trail ingest <transcript.jsonl>\n  trail benchmark\n  trail eval [--repetitions 3]\n  trail eval-codex [--repetitions 1] [--api-base URL] [--model MODEL]\n  trail run\n  trail verify-pr --repo owner/name --sha COMMIT --state pending|success|failure [--bundle ID]");
  }
} finally {
  db.close();
}
