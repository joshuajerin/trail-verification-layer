import { useState } from "react";
import type { ContextBundle, Trigger } from "@trail/contracts";
import { api } from "./api";

type ContextHealth = {
  extractorModel: string;
};

type CompileResult = {
  bundle: ContextBundle;
  provider: { intentExtraction: boolean; reranked: boolean };
};

function DirectiveList({ bundle, type, empty }: { bundle: ContextBundle; type: "required_action" | "completion_criterion" | "negative_constraint"; empty: string }) {
  const items = bundle.directives.filter((item) => item.type === type);
  if (!items.length) return <p className="empty-copy">{empty}</p>;
  return <ol>{items.map((item) => <li key={item.id}><span>{type === "negative_constraint" ? item.source.sourceQuote : item.text}</span><small>{item.source.kind === "current_request" ? "CURRENT REQUEST" : `TRAIL · ${item.source.trailId}`}</small></li>)}</ol>;
}

export function ContextView({ health }: { health: ContextHealth | null }) {
  const [task, setTask] = useState("Fix the production route in the user-visible service checkout. Do not edit a copied checkout. Prove the browser-visible result before release.");
  const [workspacePath, setWorkspacePath] = useState("");
  const [environment, setEnvironment] = useState({ client: "codex", workspace: "service-live", branch: "", host: "" });
  const [trigger, setTrigger] = useState<Trigger>("start");
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState<CompileResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const compile = async () => {
    setBusy(true); setError(""); setCopied(false);
    try {
      const explicitEnvironment = Object.fromEntries(Object.entries(environment).filter(([, value]) => value.trim()));
      const body = { task, trigger, environment: explicitEnvironment, evidenceState: {}, ...(workspacePath.trim() ? { workspace: workspacePath.trim() } : {}), ...(trigger === "failure" && failure.trim() ? { failure: failure.trim() } : {}) };
      setResult(await api<CompileResult>("/api/context/compile", { method: "POST", body: JSON.stringify(body) }));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Context compilation failed"); }
    finally { setBusy(false); }
  };

  const bundle = result?.bundle;
  const copyPrompt = async () => {
    if (!bundle) return;
    await navigator.clipboard.writeText(bundle.compiledPrompt);
    setCopied(true);
  };

  return (
    <div className="view context-view">
      <section className="context-hero">
        <div>
          <p className="eyebrow">EXTERNAL HUMAN CONTEXT FOR CODING AGENTS</p>
          <h1>Turn a normal request into an<br /><em>execution brief the agent can follow.</em></h1>
          <p>TRAIL retrieves reviewed lessons from prior Codex and Claude runs, preserves what the human meant, makes negative constraints explicit, and defines the proof required before completion.</p>
        </div>
        <div className="context-flow" aria-label="TRAIL context flow"><span>Your request</span><b>→</b><span>Human lessons</span><b>→</b><span>Agent brief</span><b>→</b><span>Verification</span></div>
      </section>

      <section className="context-workbench">
        <div className="prompt-builder panel">
          <div className="section-heading"><div><span>01 · CURRENT REQUEST</span><h2>What should the agent do?</h2></div><small>Preserved verbatim · highest priority</small></div>
          <textarea aria-label="Task prompt" value={task} onChange={(event) => setTask(event.target.value)} />
          <div className="trigger-row" aria-label="Context trigger">
            {(["start", "failure", "release"] as Trigger[]).map((item) => <button key={item} className={trigger === item ? "active" : ""} onClick={() => setTrigger(item)}>{item === "start" ? "Task start" : item === "failure" ? "After failure" : "Pre-release"}</button>)}
          </div>
          {trigger === "failure" && <input aria-label="Observed failure" value={failure} onChange={(event) => setFailure(event.target.value)} placeholder="Paste the observed error or failed evidence…" />}
          <div className="environment-fields">
            <label><span>Local path</span><input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="Auto-detect API workspace" /></label>
            <label><span>Client</span><input value={environment.client} onChange={(event) => setEnvironment({ ...environment, client: event.target.value })} /></label>
            <label><span>Workspace identity</span><input value={environment.workspace} onChange={(event) => setEnvironment({ ...environment, workspace: event.target.value })} /></label>
            <label><span>Branch</span><input value={environment.branch} onChange={(event) => setEnvironment({ ...environment, branch: event.target.value })} placeholder="Auto-detect" /></label>
          </div>
          <button className="primary build-context" disabled={busy || task.trim().length < 3} onClick={() => void compile()}>{busy ? `Building with ${health?.extractorModel ?? "provider"}…` : "Build agent context"}<span>→</span></button>
          {error && <p className="error-copy">{error}</p>}
        </div>

        <aside className="source-panel panel">
          <span>02 · RETRIEVAL</span><h2>{bundle ? bundle.matchedTrails.length ? `${bundle.matchedTrails.length} human trail${bundle.matchedTrails.length > 1 ? "s" : ""} matched` : "No trail forced" : "Waiting for a request"}</h2>
          {!bundle && <p>TRAIL filters by the real environment first, then ranks intent and failure shape. A vague near-match is rejected.</p>}
          {bundle?.matchedTrails.map((trail) => <article key={trail.id}><b>{trail.title}</b><p>{trail.reasons.join(" · ")}</p><small>{trail.provider.toUpperCase()} · {trail.sourceRange}</small></article>)}
          {bundle && <div className={`context-status status-${bundle.status}`}><i />{bundle.status.replaceAll("_", " ")}</div>}
          {bundle && <dl className="detected-environment">
            {(["path", "repository", "branch", "head", "client", "runtime"] as const).map((key) => bundle.environment[key] ? <div key={key}><dt>{key}</dt><dd title={bundle.environment[key]}>{bundle.environment[key]}</dd></div> : null)}
          </dl>}
          {bundle?.missingEnvironment.length ? <p className="missing-context">Inspect before retrying: <strong>{bundle.missingEnvironment.join(", ")}</strong></p> : null}
          {bundle?.rejectedTrails.slice(0, 2).map((trail) => <details key={trail.id}><summary>Rejected: {trail.title}</summary><p>{trail.reasons.join(" · ")}</p></details>)}
        </aside>
      </section>

      {bundle && <section className="brief-section">
        <div className="brief-heading"><div><p className="eyebrow">03 · SOURCE-BACKED EXECUTION BRIEF</p><h2>The agent now has a trail to return to.</h2></div><div><code>{bundle.id.slice(0, 8)}</code><button className="secondary" onClick={() => void copyPrompt()}>{copied ? "Copied" : "Copy agent prompt"}</button></div></div>
        <div className="brief-grid">
          <article className="brief-card do"><span>DO</span><DirectiveList bundle={bundle} type="required_action" empty="Follow the current request exactly." /><DirectiveList bundle={bundle} type="completion_criterion" empty="" /></article>
          <article className="brief-card dont"><span>DO NOT</span><DirectiveList bundle={bundle} type="negative_constraint" empty="Do not expand scope or invent proof." /></article>
          <article className="brief-card route"><span>ROUTE</span>{bundle.route.length ? <ol>{bundle.route.map((step) => <li key={`${step.trailId}-${step.id}`}><span>{step.action}</span><small>{step.tool.toUpperCase()} · failure: {step.onFailure}</small></li>)}</ol> : <p className="empty-copy">No historical route cleared the threshold. Continue with the bounded baseline route.</p>}</article>
          <article className="brief-card evidence"><span>EVIDENCE REQUIRED</span>{bundle.evidence.length ? <ol>{bundle.evidence.map((item) => <li key={item.id}><span>{item.description}</span><small>{item.kind.toUpperCase()} · expected: {item.expected}</small></li>)}</ol> : <p className="empty-copy">Inspect the environment, changed scope, and requested checks before completion.</p>}</article>
        </div>
        <div className="compiled-prompt panel"><div><span>COMPILED CONTEXT</span><small>Deterministic template · agent-readable</small></div><pre>{bundle.compiledPrompt}</pre></div>
      </section>}
    </div>
  );
}
