#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const trails = JSON.parse(readFileSync(resolve(root, "corpus/public/seed-trails.json"), "utf8"));
const argument = process.argv.slice(2);
const valueAfter = (name) => {
  const index = argument.indexOf(name);
  return index >= 0 ? argument[index + 1] : undefined;
};
const database = valueAfter("--database") ?? process.env.TRAIL_POSTGRES_DATABASE;
const connection = valueAfter("--url") ?? process.env.TRAIL_POSTGRES_URL;
const outputSql = argument.includes("--output-sql");

if (!outputSql && !database && !connection) {
  console.error("Usage: node scripts/seed-postgres.mjs --database trail_knowledge  OR  TRAIL_POSTGRES_URL=postgresql://… node scripts/seed-postgres.mjs  OR  --output-sql");
  process.exit(1);
}

const base64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64");
const text = (value) => `convert_from(decode('${base64(String(value))}', 'base64'), 'utf8')`;
const json = (value) => `convert_from(decode('${base64(value)}', 'base64'), 'utf8')::jsonb`;
const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const collectionId = "9f4a4f52-89b9-4f56-b58b-4c2bf4b0d6a1";

const statements = [
  "begin;",
  `insert into knowledge_collections (id, slug, name, visibility) values ('${collectionId}', 'trail-reviewed', 'TRAIL reviewed human context', 'public') on conflict (slug) do update set name = excluded.name, visibility = excluded.visibility, updated_at = now();`,
];

for (const trail of trails.filter((item) => item.reviewStatus === "approved" && item.provenance?.redacted === true)) {
  statements.push(`delete from trail_directives where trail_id = ${text(trail.id)};`);
  statements.push(`delete from trail_evidence_gates where trail_id = ${text(trail.id)};`);
  statements.push(`delete from trail_workflow_steps where trail_id = ${text(trail.id)};`);
  statements.push(`insert into knowledge_trails (id, collection_id, schema_version, title, summary, task_family, intent, environment, provenance, contract, review_status, redacted, confidence, contract_sha256, reviewed_at, published_at)
    values (${text(trail.id)}, '${collectionId}', ${text(trail.schemaVersion)}, ${text(trail.title)}, ${text(trail.summary)}, ${text(trail.taskFamily)}, ${text(trail.intent)}, ${json(trail.environment)}, ${json(trail.provenance)}, ${json(trail)}, ${text(trail.reviewStatus)}, true, ${Number(trail.confidence)}, ${text(sha256(trail))}, ${trail.reviewedAt ? `${text(trail.reviewedAt)}::timestamptz` : "null"}, now())
    on conflict (id) do update set title = excluded.title, summary = excluded.summary, task_family = excluded.task_family, intent = excluded.intent, environment = excluded.environment, provenance = excluded.provenance, contract = excluded.contract, review_status = excluded.review_status, confidence = excluded.confidence, contract_sha256 = excluded.contract_sha256, reviewed_at = excluded.reviewed_at, published_at = excluded.published_at, updated_at = now();`);

  const directives = [
    ...trail.preconditions.map((value, ordinal) => ["precondition", value, ordinal]),
    ...trail.negativeConstraints.map((value, ordinal) => ["negative_constraint", value, ordinal]),
    ...trail.applicability.map((value, ordinal) => ["applicability", value, ordinal]),
    ...trail.invalidators.map((value, ordinal) => ["invalidator", value, ordinal]),
    ["outcome", trail.outcome, 0],
  ];
  for (const [directiveType, directiveText, ordinal] of directives) {
    statements.push(`insert into trail_directives (trail_id, directive_type, directive_text, source_range, ordinal) values (${text(trail.id)}, ${text(directiveType)}, ${text(directiveText)}, ${text(trail.provenance.sourceRange)}, ${Number(ordinal)});`);
  }
  for (const [ordinal, step] of trail.steps.entries()) {
    statements.push(`insert into trail_workflow_steps (trail_id, step_id, ordinal, action, tool, on_failure) values (${text(trail.id)}, ${text(step.id)}, ${ordinal}, ${text(step.action)}, ${text(step.tool)}, ${text(step.onFailure)});`);
    for (const evidence of step.evidence) {
      statements.push(`insert into trail_evidence_gates (trail_id, step_id, evidence_id, evidence_kind, description, expected, required) values (${text(trail.id)}, ${text(step.id)}, ${text(evidence.id)}, ${text(evidence.kind)}, ${text(evidence.description)}, ${text(evidence.expected)}, ${Boolean(evidence.required)});`);
    }
  }
}

statements.push(`insert into knowledge_syncs (collection_id, source, summary) values ('${collectionId}', 'public-seed-corpus', ${json({ approvedTrails: trails.filter((item) => item.reviewStatus === "approved").length, rawTranscriptsUploaded: false, policy: "review-before-retrieval" })});`);
statements.push("commit;");

if (outputSql) {
  process.stdout.write(`${statements.join("\n")}\n`);
  process.exit(0);
}

const psqlArgs = ["-v", "ON_ERROR_STOP=1", "-X"];
if (connection) psqlArgs.push(connection);
else psqlArgs.push("-d", database);
const run = spawnSync("psql", psqlArgs, { input: statements.join("\n"), encoding: "utf8" });
if (run.status !== 0) {
  process.stderr.write(run.stderr || run.stdout || "PostgreSQL seed failed.\n");
  process.exit(run.status ?? 1);
}
console.log(JSON.stringify({ database: connection ? "TRAIL_POSTGRES_URL" : database, approvedTrails: trails.filter((item) => item.reviewStatus === "approved").length, rawTranscriptsUploaded: false }, null, 2));
