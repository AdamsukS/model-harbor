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
          session_id: input.scope.sessionId,
          agent_id: input.scope.agentId,
          requester_agent_id: input.scope.agentId,
          object_types: ['memory'],
          top_k: input.topK,
          response_mode: 'structured_evidence',
        }),
      },
      signal
    );
    return { memories: extractMemoryText(raw), raw };
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
        }),
      },
      signal
    );
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
