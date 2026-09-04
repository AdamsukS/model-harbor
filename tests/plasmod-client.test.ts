import { afterEach, describe, expect, it } from 'vitest';
import { PlasmodClient } from '../src/plasmod-client';
import { json, startTestServer } from './test-http-server';

const scope = {
  tenantId: 'tenant-local',
  userId: 'user-alice',
  agentId: 'agent-local',
  sessionId: 'session-1',
};

const cleanups: Array<() => Promise<void>> = [];
const benchmark = {
  queueWaitMs: 1,
  memoryQueryMs: 2,
  inferenceMs: 3,
  memoryHits: 1,
  inputCharacters: 20,
  memoryCharacters: 30,
  promptCharacters: 50,
  contextBudgetCharacters: 360_000,
  contextTruncated: false,
  queue: { active: 1, queued: 0, admittedUsers: 1 },
};
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('PlasmodClient', () => {
  it('queries scoped memory and extracts readable content', async () => {
    const server = await startTestServer((request, response) => {
      expect(request.pathname).toBe('/v1/query');
      json(response, 200, {
        objects: [
          { memory_id: 'memory-1', content: 'The user prefers concise answers.' },
          { memory_id: 'memory-2', summary: 'The user works in Chinese and English.' },
          { memory_id: 'memory-3', payload: { text: 'The user uses a Mac.' } },
        ],
        query_status: 'completed',
      });
    });
    cleanups.push(server.close);
    const client = new PlasmodClient({ baseUrl: server.baseUrl, timeoutMs: 1_000 });

    const result = await client.query({ queryText: 'answer preference', scope, topK: 5 });

    expect(server.requests[0]?.body).toEqual({
      query_text: 'answer preference',
      tenant_id: 'tenant-local',
      workspace_id: 'user-alice',
      session_id: 'session-1',
      agent_id: 'agent-local',
      requester_agent_id: 'agent-local',
      object_types: ['memory'],
      top_k: 5,
      response_mode: 'structured_evidence',
    });
    expect(result.memories).toEqual([
      'The user prefers concise answers.',
      'The user works in Chinese and English.',
      'The user uses a Mac.',
    ]);
  });

  it('extracts memory text from Plasmod structured-evidence nodes', async () => {
    const server = await startTestServer((_request, response) => {
      json(response, 200, {
        objects: ['mem-chat-1'],
        nodes: [
          {
            object_id: 'mem-chat-1',
            object_type: 'memory',
            label: 'User: Hello\nAssistant: Hi.',
            properties: {
              content: 'User: Hello\nAssistant: Hi.',
              summary: 'A short greeting.',
            },
          },
          {
            object_id: 'event-1',
            object_type: 'event',
            label: 'Must not be returned as memory.',
          },
        ],
        query_status: 'ok',
      });
    });
    cleanups.push(server.close);
    const client = new PlasmodClient({ baseUrl: server.baseUrl, timeoutMs: 1_000 });

    const result = await client.query({ queryText: 'greeting', scope, topK: 5 });

    expect(result.memories).toEqual(['User: Hello\nAssistant: Hi.']);
  });

  it('ingests a strict Dynamic Event v0.4 interaction', async () => {
    const server = await startTestServer((_request, response) => {
      json(response, 200, { accepted: true, lsn: 4 });
    });
    cleanups.push(server.close);
    const client = new PlasmodClient({ baseUrl: server.baseUrl, timeoutMs: 1_000 });

    await client.ingestInteraction({
      eventId: 'evt-chat-1',
      scope,
      userText: 'What style do I prefer?',
      assistantText: 'You prefer concise answers.',
      occurredAt: new Date('2026-09-04T03:00:00.000Z'),
      logicalTimestamp: 7,
      benchmark,
    });

    expect(server.requests[0]).toMatchObject({ method: 'POST', pathname: '/v1/ingest/events' });
    expect(server.requests[0]?.body).toEqual({
      schema_version: 'plasmod.dynamic_event.v0.4',
      identity: {
        event_id: 'evt-chat-1',
        tenant_id: 'tenant-local',
        workspace_id: 'user-alice',
      },
      actor: { agent_id: 'agent-local', session_id: 'session-1' },
      time: { event_time: 1_788_490_800_000, logical_ts: 7 },
      event: { event_type: 'chat_interaction', importance: 0.8 },
      object: { object_type: 'memory' },
      access: { consistency: 'strict', visibility: 'workspace' },
      materialization: { enabled: true, targets: ['memory', 'object_version'] },
      retrieval: {
        index_text: 'User: What style do I prefer?\nAssistant: You prefer concise answers.',
        has_embedding: false,
      },
      payload: {
        text: 'User: What style do I prefer?\nAssistant: You prefer concise answers.',
        user_text: 'What style do I prefer?',
        assistant_text: 'You prefer concise answers.',
      },
      extensions: { custom: { model_harbor_bench: benchmark } },
    });
  });

  it('reads canonical memories using agent, workspace, and optional session scope', async () => {
    const server = await startTestServer((request, response) => {
      expect(request.pathname).toBe('/v1/memory');
      expect(request.query).toMatchObject({
        agent_id: 'agent-local',
        workspace_id: 'user-alice',
        session_id: 'session-1',
      });
      json(response, 200, [
        {
          memory_id: 'mem-1',
          agent_id: 'agent-local',
          session_id: 'session-1',
          workspace_id: 'user-alice',
          content: 'User: Hello\nAssistant: Hi',
        },
      ]);
    });
    cleanups.push(server.close);
    const client = new PlasmodClient({ baseUrl: server.baseUrl, timeoutMs: 1_000 });

    await expect(client.listMemories(scope)).resolves.toHaveLength(1);
  });

  it('persists and reads a scoped benchmark artifact', async () => {
    const requests: unknown[] = [];
    const server = await startTestServer((request, response) => {
      requests.push(request);
      if (request.method === 'POST') return json(response, 200, { status: 'ok' });
      return json(response, 200, [
        {
          artifact_id: 'art_evt-chat-1',
          artifact_type: 'model_harbor.benchmark.turn.v1',
          workspace_id: 'user-alice',
          session_id: 'session-1',
          owner_agent_id: 'agent-local',
          produced_by_event_id: 'evt-chat-1',
          metadata: { body: '{}' },
        },
        {
          artifact_id: 'art-other',
          artifact_type: 'model_harbor.benchmark.turn.v1',
          workspace_id: 'other-user',
          session_id: 'session-1',
          owner_agent_id: 'agent-local',
          produced_by_event_id: 'evt-other',
        },
      ]);
    });
    cleanups.push(server.close);
    const client = new PlasmodClient({ baseUrl: server.baseUrl, timeoutMs: 1_000 });
    const completeBenchmark = { ...benchmark, memoryWriteMs: 4, totalMs: 10, persisted: true };

    await client.persistBenchmark({
      eventId: 'evt-chat-1',
      scope,
      occurredAt: new Date('2026-09-04T03:00:00.000Z'),
      logicalTimestamp: 7,
      benchmark: completeBenchmark,
    });
    const artifacts = await client.listBenchmarks(scope);

    expect(artifacts.map((artifact) => artifact.artifact_id)).toEqual(['art_evt-chat-1']);
    expect((requests[0] as { body: Record<string, unknown> }).body).toMatchObject({
      artifact_id: 'art_evt-chat-1',
      workspace_id: 'user-alice',
      artifact_type: 'model_harbor.benchmark.turn.v1',
      produced_by_event_id: 'evt-chat-1',
    });
  });

  it('surfaces non-success responses with dependency status', async () => {
    const server = await startTestServer((_request, response) => {
      json(response, 503, { error: 'backpressure' });
    });
    cleanups.push(server.close);
    const client = new PlasmodClient({ baseUrl: server.baseUrl, timeoutMs: 1_000 });

    await expect(client.query({ queryText: 'test', scope, topK: 5 })).rejects.toMatchObject({
      dependency: 'plasmod',
      status: 503,
    });
  });

  it('checks the documented health endpoint', async () => {
    const server = await startTestServer((request, response) => {
      expect(request.pathname).toBe('/healthz');
      json(response, 200, { status: 'ok' });
    });
    cleanups.push(server.close);

    await expect(
      new PlasmodClient({ baseUrl: server.baseUrl, timeoutMs: 1_000 }).health()
    ).resolves.toEqual({ status: 'ok' });
  });
});
