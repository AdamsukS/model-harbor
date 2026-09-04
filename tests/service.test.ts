import { afterEach, describe, expect, it } from 'vitest';
import { AdmissionQueue } from '../src/admission-queue';
import { loadConfig } from '../src/config';
import { OllamaClient } from '../src/ollama-client';
import { PlasmodClient } from '../src/plasmod-client';
import { createService, type ModelHarborService } from '../src/service';
import { json, startTestServer } from './test-http-server';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startDependencies(options: { ollamaStatus?: number; delayed?: boolean } = {}) {
  const order: string[] = [];
  let releaseOllama: (() => void) | undefined;
  const ollamaGate = new Promise<void>((resolve) => {
    releaseOllama = resolve;
  });
  const plasmod = await startTestServer((request, response) => {
    if (request.pathname === '/healthz') return json(response, 200, { status: 'ok' });
    if (request.pathname === '/v1/query') {
      order.push('plasmod:query');
      return json(response, 200, {
        objects: [{ memory_id: 'm1', content: 'The user prefers concise answers.' }],
      });
    }
    if (request.pathname === '/v1/ingest/events') {
      order.push('plasmod:ingest');
      return json(response, 200, { accepted: true });
    }
    if (request.pathname === '/v1/memory') {
      return json(response, 200, [
        {
          memory_id: 'mem-chatcmpl-test',
          agent_id: 'agent.model-harbor.local',
          session_id: 'session-1',
          workspace_id: 'user-alice',
          content: 'User: How should you answer?\nAssistant: A concise response.',
          source_event_ids: ['chatcmpl-test'],
          materialized_at: '2026-09-04T04:00:00.000Z',
        },
      ]);
    }
    if (request.pathname === '/v1/artifacts') {
      if (request.method === 'POST') return json(response, 200, { status: 'ok' });
      return json(response, 200, [
        {
          artifact_id: 'art_chatcmpl-test',
          artifact_type: 'model_harbor.benchmark.turn.v1',
          workspace_id: 'user-alice',
          session_id: 'session-1',
          owner_agent_id: 'agent.model-harbor.local',
          produced_by_event_id: 'chatcmpl-test',
          metadata: { body: JSON.stringify({ totalMs: 12, memoryHits: 1 }) },
        },
      ]);
    }
    if (request.pathname === '/v1/admin/metrics') {
      return json(response, 200, { storage_memory_count: 1, query_total: 1 });
    }
    return json(response, 404, {});
  });
  const ollama = await startTestServer(async (request, response) => {
    if (request.pathname === '/api/tags') {
      return json(response, 200, { models: [{ name: 'qwen3.5:9b-128k' }] });
    }
    if (request.pathname === '/api/chat') {
      order.push('ollama:chat');
      if (options.delayed) await ollamaGate;
      const body = request.body as { messages: Array<{ content: string }> };
      expect(body.messages[0]?.content).toContain('The user prefers concise answers.');
      return json(response, options.ollamaStatus ?? 200, {
        model: 'qwen3.5:9b-128k',
        message: { role: 'assistant', content: 'A concise response.' },
        prompt_eval_count: 12,
        eval_count: 4,
      });
    }
    return json(response, 404, {});
  });
  cleanups.push(plasmod.close, ollama.close);
  return { plasmod, ollama, order, releaseOllama: releaseOllama! };
}

async function startModelHarbor(
  dependency: Awaited<ReturnType<typeof startDependencies>>,
  overrides: NodeJS.ProcessEnv = {}
) {
  const config = loadConfig({
    OLLAMA_BASE_URL: dependency.ollama.baseUrl,
    PLASMOD_BASE_URL: dependency.plasmod.baseUrl,
    ...overrides,
  });
  const service = createService({
    config,
    contract: {
      agentId: 'agent.model-harbor.local',
      modelAlias: 'local-default',
      workflowId: 'workflow.local-chat',
      memoryProfileId: 'memory.plasmod',
      reasoningProfileId: 'reasoning.local-chat',
      dependencySnapshot: `sha256:${'a'.repeat(64)}`,
    },
    ollama: new OllamaClient(config.ollama),
    plasmod: new PlasmodClient(config.plasmod),
    queue: new AdmissionQueue(config.limits),
    now: () => new Date('2026-09-04T04:00:00.000Z'),
    createId: () => 'chatcmpl-test',
  });
  const baseUrl = await service.listen(0);
  cleanups.unshift(() => service.close());
  return { service, baseUrl };
}

async function postChat(baseUrl: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'local-default',
      stream: false,
      messages: [{ role: 'user', content: 'How should you answer?' }],
    }),
  });
}

describe('ModelHarbor service', () => {
  it('reports readiness only when Ollama and Plasmod are ready', async () => {
    const dependency = await startDependencies();
    const { baseUrl } = await startModelHarbor(dependency);

    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      dependencies: { ollama: 'ready', plasmod: 'ready', hyphaContract: 'ready' },
    });
  });

  it('requires explicit user and session scope', async () => {
    const dependency = await startDependencies();
    const { baseUrl } = await startModelHarbor(dependency);

    const response = await postChat(baseUrl);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'INVALID_SCOPE', message: 'X-User-ID and X-Session-ID are required.' },
    });
    expect(dependency.order).toEqual([]);
  });

  it('retrieves memory, generates, then persists the completed interaction', async () => {
    const dependency = await startDependencies();
    const { baseUrl } = await startModelHarbor(dependency);

    const response = await postChat(baseUrl, {
      'X-User-ID': 'user-alice',
      'X-Session-ID': 'session-1',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: 'qwen3.5:9b-128k',
      choices: [{ message: { role: 'assistant', content: 'A concise response.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      benchmark: {
        memoryHits: 1,
        contextBudgetCharacters: 360_000,
        contextTruncated: false,
        persisted: true,
      },
    });
    expect(dependency.order).toEqual(['plasmod:query', 'ollama:chat', 'plasmod:ingest']);
  });

  it('exposes scoped sessions, history, memory, and runtime data for the Bench', async () => {
    const dependency = await startDependencies();
    const { baseUrl } = await startModelHarbor(dependency);
    const scopedHeaders = { 'X-User-ID': 'user-alice', 'X-Session-ID': 'session-1' };

    const [sessions, history, memory, runtime] = await Promise.all([
      fetch(`${baseUrl}/v1/bench/sessions`, { headers: { 'X-User-ID': 'user-alice' } }),
      fetch(`${baseUrl}/v1/bench/history`, { headers: scopedHeaders }),
      fetch(`${baseUrl}/v1/bench/memory`, { headers: scopedHeaders }),
      fetch(`${baseUrl}/v1/bench/runtime`),
    ]);

    expect(await sessions.json()).toMatchObject({
      sessions: [{ id: 'session-1', turns: 1, preview: 'How should you answer?' }],
    });
    expect(await history.json()).toMatchObject({
      session_id: 'session-1',
      turns: [
        {
          user: 'How should you answer?',
          assistant: 'A concise response.',
          benchmark: { totalMs: 12, memoryHits: 1 },
        },
      ],
    });
    expect(await memory.json()).toMatchObject({ memories: [{ memory_id: 'mem-chatcmpl-test' }] });
    expect(await runtime.json()).toMatchObject({
      provider: 'ollama',
      context: { tokens: 131_072 },
      kv_cache: { manager: 'ollama', type: 'q4_0' },
      dependencies: { ollama: 'ready', plasmod: 'ready', hyphaContract: 'ready' },
      plasmod_metrics: { storage_memory_count: 1 },
    });
  });

  it('uses configured tenant and Agent identity for the memory scope', async () => {
    const dependency = await startDependencies();
    const { baseUrl } = await startModelHarbor(dependency, {
      MODEL_HARBOR_AGENT_ID: 'agent.custom',
      MODEL_HARBOR_TENANT_ID: 'tenant.custom',
    });

    const response = await postChat(baseUrl, {
      'X-User-ID': 'user-alice',
      'X-Session-ID': 'session-1',
    });

    expect(response.status).toBe(200);
    expect(dependency.plasmod.requests[0]?.body).toMatchObject({
      tenant_id: 'tenant.custom',
      agent_id: 'agent.custom',
      requester_agent_id: 'agent.custom',
    });
  });

  it('maps a full admission queue to HTTP 429', async () => {
    const dependency = await startDependencies({ delayed: true });
    const { baseUrl } = await startModelHarbor(dependency, { MODEL_HARBOR_QUEUE_SIZE: '1' });
    const first = postChat(baseUrl, {
      'X-User-ID': 'user-1',
      'X-Session-ID': 'session-1',
    });
    while (!dependency.order.includes('ollama:chat')) await new Promise((resolve) => setTimeout(resolve, 1));

    const rejected = await postChat(baseUrl, {
      'X-User-ID': 'user-2',
      'X-Session-ID': 'session-2',
    });

    expect(rejected.status).toBe(429);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'QUEUE_FULL' } });
    dependency.releaseOllama();
    expect((await first).status).toBe(200);
  });

  it('maps inference dependency failures to HTTP 503 without ingesting memory', async () => {
    const dependency = await startDependencies({ ollamaStatus: 500 });
    const { baseUrl } = await startModelHarbor(dependency);

    const response = await postChat(baseUrl, {
      'X-User-ID': 'user-alice',
      'X-Session-ID': 'session-1',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'DEPENDENCY_UNAVAILABLE' } });
    expect(dependency.order).toEqual(['plasmod:query', 'ollama:chat']);
  });
});
