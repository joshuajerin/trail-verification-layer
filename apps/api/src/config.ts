import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export const projectRoot = resolve(import.meta.dirname, "../../..");

if (process.env.NODE_ENV !== "test") {
  try { loadEnvFile(resolve(projectRoot, ".env")); } catch { /* Local configuration is optional. */ }
}

const openAiKey = process.env.OPENAI_API_KEY ?? "";
const openAiBaseUrl = process.env.OPENAI_BASE_URL ?? "";
const modalProxyCredentialComplete = !openAiBaseUrl.includes("modal.direct") || openAiKey.includes(".ws-");
const providerLabel = process.env.TRAIL_PROVIDER_LABEL ?? (openAiBaseUrl.includes("modal.direct") ? "K3" : "OpenAI");

export const config = {
  port: Number(process.env.TRAIL_API_PORT ?? 4317),
  allowedOrigin: process.env.TRAIL_ALLOWED_ORIGIN ?? "",
  databasePath: process.env.TRAIL_DATABASE_PATH ?? resolve(projectRoot, ".trail/trail.db"),
  postgresUrl: process.env.TRAIL_POSTGRES_URL ?? "",
  corpusPath: resolve(projectRoot, "corpus/public"),
  benchmarkPath: resolve(projectRoot, "benchmarks"),
  openAiKey,
  openAiBaseUrl,
  agentModel: process.env.OPENAI_AGENT_MODEL ?? "gpt-5.6-terra",
  extractorModel: process.env.OPENAI_EXTRACTOR_MODEL ?? "gpt-5.6-luna",
  providerLabel,
  reasoningEffort: (process.env.OPENAI_REASONING_EFFORT ?? "medium") as "low" | "medium" | "high",
  codexSessionsPath: resolve(process.env.HOME ?? "", ".codex/sessions"),
  claudeSessionsPath: resolve(process.env.HOME ?? "", ".claude/projects"),
  apiKey: process.env.TRAIL_API_KEY ?? "",
  ciKey: process.env.TRAIL_CI_KEY ?? "",
  requireApiKey: process.env.TRAIL_REQUIRE_API_KEY === "true" || process.env.NODE_ENV === "production",
  rateLimitMax: Number(process.env.TRAIL_RATE_LIMIT_MAX ?? 120),
  rateLimitWindow: process.env.TRAIL_RATE_LIMIT_WINDOW ?? "1 minute",
  privateHistory: process.env.TRAIL_PRIVATE_HISTORY === "true",
  routeSessionTtlMs: Number(process.env.TRAIL_ROUTE_SESSION_TTL_MS ?? 15 * 60 * 1000),
};

export function preflight() {
  const missing = !config.openAiKey
    ? ["OPENAI_API_KEY"]
    : !modalProxyCredentialComplete
      ? ["Modal proxy token secret (.ws-… portion)"]
      : [];
  return {
    ready: missing.length === 0,
    liveAi: missing.length === 0,
    agentModel: config.agentModel,
    extractorModel: config.extractorModel,
    providerLabel: config.providerLabel,
    missing,
    deterministicHarness: true,
    sourceRoots: {
      codex: existsSync(config.codexSessionsPath),
      claude: existsSync(config.claudeSessionsPath),
    },
    routerAuth: config.requireApiKey ? (config.apiKey ? "configured" : "missing") : "local-development",
  };
}
