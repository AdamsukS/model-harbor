import {
  DependencyError,
  isRecord,
  parseJsonResponse,
  requestSignal,
} from './dependency-error';

export interface MemoryScope {
  tenantId: string;
  userId: string;
  agentId: string;
  sessionId: string;
}

export interface PlasmodClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface MemoryQueryInput {
  queryText: string;
  scope: MemoryScope;
  topK: number;
  scopeMode?: 'session' | 'user';
}

export interface MemoryQueryResult {
  memories: string[];
  raw: unknown;
}

export interface InteractionInput {
  eventId: string;
  scope: MemoryScope;
  userText: string;
  assistantText: string;
  occurredAt: Date;
  logicalTimestamp: number;
  benchmark: Omit<TurnBenchmark, 'memoryWriteMs' | 'totalMs' | 'persisted'>;
}

export interface TurnBenchmark {
  memoryMode?: 'session' | 'user' | 'off';
  memoryEvidence?: unknown;
  toolTrace?: unknown[];
  queueWaitMs: number;
  memoryQueryMs: number;
  inferenceMs: number;
  memoryWriteMs: number;
  totalMs: number;
  memoryHits: number;
  inputCharacters: number;
  memoryCharacters: number;
  promptCharacters: number;
  contextBudgetCharacters: number;
  contextTruncated: boolean;
  queue: { active: number; queued: number; admittedUsers: number };
  persisted: boolean;
}

export interface CanonicalMemory {
  memory_id: string;
  agent_id: string;
  session_id: string;
  workspace_id?: string;
  scope?: string;
  content: string;
  summary?: string;
  source_event_ids?: string[];
  valid_from?: string;
  materialized_at?: string;
  mutation_lsn?: number;
  importance?: number;
  confidence?: number;
  lifecycle_state?: string;
  is_active?: boolean;
  access?: Record<string, unknown>;
}

export interface BenchmarkArtifact {
  artifact_id: string;
  session_id: string;
  workspace_id?: string;
  owner_agent_id: string;
  produced_by_event_id: string;
  materialized_at?: string;
  metadata?: { body?: string; name?: string };
}

export class PlasmodClient {
  constructor(private readonly options: PlasmodClientOptions) {}

  async health(signal?: AbortSignal): Promise<unknown> {
    return this.request('/healthz', { method: 'GET' }, signal);
  }

  async query(input: MemoryQueryInput, signal?: AbortSignal): Promise<MemoryQueryResult> {
    const raw = await this.request(
      '/v1/query',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query_text: input.queryText,
          tenant_id: input.scope.tenantId,
          workspace_id: input.scope.userId,
          ...(input.scopeMode === 'user' ? {} : { session_id: input.scope.sessionId }),
          agent_id: input.scope.agentId,
          requester_agent_id: input.scope.agentId,
          object_types: ['memory'],
          top_k: input.topK,
          response_mode: 'structured_evidence',
        }),
      },
      signal
    );
    const evidence = scopedEvidence(raw, input);
    return { memories: extractMemoryText(evidence), raw: evidence };
  }

  async ingestInteraction(input: InteractionInput, signal?: AbortSignal): Promise<unknown> {
    const interactionText = `User: ${input.userText}\nAssistant: ${input.assistantText}`;
    return this.request(
      '/v1/ingest/events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema_version: 'plasmod.dynamic_event.v0.4',
          identity: {
            event_id: input.eventId,
            tenant_id: input.scope.tenantId,
            workspace_id: input.scope.userId,
          },
          actor: {
            agent_id: input.scope.agentId,
            session_id: input.scope.sessionId,
          },
          time: {
            event_time: input.occurredAt.getTime(),
            logical_ts: input.logicalTimestamp,
          },
          event: { event_type: 'chat_interaction', importance: 0.8 },
          object: { object_type: 'memory' },
          access: { consistency: 'strict', visibility: 'workspace' },
          materialization: { enabled: true, targets: ['memory', 'object_version'] },
          retrieval: { index_text: interactionText, has_embedding: false },
          payload: {
            text: interactionText,
            user_text: input.userText,
            assistant_text: input.assistantText,
          },
          extensions: { custom: { model_harbor_bench: input.benchmark } },
        }),
      },
      signal
    );
  }

  async persistBenchmark(input: {
    eventId: string;
    scope: MemoryScope;
    occurredAt: Date;
    logicalTimestamp: number;
    benchmark: TurnBenchmark;
  }, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      '/v1/artifacts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_id: `art_${input.eventId}`,
          tenant_id: input.scope.tenantId,
          workspace_id: input.scope.userId,
          session_id: input.scope.sessionId,
          owner_agent_id: input.scope.agentId,
          artifact_type: 'model_harbor.benchmark.turn.v1',
          content_ref: 'inline',
          mime_type: 'application/json',
          metadata: {
            name: `turn:${input.eventId}`,
            body: JSON.stringify(input.benchmark),
          },
          produced_by_event_id: input.eventId,
          version: input.logicalTimestamp,
          materialized_at: input.occurredAt.toISOString(),
          access: {
            tenant_id: input.scope.tenantId,
            workspace_id: input.scope.userId,
            owner_agent_id: input.scope.agentId,
            session_id: input.scope.sessionId,
            visibility: 'workspace',
          },
        }),
      },
      signal
    );
  }

  async listMemories(
    scope: Omit<MemoryScope, 'sessionId'> & { sessionId?: string },
    signal?: AbortSignal
  ): Promise<CanonicalMemory[]> {
    const query = new URLSearchParams({
      agent_id: scope.agentId,
      workspace_id: scope.userId,
    });
    if (scope.sessionId) query.set('session_id', scope.sessionId);
    const raw = await this.request(`/v1/memory?${query.toString()}`, { method: 'GET' }, signal);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isCanonicalMemory);
  }

  async listBenchmarks(scope: MemoryScope, signal?: AbortSignal): Promise<BenchmarkArtifact[]> {
    const query = new URLSearchParams({ session_id: scope.sessionId });
    const raw = await this.request(`/v1/artifacts?${query.toString()}`, { method: 'GET' }, signal);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (value): value is BenchmarkArtifact =>
        isBenchmarkArtifact(value) &&
        value.workspace_id === scope.userId &&
        value.owner_agent_id === scope.agentId
    );
  }

  async metrics(signal?: AbortSignal): Promise<unknown> {
    return this.request('/v1/admin/metrics?storage=true', { method: 'GET' }, signal);
  }

  private async request(pathname: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${pathname}`, {
        ...init,
        signal: requestSignal(this.options.timeoutMs, signal),
      });
    } catch (error) {
      throw new DependencyError('plasmod', 'Unable to reach plasmod.', undefined, {
        cause: error,
      });
    }
    return parseJsonResponse('plasmod', response);
  }
}

function scopedEvidence(raw: unknown, input: MemoryQueryInput): Record<string, unknown> {
  if (!isRecord(raw)) return { objects: [], nodes: [], scope_filtered_count: 0 };
  const candidates: Array<Record<string, unknown>> = [];
  const snapshots = new Map<string, Record<string, unknown>>();
  for (const version of Array.isArray(raw.versions) ? raw.versions : []) {
    if (isRecord(version) && typeof version.object_id === 'string' && isRecord(version.snapshot)) {
      snapshots.set(version.object_id, version.snapshot);
    }
  }
  for (const object of Array.isArray(raw.objects) ? raw.objects : []) {
    if (isRecord(object)) candidates.push({ object_id: object.memory_id, object_type: 'memory', properties: object });
  }
  for (const node of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (isRecord(node) && node.object_type === 'memory' && isRecord(node.properties)) {
      const snapshot = typeof node.object_id === 'string' ? snapshots.get(node.object_id) : undefined;
      candidates.push({ ...node, properties: { tenant_id: snapshot?.tenant_id, ...node.properties } });
    }
  }
  // Enforce the product's scope even when upstream retrieval treats session_id as context only.
  // Do not return unfiltered graph/trace payloads through the memory API.
  const nodes = candidates.filter((node) => {
    const properties = node.properties;
    if (!isRecord(properties)) return false;
    return properties.agent_id === input.scope.agentId &&
      (properties.workspace_id ?? properties.scope) === input.scope.userId &&
      properties.tenant_id === input.scope.tenantId &&
      (input.scopeMode === 'user' || properties.session_id === input.scope.sessionId);
  });
  return {
    objects: nodes.map((node) => node.object_id), nodes,
    query_status: nodes.length ? 'ok' : 'no_scoped_memory_hits',
    upstream_query_status: raw.query_status,
    scope_filtered_count: candidates.length - nodes.length,
    diagnostics: raw.diagnostics,
  };
}

function isCanonicalMemory(value: unknown): value is CanonicalMemory {
  return (
    isRecord(value) &&
    typeof value.memory_id === 'string' &&
    typeof value.agent_id === 'string' &&
    typeof value.session_id === 'string' &&
    typeof value.content === 'string'
  );
}

function isBenchmarkArtifact(value: unknown): value is BenchmarkArtifact {
  return (
    isRecord(value) &&
    value.artifact_type === 'model_harbor.benchmark.turn.v1' &&
    typeof value.artifact_id === 'string' &&
    typeof value.session_id === 'string' &&
    typeof value.owner_agent_id === 'string' &&
    typeof value.produced_by_event_id === 'string'
  );
}

function extractMemoryText(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const texts: string[] = [];
  if (Array.isArray(value.objects)) {
    for (const candidate of value.objects) {
      if (!isRecord(candidate)) continue;
      const direct = firstText(candidate.content, candidate.summary);
      if (direct) texts.push(direct);
      const payload = candidate.payload;
      const payloadText = isRecord(payload) ? firstText(payload.text) : undefined;
      if (!direct && payloadText) texts.push(payloadText);
    }
  }
  if (Array.isArray(value.nodes)) {
    for (const candidate of value.nodes) {
      if (!isRecord(candidate) || candidate.object_type !== 'memory') continue;
      const properties = candidate.properties;
      const text = isRecord(properties)
        ? firstText(properties.content, properties.summary, candidate.label)
        : firstText(candidate.label);
      if (text) texts.push(text);
    }
  }
  return [...new Set(texts)];
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
