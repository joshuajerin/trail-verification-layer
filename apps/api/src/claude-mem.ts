import { previewTranscript } from "./adapters.js";

const maxContextBytes = 120_000;
const emptyContextPattern = /this project has no memory yet|memory injection starts on your second session|no previous sessions found/i;

export type ClaudeMemContext = {
  status: "available" | "empty" | "unavailable";
  project: string;
  sourceName: string;
  reason?: string;
  preview?: ReturnType<typeof previewTranscript>;
};

type ClaudeMemOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
};

function localClaudeMemUrl(value: string) {
  const url = new URL(value);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
    throw new Error("Claude Mem must use a loopback http:// endpoint.");
  }
  return url;
}

function sourceName(project: string) {
  return `claude-mem:${project}`;
}

/**
 * Reads only the locally running Claude Mem worker. The returned text is
 * immediately redacted into an IngestionPreview and still requires human
 * review, so an unreviewed memory snapshot can never become agent authority.
 */
export async function ingestClaudeMemContext(project: string, options: ClaudeMemOptions = {}): Promise<ClaudeMemContext> {
  const normalizedProject = project.trim();
  if (!normalizedProject) return { status: "unavailable", project: normalizedProject, sourceName: sourceName("unknown"), reason: "A Claude Mem project is required." };

  const fetcher = options.fetcher ?? fetch;
  let base: URL;
  try {
    base = localClaudeMemUrl(options.baseUrl ?? process.env.TRAIL_CLAUDE_MEM_URL ?? "http://127.0.0.1:37701");
  } catch (error) {
    return { status: "unavailable", project: normalizedProject, sourceName: sourceName(normalizedProject), reason: error instanceof Error ? error.message : "Invalid Claude Mem endpoint." };
  }

  try {
    const health = await fetcher(new URL("/health", base), { signal: AbortSignal.timeout(3_000) });
    if (!health.ok) return { status: "unavailable", project: normalizedProject, sourceName: sourceName(normalizedProject), reason: `Claude Mem health returned HTTP ${health.status}.` };

    const contextUrl = new URL("/api/context/inject", base);
    contextUrl.searchParams.set("project", normalizedProject);
    contextUrl.searchParams.set("full", "true");
    const response = await fetcher(contextUrl, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return { status: "unavailable", project: normalizedProject, sourceName: sourceName(normalizedProject), reason: `Claude Mem context returned HTTP ${response.status}.` };

    const raw = (await response.text()).slice(0, maxContextBytes);
    if (!raw.trim() || emptyContextPattern.test(raw)) {
      return { status: "empty", project: normalizedProject, sourceName: sourceName(normalizedProject), reason: "Claude Mem has no saved observations for this project." };
    }
    return { status: "available", project: normalizedProject, sourceName: sourceName(normalizedProject), preview: previewTranscript(sourceName(normalizedProject), raw) };
  } catch {
    return { status: "unavailable", project: normalizedProject, sourceName: sourceName(normalizedProject), reason: "Claude Mem is not reachable at its local endpoint." };
  }
}
