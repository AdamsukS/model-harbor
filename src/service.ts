import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { AdmissionError, AdmissionQueue } from './admission-queue';
import type { AgentContract } from './agent-contract';
import type { RuntimeConfig } from './config';
import { assembleMessages, type ChatMessage, type ChatRole } from './context';
import { DependencyError, isRecord } from './dependency-error';
import type { InferenceClient } from './ollama-client';
import type { MemoryScope, PlasmodClient } from './plasmod-client';

export interface ServiceDependencies {
  config: RuntimeConfig;
  contract: AgentContract;
  ollama: InferenceClient;
  plasmod: PlasmodClient;
  queue?: AdmissionQueue;
  now?: () => Date;
  createId?: () => string;
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
  const createId = dependencies.createId ?? (() => `chatcmpl-${randomUUID()}`);
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
    if (method === 'POST' && pathname === '/v1/chat/completions') {
      const scope = requestScope(request, config);
      const body = parseChatRequest(await readJson(request));
      const completion = await queue.run(scope.userId, async () => {
        const queryText = [...body.messages].reverse().find((message) => message.role === 'user')
          ?.content;
        if (!queryText) throw new HttpError(400, 'INVALID_REQUEST', 'A user message is required.');
        const memory = await plasmod.query({ queryText, scope, topK: config.plasmod.topK });
        const prompt = assembleMessages(
          body.messages,
          memory.memories,
          config.limits.contextCharacters
        );
        const inference = await ollama.chat(prompt);
        const occurredAt = now();
        const id = createId();
        await plasmod.ingestInteraction({
          eventId: id,
          scope,
          userText: queryText,
          assistantText: inference.content,
          occurredAt,
          logicalTimestamp: occurredAt.getTime(),
        });
        return { id, occurredAt, inference };
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
    throw new HttpError(404, 'NOT_FOUND', 'Route not found.');
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
