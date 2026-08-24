import { useEffect, useMemo, useRef, useState } from "react";
import type { IngestionPreview, RetrievalPolicy, RunEvent, RunMetrics, Trail } from "@trail/contracts";
import { api, eventStream } from "./api";
import { ContextView } from "./ContextView";

type Tab = "context" | "proof" | "corpus" | "ingest" | "policy";
type Health = {
  status: string;
  corpusCount: number;
  ready: boolean;
  liveAi: boolean;
  agentModel: string;
  extractorModel: string;
  missing: string[];
  deterministicHarness: boolean;
  sourceRoots: { codex: boolean; claude: boolean };
  sourceIndex: { total: number; providers: Array<{ provider: string; count: number; bytes: number }>; signals: Record<string, number> };
};
type IngestionRecord = {
  id: string;
  format: IngestionPreview["format"];
  sourceName: string;
  status: "previewed" | "drafted" | "approved";
  trailId: string | null;
  redactionCount: number;
  candidateSignals: string[];
  requiresReview: boolean;
  createdAt: string;
};
type SourceCandidate = {
  pathHash: string;
  provider: string;
  sourceName: string;
  sizeBytes: number;
  modifiedAt: string;
  signals: string[];
  score: number;
};
type SourceInventory = {
  total: number;
  providers: Array<{ provider: string; count: number; bytes: number }>;
  signals: Record<string, number>;
  shortlist: SourceCandidate[];
  roots: { codex: boolean; claude: boolean };
};
type ResearchCorpus = {
  status: "ready" | "not-indexed";
  source: { id: string; dataset: string; expectedRows: number; compilationLicense: string; itemLicensePolicy: string; trustTier: string };
  stats: null | { rowsSeen?: number; uniqueSkills?: number; quarantined?: number; rowsRejected?: number };
  safety: { executable: false; promotable: false; rawBodiesReturnedByApi: false; automaticPromotion: false };
};
type RunRecord = { id: string; status: string; executor: string; metrics: Record<string, RunMetrics> };
type Benchmark = {
  executor: string;
  disclaimer: string;
  endToEndRuns: number;
  metrics: {
    baselineVerified: { numerator: number; denominator: number };
    guidedVerified: { numerator: number; denominator: number };
    unsafeApprovals: { baseline: number; guided: number };
    recallAt1: number;
    recallAt3: number;
    mrr: number;
  };
};

const navigation: Array<{ id: Tab; label: string }> = [
  { id: "context", label: "Build context" },
  { id: "proof", label: "Live proof" },
  { id: "corpus", label: "Skill library" },
  { id: "ingest", label: "Data intake" },
  { id: "policy", label: "RSI policy" },
];

function Mark() {
  return (
    <div className="mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function StatusPill({ live }: { live: boolean }) {
  return <span className={`status-pill ${live ? "live" : "offline"}`}><i />{live ? "OpenAI ready" : "AI key missing"}</span>;
}

function AppShell({ tab, setTab, health, children }: { tab: Tab; setTab: (tab: Tab) => void; health: Health | null; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" aria-label="TRAIL skill library" onClick={() => setTab("corpus")}><Mark /><span>TRAIL</span><small>Trajectory Retrieval & Intent Alignment Layer</small></button>
        <nav aria-label="Primary navigation">
          {navigation.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </nav>
        <StatusPill live={Boolean(health?.liveAi)} />
      </header>
      <main>{children}</main>
    </div>
  );
}

function EventCard({ event }: { event: RunEvent }) {
  const label: Record<RunEvent["type"], string> = {
    run_started: "Start", observation: "Observe", retrieval: "Retrieve", action: "Act", gate_blocked: "Blocked",
    gate_passed: "Verified", reroute: "Reroute", run_finished: "Finish", error: "Error",
  };
  return (
    <article className={`event-card event-${event.type}`}>
      <span>{label[event.type]}</span>
      <p>{event.message}</p>
      {event.type === "retrieval" && Array.isArray(event.detail.reasons) && <ul>{(event.detail.reasons as string[]).map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    </article>
  );
}

function AgentLane({ side, events, metrics, running }: { side: "baseline" | "guided"; events: RunEvent[]; metrics: RunMetrics | undefined; running: boolean }) {
  const guided = side === "guided";
  return (
    <section className={`agent-lane ${guided ? "guided" : "baseline"}`}>
      <div className="lane-heading">
        <div><small>{guided ? "WITH TRAIL" : "WITHOUT TRAIL"}</small><h2>{guided ? "Evidence-routed agent" : "Baseline agent"}</h2></div>
        <span className={`lane-state ${running ? "running" : metrics?.verified ? "passed" : events.length ? "blocked" : "idle"}`}>
          {running ? "Running" : metrics?.verified ? "Release eligible" : events.length ? "Release blocked" : "Waiting"}
        </span>
      </div>
      <div className="event-stream">
        {events.length === 0 && <div className="empty-stream"><span>{guided ? "The trail appears here." : "Raw decisions appear here."}</span></div>}
        {events.map((event) => <EventCard key={`${event.runId}-${event.sequence}`} event={event} />)}
      </div>
      <div className="lane-metrics">
        <div><strong>{metrics?.toolCalls ?? "—"}</strong><span>tool calls</span></div>
        <div><strong>{metrics?.retries ?? "—"}</strong><span>retries</span></div>
        <div><strong>{metrics ? `${metrics.elapsedMs}ms` : "—"}</strong><span>elapsed</span></div>
        <div><strong>{metrics ? `$${metrics.estimatedCostUsd.toFixed(4)}` : "—"}</strong><span>API cost</span></div>
      </div>
    </section>
  );
}

function ProofView({ health }: { health: Health | null }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [benchmark, setBenchmark] = useState<Benchmark | null>(null);

  useEffect(() => { void api<Benchmark>("/api/benchmarks/run", { method: "POST", body: "{}" }).then(setBenchmark).catch(() => undefined); }, []);

  const start = async (executor: "deterministic-fixture" | "openai-responses") => {
    setEvents([]); setRun(null); setError(""); setRunning(true);
    try {
      const created = await api<{ runId: string }>("/api/runs", { method: "POST", body: JSON.stringify({ executor }) });
      const stream = eventStream(`/api/runs/${created.runId}/events`);
      stream.onmessage = (message) => setEvents((current) => [...current, JSON.parse(message.data) as RunEvent]);
      stream.addEventListener("complete", (message) => {
        const completed = JSON.parse((message as MessageEvent).data) as RunRecord;
        setRun(completed); setRunning(false); stream.close();
      });
      stream.onerror = () => { if (stream.readyState === EventSource.CLOSED) setRunning(false); };
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Run failed"); setRunning(false); }
  };

  const baselineEvents = events.filter((event) => event.side === "baseline");
  const guidedEvents = events.filter((event) => event.side === "guided");
  const selected = guidedEvents.find((event) => event.type === "retrieval");
  const baselineRate = benchmark ? Math.round(benchmark.metrics.baselineVerified.numerator / benchmark.metrics.baselineVerified.denominator * 100) : 0;
  const guidedRate = benchmark ? Math.round(benchmark.metrics.guidedVerified.numerator / benchmark.metrics.guidedVerified.denominator * 100) : 0;

  return (
    <div className="view proof-view">
      <section className="hero">
        <div>
          <p className="eyebrow">RUNTIME VERIFICATION FOR CODING AGENTS</p>
          <h1>Give the agent a trail.<br /><em>Require proof at every turn.</em></h1>
          <p className="hero-copy">TRAIL converts prior agent failures into machine-readable routes, retrieves only the routes that fit the current environment, and blocks release until the expected evidence exists.</p>
        </div>
        <div className="hero-actions">
          <button className="primary" disabled={running} onClick={() => void start("deterministic-fixture")}>{running ? "Proof running…" : "Run deterministic proof"}<span>→</span></button>
          <button className="secondary" disabled={running || !health?.liveAi} onClick={() => void start("openai-responses")}>Run live OpenAI pair</button>
          {!health?.liveAi && <p>Live run unavailable: <code>{health?.missing.join(", ") || "provider preflight"}</code>. Nothing is simulated as AI.</p>}
          {error && <p className="error-copy">{error}</p>}
        </div>
      </section>

      <section className="task-strip">
        <div><span>SHARED TASK</span><strong>Fix the production route, prove the visible result, and prepare the PR for release.</strong></div>
        <div><span>MODEL</span><strong>{health?.agentModel ?? "gpt-5.6-terra"}</strong></div>
        <div><span>START</span><strong>Same fixture / same budget</strong></div>
      </section>

      <div className="lane-grid">
        <AgentLane side="baseline" events={baselineEvents} metrics={run?.metrics.baseline} running={running} />
        <AgentLane side="guided" events={guidedEvents} metrics={run?.metrics.guided} running={running} />
      </div>

      <section className="proof-footer-grid">
        <div className="trail-match panel">
          <div className="panel-title"><span>RETRIEVED ROUTE</span><b>{selected ? "MATCHED" : "WAITING"}</b></div>
          <h3>{selected ? selected.message.replace(/^Retrieved | with environment-first routing\.$/g, "") : "No trail selected yet"}</h3>
          <p>{selected ? "The route was admitted after mandatory workspace and client checks, then ranked by intent and failure language." : "Start the paired proof to see environment-first retrieval and rejected near-matches."}</p>
        </div>
        <div className="pr-panel panel">
          <div className="panel-title"><span>PRE-MERGE STATUS</span><b className={run?.metrics.guided?.verified ? "green" : "amber"}>{run?.metrics.guided?.verified ? "PASS" : "NOT PUBLISHED"}</b></div>
          <h3><code>trail/verification</code></h3>
          <p>The local proof never impersonates GitHub. Use <code>trail verify-pr</code> with an exact repository and SHA to publish the real commit status.</p>
        </div>
      </section>

      <section className="benchmark panel">
        <div className="benchmark-heading">
          <div><p className="eyebrow">HACKATHON BENCHMARK · DETERMINISTIC FIXTURES</p><h2>The route layer changes the outcome.</h2></div>
          <p>{benchmark?.disclaimer ?? "Loading fixture benchmark…"}</p>
        </div>
        <div className="benchmark-metrics">
          <div><strong>{baselineRate}%</strong><span>Baseline verified</span><small>{benchmark ? `${benchmark.metrics.baselineVerified.numerator}/${benchmark.metrics.baselineVerified.denominator}` : "—"}</small></div>
          <div className="accent"><strong>{guidedRate}%</strong><span>Guided verified</span><small>{benchmark ? `${benchmark.metrics.guidedVerified.numerator}/${benchmark.metrics.guidedVerified.denominator}` : "—"}</small></div>
          <div><strong>{benchmark ? `${Math.round(benchmark.metrics.recallAt1 * 100)}%` : "—"}</strong><span>Recall@1</span><small>24 held-out prefixes</small></div>
          <div><strong>{benchmark?.metrics.mrr ?? "—"}</strong><span>MRR</span><small>Retrieval ranking</small></div>
          <div><strong>{benchmark?.metrics.unsafeApprovals.guided ?? "—"}</strong><span>Unsafe approvals</span><small>Guided condition</small></div>
        </div>
      </section>
    </div>
  );
}

type SkillDefinition = {
  id: string;
  name: string;
  description: string;
  families: string[];
};
type SkillIngestion = {
  id: string;
  status: "scanning" | "completed" | "failed";
  rootPath: string;
  expectedTotal: number | null;
  discovered: number;
  indexed: number;
  skipped: number;
  errors: number;
  bytes: number;
  skillCount: number;
  subskillCount: number;
  ratePerSecond: number;
  currentPath: string;
  recent: Array<{ sourceName: string; skill: string; subskill: string; indexedAt: string }>;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
};

const skillDefinitions: SkillDefinition[] = [
  {
    id: "orient",
    name: "Orient",
    description: "Resolve where the work belongs before the agent takes action.",
    families: ["environment-routing", "client-surface", "deployment-auth", "provider-readiness", "dependency-integrity"],
  },
  {
    id: "execute",
    name: "Execute",
    description: "Carry intent forward without expanding authority or losing constraints.",
    families: ["scope-contract", "failure-recovery", "artifact-integrity", "harness-safety"],
  },
  {
    id: "prove",
    name: "Prove",
    description: "Verify the outcome at the real acceptance surface before release.",
    families: ["release-verification", "runtime-proof", "runtime-diagnosis", "hardware-proof"],
  },
];
const initialSkill = skillDefinitions[0]!;
const initialSubskill = initialSkill.families[0]!;

function displayName(value: string) {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

const numberFormatter = new Intl.NumberFormat("en-US");

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(1)} GB`;
}

function connectIngestionStream(id: string, onJob: (job: SkillIngestion) => void, onError: (message: string) => void) {
  const stream = eventStream(`/api/skill-ingestions/${id}/events`);
  stream.onmessage = (message) => onJob(JSON.parse(message.data) as SkillIngestion);
  stream.addEventListener("complete", (message) => {
    onJob(JSON.parse((message as MessageEvent).data) as SkillIngestion);
    stream.close();
  });
  stream.onerror = () => {
    if (stream.readyState === EventSource.CLOSED) onError("The live stream closed before ingestion completed.");
  };
  return stream;
}

function LiveIngestionPanel() {
  const [rootPath, setRootPath] = useState("");
  const [expectedTotal, setExpectedTotal] = useState("318000");
  const [job, setJob] = useState<SkillIngestion | null>(null);
  const [error, setError] = useState("");
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let active = true;
    void api<{ job: SkillIngestion | null }>("/api/skill-ingestions/latest").then((result) => {
      if (!active || !result.job) return;
      setJob(result.job);
      if (result.job.status === "scanning") {
        streamRef.current = connectIngestionStream(result.job.id, setJob, setError);
      }
    }).catch(() => undefined);
    return () => { active = false; streamRef.current?.close(); };
  }, []);

  const start = async () => {
    setError("");
    streamRef.current?.close();
    try {
      const total = Number.parseInt(expectedTotal.replaceAll(",", ""), 10);
      const body = { rootPath: rootPath.trim(), ...(Number.isFinite(total) && total > 0 ? { expectedTotal: total } : {}) };
      const result = await api<{ job: SkillIngestion }>("/api/skill-ingestions", { method: "POST", body: JSON.stringify(body) });
      setJob(result.job);
      streamRef.current = connectIngestionStream(result.job.id, setJob, setError);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to start ingestion.");
    }
  };

  const running = job?.status === "scanning";
  const expected = job?.expectedTotal ?? null;
  const progress = job ? job.status === "completed" ? 100 : expected ? Math.min(99.5, job.discovered / expected * 100) : 0 : 0;

  return (
    <section className={`live-ingestion ${running ? "is-running" : ""}`} aria-label="Live SKILL.md ingestion">
      <div className="ingestion-intro">
        <div className="ingestion-title"><span className="live-dot" aria-hidden="true" /><div><small>LIVE DATA INGESTION</small><h2>Index a skill corpus as it arrives.</h2></div></div>
        <p>Point TRAIL at any local folder. It discovers nested <code>SKILL.md</code> files, extracts hierarchy metadata, and writes in batches without loading the corpus into the browser.</p>
        <div className="ingestion-form">
          <label><span>Corpus folder</span><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="C:\\data\\skill-library" disabled={running} /></label>
          <label className="expected-field"><span>Expected files</span><input inputMode="numeric" value={expectedTotal} onChange={(event) => setExpectedTotal(event.target.value.replace(/[^\d,]/g, ""))} placeholder="Optional" disabled={running} /></label>
          <button onClick={() => void start()} disabled={running || !rootPath.trim()}>{running ? "Ingesting…" : "Start ingestion"}<span aria-hidden="true">→</span></button>
        </div>
        <div className="ingestion-safety"><span>LOCAL</span><p>Metadata only. Handles the 318K target corpus and the pinned 138,133-row SkillMD source without an OpenAI key or model call.</p></div>
      </div>

      <div className="ingestion-monitor" aria-live="polite">
        <header><div><span className={`monitor-state state-${job?.status ?? "idle"}`}>{job?.status ?? "Ready"}</span><strong>{job ? `${numberFormatter.format(job.indexed)} indexed` : "Waiting for a corpus"}</strong></div>{job && <small>{numberFormatter.format(job.ratePerSecond)} files/sec</small>}</header>
        <div className={`ingestion-progress ${expected ? "determinate" : "indeterminate"}`}><i style={{ width: expected || job?.status === "completed" ? `${progress}%` : undefined }} /></div>
        <p className="current-ingestion-path" title={job?.currentPath}>{job?.currentPath ?? "Choose a folder to begin a live scan."}</p>
        <dl className="ingestion-metrics">
          <div><dt>{job ? numberFormatter.format(job.discovered) : "—"}</dt><dd>discovered</dd></div>
          <div><dt>{job ? numberFormatter.format(job.skillCount) : "—"}</dt><dd>skills</dd></div>
          <div><dt>{job ? numberFormatter.format(job.subskillCount) : "—"}</dt><dd>subskills</dd></div>
          <div><dt>{job ? formatBytes(job.bytes) : "—"}</dt><dd>source size</dd></div>
        </dl>
        <div className="ingestion-activity">
          <div><span>RECENT ACTIVITY</span>{job && <small>{job.errors ? `${job.errors} errors` : "No errors"}</small>}</div>
          {job?.recent.length ? <ol>{job.recent.slice(0, 6).map((item) => <li key={`${item.sourceName}-${item.indexedAt}`}><i /><div><strong>{item.skill}</strong><span>{item.subskill} · {item.sourceName}</span></div></li>)}</ol> : <p>Newly indexed skills will appear here.</p>}
        </div>
        {error && <p className="ingestion-error">{error}</p>}
        {job?.error && <p className="ingestion-error">{job.error}</p>}
      </div>
    </section>
  );
}

function SkillLibraryView({ trails }: { trails: Trail[] }) {
  const [query, setQuery] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState(initialSkill.id);
  const [selectedSubskill, setSelectedSubskill] = useState(initialSubskill);
  const [selectedTrailId, setSelectedTrailId] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return trails;
    return trails.filter((trail) => [trail.title, trail.summary, trail.intent, trail.taskFamily, ...trail.tags].join(" ").toLowerCase().includes(normalized));
  }, [trails, query]);

  const skills = useMemo(() => {
    const known = new Set(skillDefinitions.flatMap((skill) => skill.families));
    const otherFamilies = [...new Set(trails.map((trail) => trail.taskFamily).filter((family) => !known.has(family)))].sort();
    return otherFamilies.length ? [...skillDefinitions, { id: "specialized", name: "Specialized", description: "Domain-specific operational knowledge that does not fit a shared execution layer.", families: otherFamilies }] : skillDefinitions;
  }, [trails]);

  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? skills[0] ?? initialSkill;
  const activeTrails = useMemo(() => visible.filter((trail) => trail.taskFamily === selectedSubskill), [visible, selectedSubskill]);
  const selectedTrail = activeTrails.find((trail) => trail.id === selectedTrailId) ?? activeTrails[0];
  const subskillCount = new Set(trails.map((trail) => trail.taskFamily)).size;
  const evidence = selectedTrail?.steps.flatMap((step) => step.evidence) ?? [];

  const chooseSkill = (skill: SkillDefinition) => {
    setSelectedSkillId(skill.id);
    const firstPopulated = skill.families.find((family) => trails.some((trail) => trail.taskFamily === family));
    setSelectedSubskill(firstPopulated ?? skill.families[0] ?? initialSubskill);
    setSelectedTrailId("");
  };

  const chooseSubskill = (skillId: string, family: string) => {
    setSelectedSkillId(skillId);
    setSelectedSubskill(family);
    setSelectedTrailId("");
  };

  const choosePlaceholder = (skillId: string, family: string, trailId: string) => {
    setSelectedSkillId(skillId);
    setSelectedSubskill(family);
    setSelectedTrailId(trailId);
  };

  return (
    <div className="view skill-library-view">
      <header className="skill-library-heading">
        <div><p className="eyebrow">ROUTER-READY OPERATIONAL KNOWLEDGE</p><h1>Operational skills and subskills.</h1><p>TRAIL organizes reviewed agent experience into a hierarchy the router can navigate: execution skills, focused subskills, and the evidence-backed layers beneath each one.</p></div>
        <dl><div><dt>{skills.length}</dt><dd>skill groups</dd></div><div><dt>{subskillCount}</dt><dd>subskills</dd></div><div><dt>{trails.length}</dt><dd>skill placeholders</dd></div><div><dt>318K</dt><dd>source target</dd></div></dl>
      </header>

      <label className="skill-search"><span aria-hidden="true">⌕</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills, subskills, intent, or evidence" /><kbd>/</kbd></label>

      <section className="taxonomy-board" aria-label="Skill hierarchy">
        <header className="taxonomy-heading"><div><span>SKILL TREE</span><strong>{trails.length} routed skill placeholders</strong></div><small>Group → subskill → SKILL.md leaf</small></header>
        <div className="root-node"><span>Knowledge domain</span><strong>Agent execution</strong><small>318K SKILL.md source target · {trails.length} routed placeholders</small></div>
        <div className="root-connector" aria-hidden="true" />
        <div className="skill-node-grid">
          {skills.map((skill) => {
            const count = visible.filter((trail) => skill.families.includes(trail.taskFamily)).length;
            return (
              <article className={`skill-node ${skill.id === selectedSkill.id ? "selected" : ""}`} key={skill.id}>
                <button className="skill-node-heading" onClick={() => chooseSkill(skill)}><span>{String(skills.indexOf(skill) + 1).padStart(2, "0")}</span><div><strong>{skill.name}</strong><small>{count} trails</small></div></button>
                <p>{skill.description}</p>
                <div className="subskill-node-list">
                  {skill.families.map((family) => {
                    const familyTrails = visible.filter((trail) => trail.taskFamily === family);
                    return <div className={`subskill-branch ${family === selectedSubskill ? "active" : ""}`} key={family}>
                      <button className="subskill-node" onClick={() => chooseSubskill(skill.id, family)}><span>{displayName(family)}</span><b>{familyTrails.length}</b></button>
                      <div className="placeholder-node-list">
                        {familyTrails.map((trail) => <button className={trail.id === selectedTrail?.id ? "active" : ""} key={trail.id} title={trail.title} onClick={() => choosePlaceholder(skill.id, family, trail.id)}><i /><span>{trail.title}</span></button>)}
                      </div>
                    </div>;
                  })}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <LiveIngestionPanel />

      <section className="library-workspace">
        <aside className="subskill-index">
          <div><span>Selected skill</span><h2>{selectedSkill.name}</h2><p>{selectedSkill.description}</p></div>
          <nav aria-label={`${selectedSkill.name} subskills`}>
            {selectedSkill.families.map((family) => {
              const familyTrails = visible.filter((trail) => trail.taskFamily === family);
              return <button className={family === selectedSubskill ? "active" : ""} key={family} onClick={() => chooseSubskill(selectedSkill.id, family)}><span>{displayName(family)}</span><b>{familyTrails.length}</b><small>{familyTrails[0]?.summary ?? "No matching trail"}</small></button>;
            })}
          </nav>
        </aside>

        <div className="skill-inspector">
          <header className="inspector-heading">
            <div><p><span>Agent execution</span><i>/</i><span>{selectedSkill.name}</span><i>/</i><strong>{displayName(selectedSubskill)}</strong></p><h2>{displayName(selectedSubskill)}</h2><small>{activeTrails.length} operational trail{activeTrails.length === 1 ? "" : "s"} available to the router</small></div>
            <span className="router-state"><i /> Router-ready</span>
          </header>

          {activeTrails.length ? <>
            <div className="trail-selector" role="tablist" aria-label="Trails in selected subskill">
              {activeTrails.map((trail) => <button role="tab" aria-selected={trail.id === selectedTrail?.id} className={trail.id === selectedTrail?.id ? "active" : ""} key={trail.id} onClick={() => setSelectedTrailId(trail.id)}><span>{trail.title}</span><small>{Math.round(trail.confidence * 100)}%</small></button>)}
            </div>

            {selectedTrail && <div className="layer-stack">
              <header><div><span>{selectedTrail.id}</span><h3>{selectedTrail.title}</h3><p>{selectedTrail.summary}</p></div><div><small>Reviewed trail</small><strong>{selectedTrail.reviewStatus}</strong></div></header>
              <div className="layer-grid">
                <article className="knowledge-layer intent-layer"><span>Layer 01</span><h4>Intent</h4><p>{selectedTrail.intent}</p><ul>{selectedTrail.preconditions.map((item) => <li key={item}>{item}</li>)}</ul></article>
                <article className="knowledge-layer constraint-layer"><span>Layer 02</span><h4>Boundaries</h4><ul>{selectedTrail.negativeConstraints.map((item) => <li key={item}>{item}</li>)}{selectedTrail.invalidators.map((item) => <li className="invalidator" key={item}>{item}</li>)}</ul></article>
                <article className="knowledge-layer route-layer"><span>Layer 03</span><h4>Route</h4><ol>{selectedTrail.steps.map((step, index) => <li key={step.id}><b>{String(index + 1).padStart(2, "0")}</b><div><strong>{step.action}</strong><small>{step.tool} · on failure: {step.onFailure}</small></div></li>)}</ol></article>
                <article className="knowledge-layer evidence-layer"><span>Layer 04</span><h4>Evidence</h4><ul>{evidence.map((item) => <li key={item.id}><strong>{item.description}</strong><code>{item.kind} = {item.expected}</code></li>)}</ul></article>
              </div>
              <footer className="provenance-bar"><div><span>Source</span><strong>{selectedTrail.provenance.provider}</strong></div><div><span>Range</span><strong>{selectedTrail.provenance.sourceRange}</strong></div><div><span>Triggers</span><strong>{selectedTrail.triggers.join(" · ")}</strong></div><div><span>Confidence</span><strong>{Math.round(selectedTrail.confidence * 100)}%</strong></div></footer>
            </div>}
          </> : <div className="skill-empty-state"><h3>No trails match this view</h3><p>Clear the search or choose another subskill.</p></div>}
        </div>
      </section>
    </div>
  );
}

function bytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function IngestView({ health, onApproved }: { health: Health | null; onApproved: (trail: Trail) => void }) {
  const [preview, setPreview] = useState<IngestionPreview | null>(null);
  const [draft, setDraft] = useState<Trail | null>(null);
  const [json, setJson] = useState("");
  const [records, setRecords] = useState<IngestionRecord[]>([]);
  const [sources, setSources] = useState<SourceInventory | null>(null);
  const [research, setResearch] = useState<ResearchCorpus | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);

  const reloadIntake = async () => {
    const [ingestionResult, sourceResult, researchResult] = await Promise.all([
      api<{ ingestions: IngestionRecord[] }>("/api/ingestions"),
      api<SourceInventory>("/api/sources"),
      api<ResearchCorpus>("/api/research-corpus"),
    ]);
    setRecords(ingestionResult.ingestions);
    setSources(sourceResult);
    setResearch(researchResult);
  };

  useEffect(() => { void reloadIntake().catch(() => undefined); }, []);

  const select = async (id: string) => {
    setBusy(true); setMessage(null); setDraft(null); setJson("");
    try { setPreview(await api<IngestionPreview>(`/api/ingestions/${id}`)); }
    catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not load that ingestion." }); }
    finally { setBusy(false); }
  };

  const ingestFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true); setMessage(null); setDraft(null); setJson("");
    try {
      const bounded = files.slice(0, 8);
      const tooLarge = bounded.find((file) => file.size > 12 * 1024 * 1024);
      if (tooLarge) throw new Error(`${tooLarge.name} is larger than the 12 MB intake limit.`);
      const previews: IngestionPreview[] = [];
      for (const file of bounded) {
        const text = await file.text();
        previews.push(await api<IngestionPreview>("/api/ingestions/preview", {
          method: "POST",
          body: JSON.stringify({ sourceName: file.name, text }),
        }));
      }
      setPreview(previews[0] ?? null);
      setMessage({ tone: "success", text: `${previews.length} transcript${previews.length === 1 ? "" : "s"} redacted and added to review.` });
      await reloadIntake();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Intake failed." });
    } finally { setBusy(false); }
  };

  const loadSample = async () => {
    setBusy(true); setMessage(null); setDraft(null); setJson("");
    try {
      const result = await api<IngestionPreview>("/api/ingestions/sample", { method: "POST", body: "{}" });
      setPreview(result);
      setMessage({ tone: "info", text: "Sample Codex run loaded. Review the exact redacted payload below." });
      await reloadIntake();
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Sample intake failed." }); }
    finally { setBusy(false); }
  };

  const scanSources = async () => {
    setScanning(true); setMessage(null);
    try {
      const result = await api<SourceInventory & { indexed: number }>("/api/sources/index", { method: "POST", body: "{}" });
      setSources(result);
      setMessage({ tone: "success", text: `Indexed metadata and route signals for ${result.indexed} local runs. Raw transcripts were not copied.` });
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Source scan failed." }); }
    finally { setScanning(false); }
  };

  const extract = async () => {
    if (!preview) return;
    setBusy(true); setMessage(null);
    try {
      const result = await api<{ trail: Trail }>(`/api/ingestions/${preview.id}/extract`, { method: "POST", body: "{}" });
      setDraft(result.trail); setJson(JSON.stringify(result.trail, null, 2));
      setMessage({ tone: "info", text: "Draft extracted. Nothing is trusted until you approve the contract." });
      await reloadIntake();
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Extraction failed." }); }
    finally { setBusy(false); }
  };

  const startManualDraft = async () => {
    if (!preview) return;
    setBusy(true); setMessage(null);
    try {
      const result = await api<{ trail: Trail }>(`/api/ingestions/${preview.id}/draft-template`, { method: "POST", body: "{}" });
      setDraft(result.trail); setJson(JSON.stringify(result.trail, null, 2));
      setMessage({ tone: "info", text: "Manual template created. Replace every placeholder with evidence from the redacted payload before approval." });
      await reloadIntake();
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not create a manual draft." }); }
    finally { setBusy(false); }
  };

  const approve = async () => {
    if (!draft) return;
    setBusy(true); setMessage(null);
    try {
      const parsed = JSON.parse(json) as Trail;
      const result = await api<{ trail: Trail; path: string }>(`/api/trails/${draft.id}/approve`, { method: "POST", body: JSON.stringify(parsed) });
      onApproved(result.trail);
      setMessage({ tone: "success", text: `Approved ${result.trail.id}. It is now eligible for retrieval.` });
      await reloadIntake();
    } catch (error) { setMessage({ tone: "error", text: error instanceof Error ? error.message : "Approval failed." }); }
    finally { setBusy(false); }
  };

  const providers = new Map((sources?.providers ?? health?.sourceIndex.providers ?? []).map((item) => [item.provider, item]));
  const sourceTotal = sources?.total ?? health?.sourceIndex.total ?? 0;

  return (
    <div className="view content-view ingest-view">
      <div className="page-heading intake-heading">
        <div><p className="eyebrow">INGESTION CONTROL PLANE</p><h1>Make experience retrievable.</h1><p>Bring in real Codex and Claude runs, remove sensitive data locally, extract a strict route contract, and promote it only after human review.</p></div>
        <div className="heading-stats"><strong>{sourceTotal}</strong><span>runs indexed</span><strong>{records.length}</strong><span>review items</span></div>
      </div>

      <section className="pipeline-ribbon" aria-label="Ingestion lifecycle">
        <div className="complete"><span>01</span><b>Discover</b><small>Metadata + signals</small></div>
        <div className={preview ? "complete" : "active"}><span>02</span><b>Redact</b><small>Local privacy pass</small></div>
        <div className={draft ? "complete" : preview ? "active" : ""}><span>03</span><b>Structure</b><small>Draft route contract</small></div>
        <div className={records.some((record) => record.status === "approved") ? "complete" : draft ? "active" : ""}><span>04</span><b>Approve</b><small>Retrieval eligible</small></div>
      </section>

      <div className="source-grid">
        {["codex", "claude"].map((provider) => {
          const inventory = providers.get(provider);
          const detected = sources?.roots[provider as keyof SourceInventory["roots"]] ?? health?.sourceRoots?.[provider as keyof Health["sourceRoots"]];
          return <article className="source-card panel" key={provider}>
            <div className="source-card-top"><span className={`source-icon ${provider}`}>{provider === "codex" ? "C" : "A"}</span><span className={`connector-state ${detected ? "ready" : "missing"}`}><i />{detected ? "Detected" : "Not found"}</span></div>
            <h2>{provider === "codex" ? "Codex sessions" : "Claude projects"}</h2>
            <p>Index hashes, timestamps, size, and recovery signals. Transcript bodies stay at their original path.</p>
            <footer><strong>{inventory?.count ?? 0}</strong><span>runs</span><strong>{bytes(inventory?.bytes ?? 0)}</strong><span>observed</span></footer>
          </article>;
        })}
        <article className="source-card source-control panel">
          <div><span className="step-number">SOURCE DISCOVERY</span><h2>Refresh the local index</h2><p>Use the shortlist to find runs with corrections, tool failures, environment changes, and release evidence.</p></div>
          <button className="secondary" disabled={scanning} onClick={() => void scanSources()}>{scanning ? "Scanning…" : "Scan this device"}<span>↻</span></button>
        </article>
      </div>

      {message && <div className={`intake-message ${message.tone}`} role="status"><i />{message.text}</div>}

      <div className="intake-workspace">
        <section className="panel intake-queue">
          <div className="section-heading"><div><span className="step-number">01 · INTAKE</span><h2>Add trajectory data</h2></div><button className="text-button" disabled={busy} onClick={() => void loadSample()}>Try sample</button></div>
          <label className={`file-picker ${busy ? "busy" : ""}`}>
            <input type="file" multiple accept=".jsonl,.json,application/json" onChange={(event) => { void ingestFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
            <span className="upload-glyph">＋</span><b>{busy ? "Processing locally…" : "Drop or choose transcript files"}</b><small>Codex or Claude JSONL · up to 8 files · 12 MB each</small>
          </label>
          <div className="queue-heading"><span>Review queue</span><b>{records.length}</b></div>
          <div className="queue-list">
            {records.length === 0 && <p className="empty-queue">No intake records yet. Load the sample to test redaction without exposing private data.</p>}
            {records.slice(0, 8).map((record) => <button key={record.id} className={`queue-row ${preview?.id === record.id ? "selected" : ""}`} onClick={() => void select(record.id)}>
              <span className={`format-badge ${record.format}`}>{record.format.slice(0, 1).toUpperCase()}</span>
              <span className="queue-copy"><b>{record.sourceName}</b><small>{record.candidateSignals.length ? record.candidateSignals.join(" · ") : "No strong route signal"}</small></span>
              <span className={`review-status ${record.status}`}>{record.status}</span>
            </button>)}
          </div>
        </section>

        <section className="panel redaction-panel">
          <div className="section-heading"><div><span className="step-number">02 · PRIVACY REVIEW</span><h2>{preview ? preview.sourceName : "Redacted payload"}</h2></div>{preview && <span className={`format-label ${preview.format}`}>{preview.format}</span>}</div>
          {preview ? <>
            <div className="preview-meta"><b>{preview.redactionCount} REDACTIONS</b><span>{preview.candidateSignals.length} route signals</span><span>{preview.requiresReview ? "review required" : "clean pass"}</span></div>
            <pre>{preview.redactedText.slice(0, 12_000)}</pre>
          </> : <div className="redaction-empty"><span>⌁</span><h3>Select an intake record</h3><p>The exact text eligible for extraction will appear here. Secrets, personal paths, contact details, and repository URLs are removed first.</p></div>}
        </section>
      </div>

      <section className="panel approval-panel">
        <div className="approval-intro"><span className="step-number">03–04 · STRUCTURE + APPROVE</span><h2>Promote a reviewed contract</h2><p>Extraction uses <code>{health?.extractorModel ?? "gpt-5.6-luna"}</code> with <code>store: false</code>. A draft cannot enter retrieval until you validate and approve its evidence contract.</p></div>
        <div className="approval-actions">
          <span className={`ai-state ${health?.liveAi ? "ready" : "missing"}`}><i />{health?.liveAi ? "Extractor connected" : "Extractor needs OPENAI_API_KEY"}</span>
          <button className="text-button manual-draft" disabled={!preview || busy} onClick={() => void startManualDraft()}>Start manual draft</button>
          <button className="secondary" disabled={!preview || !health?.liveAi || busy} onClick={() => void extract()}>{busy ? "Working…" : "Extract draft trail"}<span>→</span></button>
        </div>
        {draft && <div className="contract-editor"><div><span>DRAFT CONTRACT</span><b>{draft.id}</b></div><textarea aria-label="Trail JSON" value={json} onChange={(event) => setJson(event.target.value)} /></div>}
        {draft && <div className="approval-submit"><p>Approval makes this redacted contract available to the runtime retriever. It does not publish raw transcript content.</p><button className="primary compact" disabled={busy} onClick={() => void approve()}>Approve into corpus <span>✓</span></button></div>}
      </section>

      <section className="trust-boundary panel">
        <div><span>RESEARCH DATA · {research?.status === "ready" ? "INDEXED" : "PINNED"}</span><h2>{research?.status === "ready" ? `${(research.stats?.uniqueSkills ?? research.source.expectedRows).toLocaleString()} unique skills, quarantined.` : `${(research?.source.expectedRows ?? 138_133).toLocaleString()} records pinned for import.`}</h2></div>
        <p>{research?.source.dataset ?? "External skill metadata"} can improve discovery, but it is never executable, trusted, or automatically promoted. Every route that reaches the runtime corpus still crosses the same redaction and human-review boundary.</p>
        <div className="trust-tags"><span>metadata only</span><span>license unresolved</span><span>risk scanned</span><span>no auto-install</span></div>
      </section>
    </div>
  );
}

function PolicyView({ policies, reload }: { policies: RetrievalPolicy[]; reload: () => Promise<void> }) {
  const active = policies.find((policy) => policy.status === "active");
  const [candidate, setCandidate] = useState<RetrievalPolicy | null>(policies.find((policy) => policy.status === "candidate") ?? null);
  const [evaluation, setEvaluation] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const propose = async () => {
    setBusy(true);
    try { const result = await api<{ policy: RetrievalPolicy }>("/api/policies/propose", { method: "POST", body: JSON.stringify({ reason: "Raise environment fidelity after wrong-checkout failures" }) }); setCandidate(result.policy); await reload(); } finally { setBusy(false); }
  };
  const evaluate = async () => {
    if (!candidate) return;
    setBusy(true);
    try { const result = await api<Record<string, unknown>>(`/api/policies/${candidate.id}/evaluate`, { method: "POST", body: "{}" }); setEvaluation(result); await reload(); } finally { setBusy(false); }
  };
  return (
    <div className="view content-view policy-view">
      <div className="page-heading"><div><p className="eyebrow">BOUNDED RECURSIVE SELF-IMPROVEMENT</p><h1>Change the route, not the agent’s authority.</h1><p>TRAIL may propose retrieval weights or an approved trail. The harness, system prompt, merge boundary, and tool permissions stay fixed.</p></div></div>
      <div className="policy-flow">
        <section className="policy-card active-policy"><span>ACTIVE POLICY · V{active?.version ?? 1}</span><h2>Environment-first retrieval</h2><WeightBars weights={active?.weights} /><p>{active?.reason}</p></section>
        <div className="flow-arrow">→</div>
        <section className="policy-card candidate-policy"><span>CANDIDATE</span><h2>{candidate ? `Policy v${candidate.version}` : "No pending proposal"}</h2>{candidate ? <WeightBars weights={candidate.weights} /> : <p>A proposal creates a new immutable version. The active policy is never edited in place.</p>}<button className="secondary" disabled={busy || Boolean(candidate)} onClick={() => void propose()}>Propose safer weights</button></section>
        <div className="flow-arrow">→</div>
        <section className="policy-card evaluation-policy"><span>HELD-OUT GATE</span><h2>{evaluation ? ((evaluation.accepted as boolean) ? "Adopted" : "Rolled back") : "Awaiting evaluation"}</h2><p>{evaluation ? String((evaluation.reasons as string[])[0]) : "Accept only if verified success improves, unsafe approvals remain zero, and no task family regresses."}</p><button className="primary compact" disabled={busy || !candidate || Boolean(evaluation)} onClick={() => void evaluate()}>Run policy gate <span>→</span></button></section>
      </div>
      <section className="boundary panel"><h2>Authority boundary</h2><div><span>Allowed</span><strong>Retrieval weights</strong><strong>Approved trail set</strong></div><div><span>Locked</span><strong>Harness source</strong><strong>System prompt</strong><strong>Merge action</strong><strong>Tool permissions</strong></div></section>
    </div>
  );
}

function WeightBars({ weights }: { weights: RetrievalPolicy["weights"] | undefined }) {
  if (!weights) return null;
  return <div className="weight-bars">{Object.entries(weights).map(([name, value]) => <div key={name}><span>{name}</span><i><b style={{ width: `${value * 100}%` }} /></i><strong>{Math.round(value * 100)}</strong></div>)}</div>;
}

export function App() {
  const [tab, setTab] = useState<Tab>("corpus");
  const [health, setHealth] = useState<Health | null>(null);
  const [trails, setTrails] = useState<Trail[]>([]);
  const [policies, setPolicies] = useState<RetrievalPolicy[]>([]);

  const load = async () => {
    const [healthResult, trailResult, policyResult] = await Promise.all([
      api<Health>("/api/health"), api<{ trails: Trail[] }>("/api/trails"), api<{ policies: RetrievalPolicy[] }>("/api/policies"),
    ]);
    setHealth(healthResult); setTrails(trailResult.trails); setPolicies(policyResult.policies);
  };
  useEffect(() => { void load(); }, []);

  return (
    <AppShell tab={tab} setTab={setTab} health={health}>
      {tab === "context" && <ContextView health={health} />}
      {tab === "proof" && <ProofView health={health} />}
      {tab === "corpus" && <SkillLibraryView trails={trails} />}
      {tab === "ingest" && <IngestView health={health} onApproved={(trail) => setTrails((current) => [trail, ...current.filter((item) => item.id !== trail.id)])} />}
      {tab === "policy" && <PolicyView policies={policies} reload={load} />}
    </AppShell>
  );
}
