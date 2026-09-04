import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { AdmissionError, AdmissionQueue } from './admission-queue';
import type { AgentContract } from './agent-contract';
import type { RuntimeConfig } from './config';
import { assembleContext, type ChatMessage, type ChatRole } from './context';
import { DependencyError, isRecord } from './dependency-error';
import type { InferenceClient } from './ollama-client';
import type {
  BenchmarkArtifact,
  CanonicalMemory,
  MemoryScope,
  PlasmodClient,
  TurnBenchmark,
} from './plasmod-client';

export interface ServiceDependencies {
  config: RuntimeConfig;
  contract: AgentContract;
  ollama: InferenceClient;
  plasmod: PlasmodClient;
  queue?: AdmissionQueue;
  now?: () => Date;
  monotonicNow?: () => number;
  createId?: () => string;
  webRoot?: string;
}

export interface ModelHarborService {
  listen(port?: number): Promise<string>;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function createService(dependencies: ServiceDependencies): ModelHarborService {
  const { config, contract, ollama, plasmod } = dependencies;
  const queue =
    dependencies.queue ??
    new AdmissionQueue({
      concurrency: config.limits.concurrency,
      queueSize: config.limits.queueSize,
      maxUsers: config.limits.maxUsers,
    });
  const now = dependencies.now ?? (() => new Date());
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const createId = dependencies.createId ?? (() => `chatcmpl-${randomUUID()}`);
  const webRoot = path.resolve(dependencies.webRoot ?? 'dist/web');
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => sendError(response, error));
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (method === 'GET' && pathname === '/healthz') {
      return sendJson(response, 200, { status: 'ok' });
    }
    if (method === 'GET' && pathname === '/readyz') {
      return readiness(response);
    }
    if (method === 'GET' && pathname === '/v1/models') {
      return sendJson(response, 200, {
        object: 'list',
        data: [
          {
            id: config.ollama.model,
            object: 'model',
            owned_by: 'local',
            context_window: config.ollama.contextTokens,
            alias: contract.modelAlias,
          },
        ],
      });
    }
    if (method === 'GET' && pathname === '/v1/bench/sessions') {
      const scope = requestUserScope(request, config);
      const memories = await plasmod.listMemories(scope);
      return sendJson(response, 200, { sessions: summarizeSessions(memories) });
    }
    if (method === 'GET' && pathname === '/v1/bench/history') {
      const scope = requestScope(request, config);
      const [memories, artifacts] = await Promise.all([
        plasmod.listMemories(scope),
        plasmod.listBenchmarks(scope),
      ]);
      return sendJson(response, 200, historyResponse(scope.sessionId, memories, artifacts));
    }
    if (method === 'GET' && pathname === '/v1/bench/memory') {
      const scope = requestScope(request, config);
      const memories = await plasmod.listMemories(scope);
      return sendJson(response, 200, { memories });
    }
    if (method === 'GET' && pathname === '/v1/bench/runtime') {
      return runtimeSnapshot(response);
    }
    if (method === 'POST' && pathname === '/v1/chat/completions') {
      const scope = requestScope(request, config);
      const body = parseChatRequest(await readJson(request));
      const requestStarted = monotonicNow();
      const completion = await queue.run(scope.userId, async () => {
        const admittedAt = monotonicNow();
        const queryText = [...body.messages].reverse().find((message) => message.role === 'user')
          ?.content;
        if (!queryText) throw new HttpError(400, 'INVALID_REQUEST', 'A user message is required.');
        const memoryStarted = monotonicNow();
        const memory = await plasmod.query({ queryText, scope, topK: config.plasmod.topK });
        const memoryCompleted = monotonicNow();
        const context = assembleContext(
          body.messages,
          memory.memories,
          config.limits.contextCharacters
        );
        const inferenceStarted = monotonicNow();
        const inference = await ollama.chat(context.messages);
        const inferenceCompleted = monotonicNow();
        const occurredAt = now();
        const id = createId();
        const partialBenchmark = {
          queueWaitMs: elapsed(requestStarted, admittedAt),
          memoryQueryMs: elapsed(memoryStarted, memoryCompleted),
          inferenceMs: elapsed(inferenceStarted, inferenceCompleted),
          memoryHits: memory.memories.length,
          inputCharacters: context.inputCharacters,
          memoryCharacters: context.memoryCharacters,
          promptCharacters: context.promptCharacters,
          contextBudgetCharacters: config.limits.contextCharacters,
          contextTruncated: context.truncated,
          queue: queue.snapshot(),
        };
        const writeStarted = monotonicNow();
        await plasmod.ingestInteraction({
          eventId: id,
          scope,
          userText: queryText,
          assistantText: inference.content,
          occurredAt,
          logicalTimestamp: occurredAt.getTime(),
          benchmark: partialBenchmark,
        });
        const interactionPersisted = monotonicNow();
        const benchmark: TurnBenchmark = {
          ...partialBenchmark,
          memoryWriteMs: elapsed(writeStarted, interactionPersisted),
          totalMs: elapsed(requestStarted, interactionPersisted),
          persisted: true,
        };
        try {
          await plasmod.persistBenchmark({
            eventId: id,
            scope,
            occurredAt,
            logicalTimestamp: occurredAt.getTime(),
            benchmark,
          });
        } catch {
          benchmark.persisted = false;
        }
        return { id, occurredAt, inference, benchmark };
      });
      return sendJson(response, 200, {
        id: completion.id,
        object: 'chat.completion',
        created: Math.floor(completion.occurredAt.getTime() / 1000),
        model: completion.inference.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: completion.inference.content },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: completion.inference.promptTokens,
          completion_tokens: completion.inference.completionTokens,
          total_tokens:
            completion.inference.promptTokens + completion.inference.completionTokens,
        },
        benchmark: completion.benchmark,
      });
    }
    if (method === 'POST' && pathname === '/v1/memory/query') {
      const scope = requestScope(request, config);
      const body = await readJson(request);
      if (!isRecord(body) || typeof body.query !== 'string' || !body.query.trim()) {
        throw new HttpError(400, 'INVALID_REQUEST', 'query must be a non-empty string.');
      }
      const queryText = body.query.trim();
      const result = await queue.run(scope.userId, () =>
        plasmod.query({ queryText, scope, topK: config.plasmod.topK })
      );
      return sendJson(response, 200, { memories: result.memories, evidence: result.raw });
    }
    if (method === 'GET' && (pathname === '/' || pathname.startsWith('/assets/'))) {
      if (await sendWebAsset(response, webRoot, pathname)) return;
    }
    throw new HttpError(404, 'NOT_FOUND', 'Route not found.');
  }

  async function runtimeSnapshot(response: ServerResponse): Promise<void> {
    const [ollamaState, plasmodState, plasmodMetrics] = await Promise.allSettled([
      ollama.health(),
      plasmod.health(),
      plasmod.metrics(),
    ]);
    sendJson(response, 200, {
      service: 'ModelHarbor',
      provider: 'ollama',
      model: config.ollama.model,
      context: {
        tokens: config.ollama.contextTokens,
        character_budget: config.limits.contextCharacters,
        trimming: 'newest-first with recalled-memory truncation',
      },
      kv_cache: { manager: 'ollama', type: config.ollama.kvCacheType },
      admission: { limits: config.limits, current: queue.snapshot() },
      dependencies: {
        ollama: ollamaState.status === 'fulfilled' ? 'ready' : 'unavailable',
        plasmod: plasmodState.status === 'fulfilled' ? 'ready' : 'unavailable',
        hyphaContract: 'ready',
      },
      plasmod_metrics: plasmodMetrics.status === 'fulfilled' ? plasmodMetrics.value : null,
    });
  }

  async function readiness(response: ServerResponse): Promise<void> {
    const states = { ollama: 'ready', plasmod: 'ready', hyphaContract: 'ready' } as Record<
      string,
      'ready' | 'unavailable'
    >;
    try {
      const health = await ollama.health();
      if (!health.modelAvailable) states.ollama = 'unavailable';
    } catch {
      states.ollama = 'unavailable';
    }
    try {
      await plasmod.health();
    } catch {
      states.plasmod = 'unavailable';
    }
    const ready = Object.values(states).every((value) => value === 'ready');
    sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', dependencies: states });
  }

  return {
    async listen(port = config.server.port): Promise<string> {
      server.listen(port, config.server.host);
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      return `http://${config.server.host}:${address.port}`;
    },
    async close(): Promise<void> {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
    },
  };
}

function requestUserScope(
  request: IncomingMessage,
  config: RuntimeConfig
): Omit<MemoryScope, 'sessionId'> {
  const userId = header(request, 'x-user-id');
  if (!userId) throw new HttpError(400, 'INVALID_SCOPE', 'X-User-ID is required.');
  return { tenantId: config.agent.tenantId, userId, agentId: config.agent.id };
}

function requestScope(request: IncomingMessage, config: RuntimeConfig): MemoryScope {
  const userId = header(request, 'x-user-id');
  const sessionId = header(request, 'x-session-id');
  if (!userId || !sessionId) {
    throw new HttpError(400, 'INVALID_SCOPE', 'X-User-ID and X-Session-ID are required.');
  }
  return {
    tenantId: config.agent.tenantId,
    userId,
    agentId: config.agent.id,
    sessionId,
  };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const selected = Array.isArray(value) ? value[0] : value;
  const normalized = selected?.trim();
  return normalized ? normalized.slice(0, 128) : undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2 * 1024 * 1024) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds 2 MiB.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

function parseChatRequest(value: unknown): { messages: ChatMessage[] } {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'messages must be a non-empty array.');
  }
  if (value.stream === true) {
    throw new HttpError(400, 'STREAMING_UNSUPPORTED', 'Streaming is not supported in phase one.');
  }
  const messages = value.messages.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !isChatRole(candidate.role) ||
      typeof candidate.content !== 'string' ||
      !candidate.content.trim()
    ) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Each message needs a valid role and content.');
    }
    return { role: candidate.role, content: candidate.content };
  });
  if (messages.length === 0) {
    throw new HttpError(400, 'INVALID_REQUEST', 'messages must be a non-empty array.');
  }
  return { messages };
}

function isChatRole(value: unknown): value is ChatRole {
  return value === 'system' || value === 'user' || value === 'assistant';
}

function elapsed(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 100) / 100);
}

function summarizeSessions(memories: CanonicalMemory[]): Array<Record<string, unknown>> {
  const sessions = new Map<string, CanonicalMemory[]>();
  for (const memory of memories) {
    const entries = sessions.get(memory.session_id) ?? [];
    entries.push(memory);
    sessions.set(memory.session_id, entries);
  }
  return [...sessions.entries()]
    .map(([id, entries]) => {
      const ordered = [...entries].sort(compareMemories);
      const latest = ordered.at(-1);
      return {
        id,
        turns: entries.length,
        last_activity: memoryTime(latest),
        preview: interactionParts(latest?.content ?? '').user || latest?.summary || latest?.content || '',
      };
    })
    .sort((left, right) => String(right.last_activity).localeCompare(String(left.last_activity)));
}

function historyResponse(
  sessionId: string,
  memories: CanonicalMemory[],
  artifacts: BenchmarkArtifact[]
): Record<string, unknown> {
  const benchmarkByEvent = new Map(
    artifacts.map((artifact) => [artifact.produced_by_event_id, parseBenchmark(artifact.metadata?.body)])
  );
  const turns = [...memories].sort(compareMemories).map((memory) => {
    const parts = interactionParts(memory.content);
    const eventId = memory.source_event_ids?.[0];
    return {
      id: eventId ?? memory.memory_id,
      memory_id: memory.memory_id,
      created_at: memoryTime(memory),
      user: parts.user,
      assistant: parts.assistant,
      content: memory.content,
      benchmark: eventId ? benchmarkByEvent.get(eventId) ?? null : null,
    };
  });
  return { session_id: sessionId, turns };
}

function interactionParts(content: string): { user: string; assistant: string } {
  const prefix = 'User: ';
  const separator = '\nAssistant: ';
  if (!content.startsWith(prefix)) return { user: '', assistant: '' };
  const boundary = content.indexOf(separator);
  if (boundary < 0) return { user: content.slice(prefix.length), assistant: '' };
  return {
    user: content.slice(prefix.length, boundary),
    assistant: content.slice(boundary + separator.length),
  };
}

function parseBenchmark(value: string | undefined): unknown {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compareMemories(left: CanonicalMemory, right: CanonicalMemory): number {
  const byTime = memoryTime(left).localeCompare(memoryTime(right));
  return byTime || (left.mutation_lsn ?? 0) - (right.mutation_lsn ?? 0);
}

function memoryTime(memory: CanonicalMemory | undefined): string {
  return memory?.materialized_at || memory?.valid_from || '';
}

async function sendWebAsset(
  response: ServerResponse,
  webRoot: string,
  pathname: string
): Promise<boolean> {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(webRoot, relative);
  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) return false;
  try {
    const content = await readFile(filePath);
    const contentType = filePath.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : filePath.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : filePath.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    response.end(content);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof HttpError) {
    return sendJson(response, error.status, { error: { code: error.code, message: error.message } });
  }
  if (error instanceof AdmissionError) {
    return sendJson(response, 429, { error: { code: error.code, message: error.message } });
  }
  if (error instanceof DependencyError) {
    return sendJson(response, 503, {
      error: { code: 'DEPENDENCY_UNAVAILABLE', message: error.message },
    });
  }
  return sendJson(response, 500, {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
