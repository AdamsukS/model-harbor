import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Tab = 'chat' | 'history' | 'memory' | 'runtime';
type Role = 'user' | 'assistant';

interface Benchmark {
  memoryMode?: string;
  toolTrace?: Array<{ type?: string; payload?: unknown }>;
  queueWaitMs?: number;
  memoryQueryMs?: number;
  inferenceMs?: number;
  memoryWriteMs?: number;
  totalMs?: number;
  memoryHits?: number;
  promptCharacters?: number;
  contextBudgetCharacters?: number;
  contextTruncated?: boolean;
  persisted?: boolean;
}

interface Message {
  id: string;
  role: Role;
  content: string;
  benchmark?: Benchmark | null;
}

interface HistoryTurn {
  id: string;
  user: string;
  assistant: string;
  content: string;
  created_at: string;
  benchmark: Benchmark | null;
}

interface SessionSummary {
  id: string;
  turns: number;
  last_activity: string;
  preview: string;
}

interface MemoryRecord {
  memory_id: string;
  session_id: string;
  content: string;
  summary?: string;
  materialized_at?: string;
  valid_from?: string;
  importance?: number;
  confidence?: number;
  lifecycle_state?: string;
  is_active?: boolean;
}

interface RuntimeSnapshot {
  provider: string;
  model: string;
  context: { tokens: number; character_budget: number; trimming: string };
  kv_cache: { manager: string; type: string };
  admission: {
    limits: { concurrency: number; queueSize: number; maxUsers: number };
    current: { active: number; queued: number; admittedUsers: number };
  };
  dependencies: Record<string, string>;
  plasmod_metrics: Record<string, unknown> | null;
}

const navItems: Array<{ id: Tab; label: string; detail: string }> = [
  { id: 'chat', label: 'Chat', detail: 'Agent workspace' },
  { id: 'history', label: 'History', detail: 'Durable sessions' },
  { id: 'memory', label: 'Memory', detail: 'Plasmod records' },
  { id: 'runtime', label: 'Runtime', detail: 'Queue and KV' },
];

function App() {
  const [tab, setTab] = useState<Tab>('chat');
  const [userId, setUserId] = useState(() => localStorage.getItem('mh-user') || 'local-user-1');
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem('mh-session') || createSessionId()
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refreshVersion = useRef(0);
  const [memoryMode, setMemoryMode] = useState('session');
  const [toolMode, setToolMode] = useState('off');
  const [localToken, setLocalToken] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [toolCatalog, setToolCatalog] = useState<Array<{ name: string; status: string }>>([]);
  useEffect(() => { void api<{ tools: Array<{ name: string; status: string }> }>('/v1/tools')
    .then((data) => setToolCatalog(data.tools)).catch(() => {}); }, []);

  const scopedHeaders = useMemo(
    () => ({ 'X-User-ID': userId.trim(), 'X-Session-ID': sessionId.trim() }),
    [userId, sessionId]
  );

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    if (!userId.trim() || !sessionId.trim()) return;
    setLoading(true);
    try {
      const [sessionData, historyData, memoryData, runtimeData] = await Promise.all([
        api<{ sessions: SessionSummary[] }>('/v1/bench/sessions', {
          headers: { 'X-User-ID': userId.trim() },
        }),
        api<{ turns: HistoryTurn[] }>('/v1/bench/history', { headers: scopedHeaders }),
        api<{ memories: MemoryRecord[] }>('/v1/bench/memory', { headers: scopedHeaders }),
        api<RuntimeSnapshot>('/v1/bench/runtime'),
      ]);
      if (version !== refreshVersion.current) return;
      setSessions(sessionData.sessions);
      setMemories(memoryData.memories);
      setRuntime(runtimeData);
      setMessages(
        historyData.turns.flatMap((turn) => [
          { id: `${turn.id}-user`, role: 'user' as const, content: turn.user || turn.content },
          {
            id: `${turn.id}-assistant`,
            role: 'assistant' as const,
            content: turn.assistant || '(No assistant text was recovered.)',
            benchmark: turn.benchmark,
          },
        ])
      );
      setError('');
    } catch (caught) {
      if (version === refreshVersion.current) setError(messageOf(caught));
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, [scopedHeaders, sessionId, userId]);

  useEffect(() => {
    localStorage.setItem('mh-user', userId);
    localStorage.setItem('mh-session', sessionId);
    void refresh();
  }, [refresh, sessionId, userId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || pending || loading) return;
    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: text };
    const outgoing = [...messages, userMessage];
    setMessages(outgoing);
    setInput('');
    setPending(true);
    setError('');
    try {
      const response = await api<{
        id: string;
        choices: Array<{ message: { content: string } }>;
        benchmark: Benchmark;
      }>('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...scopedHeaders,
          ...(toolMode === 'local' ? { 'X-Local-Tool-Token': localToken.trim() } : {}) },
        body: JSON.stringify({
          model: 'local-default',
          stream: false,
          memory_mode: memoryMode,
          tool_mode: toolMode,
          search_query: toolMode === 'public' ? searchQuery : '',
          messages: outgoing.map(({ role, content }) => ({ role, content })),
        }),
      });
      setMessages((current) => [
        ...current,
        {
          id: response.id,
          role: 'assistant',
          content: response.choices[0]?.message.content || '',
          benchmark: response.benchmark,
        },
      ]);
      window.setTimeout(() => void refresh(), 250);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setPending(false);
    }
  }

  function startNewSession() {
    setSessionId(createSessionId());
    setMessages([]);
    setMemories([]);
    setTab('chat');
  }

  const latestBenchmark = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.benchmark)?.benchmark;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setTab('chat')} aria-label="Open Chat">
          <span className="brand-mark">MH</span>
          <span><strong>ModelHarbor</strong><small>Agent Bench</small></span>
        </button>
        <div className="live-indicator">
          <span className={runtime?.dependencies.ollama === 'ready' ? 'signal online' : 'signal'} />
          {runtime?.dependencies.ollama === 'ready' ? 'Local runtime ready' : 'Runtime checking'}
        </div>
      </header>

      <div className="workbench">
        <aside className="sidebar">
          <nav aria-label="Bench navigation">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={tab === item.id ? 'nav-item active' : 'nav-item'}
                onClick={() => setTab(item.id)}
              >
                <span>{item.label}</span><small>{item.detail}</small>
              </button>
            ))}
          </nav>
          <div className="scope-card">
            <span className="eyebrow">Active scope</span>
            <label>User<input disabled={pending} value={userId} onChange={(event) => { setMessages([]); setMemories([]); setUserId(event.target.value); }} /></label>
            <label>Session<input disabled={pending} value={sessionId} onChange={(event) => { setMessages([]); setMemories([]); setSessionId(event.target.value); }} /></label>
            <button className="secondary" disabled={pending} onClick={startNewSession}>New session</button>
          </div>
        </aside>

        <main className="main-stage">
          <details className="panel tool-settings">
            <summary>Tools & Memory controls</summary>
            <label>Memory <select value={memoryMode} onChange={(e) => setMemoryMode(e.target.value)}>
              <option value="session">Current session</option><option value="user">Across my sessions</option><option value="off">Recall off (writes remain on)</option>
            </select></label>
            <label>Tools <select value={toolMode} onChange={(e) => setToolMode(e.target.value)}>
              <option value="off">Off</option><option value="public">Public: time / web</option><option value="local">Private: Apple Calendar / Mail</option>
            </select></label>
            {toolMode === 'local' && <label>Local tools token (not saved in browser)
              <input type="password" autoComplete="off" value={localToken} onChange={(e) => setLocalToken(e.target.value)} />
              <small>Owner only · runtime/local-tools.token · macOS Automation permission required</small>
            </label>}
            {toolMode === 'public' && <label>Approved public search query
              <input value={searchQuery} maxLength={500} onChange={(e) => setSearchQuery(e.target.value)} />
              <small>Only this exact query may leave the device. Exa MCP is free without a key, subject to provider limits.</small>
            </label>}
            <p>{toolCatalog.map((tool) => `${tool.name}: ${tool.status}`).join(' · ')}</p>
          </details>
          {error && <div className="error-banner" role="alert">{error}</div>}
          {tab === 'chat' && (
            <ChatView
              messages={messages}
              benchmark={latestBenchmark}
              input={input}
              setInput={setInput}
              pending={pending}
              loading={loading}
              send={send}
              model={runtime?.model}
            />
          )}
          {tab === 'history' && (
            <HistoryView
              sessions={sessions}
              activeSession={sessionId}
              messages={messages}
              loading={loading}
              selectSession={(id) => { if (!pending) { setMessages([]); setSessionId(id); } }}
            />
          )}
          {tab === 'memory' && <MemoryView memories={memories} loading={loading} />}
          {tab === 'runtime' && <RuntimeView runtime={runtime} loading={loading} />}
        </main>
      </div>
    </div>
  );
}

function ChatView(props: {
  messages: Message[];
  benchmark?: Benchmark | null;
  input: string;
  setInput(value: string): void;
  pending: boolean;
  loading: boolean;
  send(event: FormEvent): void;
  model?: string;
}) {
  return (
    <section className="chat-page">
      <div className="page-heading compact">
        <div><span className="eyebrow">Agent workspace</span><h1>Chat with your local model</h1></div>
        <span className="model-chip">{props.model || 'local-default'}</span>
      </div>
      <div className="chat-stream" aria-live="polite">
        {!props.loading && props.messages.length === 0 && (
          <div className="empty-chat">
            <span className="empty-glyph">⌁</span>
            <h2>Start a durable conversation</h2>
            <p>Each completed turn is recalled and persisted through Plasmod. Runtime measurements stay attached to the turn.</p>
          </div>
        )}
        {props.messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <span className="message-role">{message.role === 'user' ? 'You' : 'Agent'}</span>
            <div className="message-body">{message.content}</div>
            {message.role === 'assistant' && message.benchmark && <TurnMetrics value={message.benchmark} />}
          </article>
        ))}
        {props.pending && <div className="thinking"><span /><span /><span /> Running local inference</div>}
      </div>
      <form className="composer" onSubmit={props.send}>
        <textarea
          aria-label="Message"
          value={props.input}
          onChange={(event) => props.setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Ask the Agent…"
          rows={3}
          disabled={props.pending}
        />
        <div className="composer-footer">
          <span>Enter to send · Shift + Enter for a new line</span>
          <button className="primary" disabled={props.pending || props.loading || !props.input.trim()}>
            {props.pending ? 'Queued…' : 'Send'}
          </button>
        </div>
      </form>
      {props.benchmark && <div className="sr-only">Latest turn took {props.benchmark.totalMs} milliseconds.</div>}
    </section>
  );
}

function TurnMetrics({ value }: { value: Benchmark }) {
  return (
    <div className="turn-metrics" aria-label="Turn benchmark">
      <Metric label="Total" value={milliseconds(value.totalMs)} />
      <Metric label="Inference" value={milliseconds(value.inferenceMs)} />
      <Metric label="Queue" value={milliseconds(value.queueWaitMs)} />
      <Metric label="Memory hits" value={String(value.memoryHits ?? 0)} />
      <Metric label="Context" value={value.contextTruncated ? 'Trimmed' : 'Full'} warning={value.contextTruncated} />
      {value.memoryMode && <Metric label="Recall scope" value={value.memoryMode} />}
      {!!value.toolTrace?.length && <details><summary>Tool trace ({value.toolTrace.length} events)</summary>
        <pre>{JSON.stringify(value.toolTrace, null, 2)}</pre></details>}
    </div>
  );
}

function HistoryView(props: {
  sessions: SessionSummary[];
  activeSession: string;
  messages: Message[];
  loading: boolean;
  selectSession(id: string): void;
}) {
  return (
    <section>
      <div className="page-heading"><span className="eyebrow">Plasmod-backed</span><h1>Conversation history</h1><p>Sessions are derived from canonical memories in the selected user workspace.</p></div>
      <div className="history-grid">
        <div className="session-list">
          {props.sessions.length === 0 && <Empty title="No durable sessions yet" detail="Send a message to create the first memory." />}
          {props.sessions.map((session) => (
            <button key={session.id} className={session.id === props.activeSession ? 'session-row selected' : 'session-row'} onClick={() => props.selectSession(session.id)}>
              <span><strong>{session.preview || 'Untitled session'}</strong><small>{session.id}</small></span>
              <span><b>{session.turns}</b><small>{formatDate(session.last_activity)}</small></span>
            </button>
          ))}
        </div>
        <div className="timeline">
          <span className="eyebrow">{props.activeSession}</span>
          {!props.loading && props.messages.length === 0 && <Empty title="No turns in this session" detail="Choose another session or start chatting." />}
          {props.messages.filter((message) => message.role === 'assistant').map((message, index) => (
            <div className="timeline-row" key={message.id}>
              <span className="turn-index">{String(index + 1).padStart(2, '0')}</span>
              <div><p>{message.content}</p>{message.benchmark && <TurnMetrics value={message.benchmark} />}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MemoryView({ memories, loading }: { memories: MemoryRecord[]; loading: boolean }) {
  return (
    <section>
      <div className="page-heading"><span className="eyebrow">Canonical objects</span><h1>Plasmod memory</h1><p>Inspectable records for the current user and session. The browser does not maintain a second history store.</p></div>
      <div className="memory-summary"><Metric label="Records" value={String(memories.length)} /><Metric label="Active" value={String(memories.filter((memory) => memory.is_active !== false).length)} /></div>
      {!loading && memories.length === 0 && <Empty title="No memory records" detail="Completed Agent turns will materialize here." />}
      <div className="memory-list">
        {memories.map((memory) => (
          <article className="memory-card" key={memory.memory_id}>
            <div className="memory-meta"><span>{memory.lifecycle_state || (memory.is_active === false ? 'inactive' : 'active')}</span><time>{formatDate(memory.materialized_at || memory.valid_from)}</time></div>
            <p>{memory.summary || memory.content}</p>
            <code>{memory.memory_id}</code>
            <div className="memory-scores"><span>importance {number(memory.importance)}</span><span>confidence {number(memory.confidence)}</span></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function RuntimeView({ runtime, loading }: { runtime: RuntimeSnapshot | null; loading: boolean }) {
  if (!runtime) return <section><div className="page-heading"><h1>Runtime</h1></div><Empty title={loading ? 'Inspecting runtime…' : 'Runtime unavailable'} detail="Start ModelHarbor and its dependencies, then refresh." /></section>;
  const metrics = runtime.plasmod_metrics || {};
  return (
    <section>
      <div className="page-heading"><span className="eyebrow">Live local service</span><h1>Runtime and benchmark</h1><p>Current inference, admission, context, KV-cache, and Plasmod signals.</p></div>
      <div className="status-grid">
        {Object.entries(runtime.dependencies).map(([name, state]) => <div className="status-card" key={name}><span className={state === 'ready' ? 'signal online' : 'signal'} /><span><small>{name}</small><strong>{state}</strong></span></div>)}
      </div>
      <div className="runtime-grid">
        <article className="panel"><span className="eyebrow">Inference</span><h2>{runtime.model}</h2><dl><Row label="Provider" value={runtime.provider} /><Row label="Context window" value={`${runtime.context.tokens.toLocaleString()} tokens`} /><Row label="Character guard" value={runtime.context.character_budget.toLocaleString()} /><Row label="Trimming" value={runtime.context.trimming} /></dl></article>
        <article className="panel"><span className="eyebrow">KV cache</span><h2>{runtime.kv_cache.type}</h2><dl><Row label="Manager" value={runtime.kv_cache.manager} /><Row label="Mode" value="quantized" /><Row label="Experiment surface" value="backend boundary" /></dl></article>
        <article className="panel"><span className="eyebrow">Admission</span><h2>{runtime.admission.current.active} active · {runtime.admission.current.queued} queued</h2><dl><Row label="Concurrency" value={runtime.admission.limits.concurrency} /><Row label="Queue capacity" value={runtime.admission.limits.queueSize} /><Row label="Maximum users" value={runtime.admission.limits.maxUsers} /><Row label="Admitted now" value={runtime.admission.current.admittedUsers} /></dl></article>
        <article className="panel"><span className="eyebrow">Plasmod</span><h2>{String(metrics.storage_memory_count ?? '—')} memories</h2><dl><Row label="Events" value={primitive(metrics.storage_event_count)} /><Row label="Queries" value={primitive(metrics.query_total)} /><Row label="Writes" value={primitive(metrics.write_total)} /></dl></article>
      </div>
    </section>
  );
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <span className={warning ? 'metric warning' : 'metric'}><small>{label}</small><strong>{value}</strong></span>;
}

function Row({ label, value }: { label: string; value: string | number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><strong>{title}</strong><p>{detail}</p></div>;
}

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, init);
  const body = await response.json() as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(body.error?.message || `Request failed with HTTP ${response.status}.`);
  return body;
}

function createSessionId(): string {
  return `session-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`;
}

function milliseconds(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value).toLocaleString()} ms`;
}

function number(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(2);
}

function primitive(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '—';
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById('root')!).render(<App />);
