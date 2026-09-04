import { afterEach, describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/ollama-client';
import { json, startTestServer } from './test-http-server';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('OllamaClient', () => {
  it('sends a non-streaming chat request with the configured context', async () => {
    const server = await startTestServer((_request, response) => {
      json(response, 200, {
        model: 'qwen3.5:9b-128k',
        created_at: '2026-09-04T03:00:00Z',
        message: { role: 'assistant', content: 'Hello from Ollama.' },
        prompt_eval_count: 11,
        eval_count: 5,
      });
    });
    cleanups.push(server.close);
    const client = new OllamaClient({
      baseUrl: server.baseUrl,
      model: 'qwen3.5:9b-128k',
      contextTokens: 131_072,
      timeoutMs: 1_000,
    });

    const result = await client.chat([{ role: 'user', content: 'Hello' }]);

    expect(server.requests[0]).toEqual({
      method: 'POST',
      pathname: '/api/chat',
      body: {
        model: 'qwen3.5:9b-128k',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
        options: { num_ctx: 131_072 },
      },
    });
    expect(result).toEqual({
      content: 'Hello from Ollama.',
      model: 'qwen3.5:9b-128k',
      promptTokens: 11,
      completionTokens: 5,
    });
  });

  it('rejects an empty assistant response', async () => {
    const server = await startTestServer((_request, response) => {
      json(response, 200, { model: 'qwen3.5:9b-128k', message: { role: 'assistant', content: '' } });
    });
    cleanups.push(server.close);

    await expect(
      new OllamaClient({
        baseUrl: server.baseUrl,
        model: 'qwen3.5:9b-128k',
        contextTokens: 131_072,
        timeoutMs: 1_000,
      }).chat([{ role: 'user', content: 'Hello' }])
    ).rejects.toThrow('empty assistant content');
  });

  it('checks Ollama readiness through the tags endpoint', async () => {
    const server = await startTestServer((request, response) => {
      expect(request.pathname).toBe('/api/tags');
      json(response, 200, { models: [{ name: 'qwen3.5:9b-128k' }] });
    });
    cleanups.push(server.close);

    await expect(
      new OllamaClient({
        baseUrl: server.baseUrl,
        model: 'qwen3.5:9b-128k',
        contextTokens: 131_072,
        timeoutMs: 1_000,
      }).health()
    ).resolves.toEqual({ modelAvailable: true });
  });

  it('surfaces non-success responses with dependency status', async () => {
    const server = await startTestServer((_request, response) => {
      json(response, 500, { error: 'model crashed' });
    });
    cleanups.push(server.close);

    await expect(
      new OllamaClient({
        baseUrl: server.baseUrl,
        model: 'qwen3.5:9b-128k',
        contextTokens: 131_072,
        timeoutMs: 1_000,
      }).chat([{ role: 'user', content: 'Hello' }])
    ).rejects.toMatchObject({ dependency: 'ollama', status: 500 });
  });
});
