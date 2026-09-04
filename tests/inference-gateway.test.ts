import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { annotateStream, createInferenceGateway, hashKey, type InferenceKey } from '../src/inference-gateway.js';
import { startTestServer, json } from './test-http-server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function setup(handler: Parameters<typeof startTestServer>[0]) {
  const backend = await startTestServer(handler);
  cleanups.push(backend.close);
  const keys: InferenceKey[] = [{ user: 'alice', sha256: hashKey('test-key'), enabled: true }];
  const logs: Record<string, unknown>[] = [];
  const server = createInferenceGateway({ upstream: backend.baseUrl, model: 'test-model', keys: () => keys, log: e => logs.push(e) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  cleanups.push(async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); });
  const url = `http://127.0.0.1:${address.port}`;
  const send = (body: unknown, key = 'test-key') => fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { url, send, backend, keys, logs };
}
const body = { model: 'local-default', messages: [{ role: 'user', content: 'private prompt' }], max_tokens: 32 };

test('auth, immediate revocation, endpoint allowlist and input limits prevent access to private services', async () => {
  const app = await setup((_req, res) => json(res, 200, { choices: [] }));
  expect((await fetch(`${app.url}/v1/models`)).status).toBe(401);
  expect((await app.send(body, 'wrong-key')).status).toBe(401);
  for (const path of ['/api/pull', '/v1/memory/query', '/v1/bench/history', '/v1/chat/completions?target=private']) {
    expect((await fetch(`${app.url}${path}`, { headers: { Authorization: 'Bearer test-key' } })).status).toBe(404);
  }
  expect((await app.send({ ...body, model: 'other-model' })).status).toBe(404);
  for (const invalid of [null, { ...body, max_tokens: -1 }, { ...body, n: 5 }, { ...body, stream: 'true' },
    { ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1:8080' } }] }] }]) {
    expect((await app.send(invalid)).status).toBe(400);
  }
  expect((await app.send({ ...body, messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] })).status).toBe(413);
  app.keys[0]!.enabled = false;
  expect((await app.send(body)).status).toBe(401);
  expect(app.backend.requests).toHaveLength(0);
});

test('normal completion uses authenticated identity and bounded model parameters; logs omit secrets and messages', async () => {
  const app = await setup((_req, res) => json(res, 200, { choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 10 } }));
  const response = await app.send({ ...body, user: 'someone-else', options: { num_predict: -1 } });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.choices[0].message.content).toBe('OK');
  expect(result.inference).toMatchObject({ parameters: { max_tokens: 32, reasoning_effort: 'none' }, parameter_source: 'forwarded_request', usage_source: 'backend' });
  expect(result.inference.backend_default_parameters).toContain('temperature');
  expect(result.inference.timing_ms.total).toBeGreaterThanOrEqual(0);
  expect(result.inference).not.toHaveProperty('user');
  expect(app.backend.requests[0]!.body).toEqual({ ...body, model: 'test-model', user: 'alice', reasoning_effort: 'none' });
  expect(app.logs[0]).toMatchObject({ user: 'alice', status: 200, usage: { total_tokens: 10 } });
  expect(JSON.stringify(app.logs)).not.toMatch(/private prompt|test-key|someone-else/);
});

test('SSE parser preserves split UTF-8, usage and DONE without buffering the whole response', async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\r\n\r\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' + 'data: [DONE]\n\n');
  async function* split() { for (let i = 0; i < bytes.length; i++) yield bytes.slice(i, i + 1); }
  let usage: unknown;
  const frames: string[] = [];
  for await (const frame of annotateStream(split(), () => ({ request_id: 'request-test' }), value => { usage = value; })) frames.push(frame);
  expect(JSON.parse(frames[0]!.slice(6)).choices[0].delta.content).toBe('你好');
  expect(JSON.parse(frames[1]!.slice(6))).toMatchObject({ choices: [], inference: { request_id: 'request-test' }, usage: { total_tokens: 5 } });
  expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  expect(frames[2]).toBe('data: [DONE]\n\n');
  async function* truncated() { yield new TextEncoder().encode('data: {"choices":[]}\n\n'); }
  await expect(async () => { for await (const _frame of annotateStream(truncated(), () => ({}), () => {})) { /* consume */ } }).rejects.toThrow('before [DONE]');
});

test('streaming defaults to backend usage, and logs the actual final counts', async () => {
  const app = await setup((request, res) => {
    expect(request.body).toMatchObject({ temperature: 0.2, top_p: 0.8, stream_options: { include_usage: true } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":2,"total_tokens":19}}\n\n' + 'data: [DONE]\n\n');
  });
  const response = await app.send({ ...body, temperature: 0.2, top_p: 0.8, stream: true });
  const text = await response.text();
  const chunks = text.split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)));
  expect(chunks.at(-1)).toMatchObject({ usage: { total_tokens: 19 }, inference: { parameters: { temperature: 0.2, top_p: 0.8 }, usage_source: 'backend' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(app.logs.at(-1)).toMatchObject({ usage: { prompt_tokens: 17, completion_tokens: 2, total_tokens: 19 } });
});

test('SSE arrives before completion; a busy key gets 429; client cancellation releases admission', async () => {
  let closed!: () => void;
  const backendClosed = new Promise<void>(resolve => { closed = resolve; });
  const app = await setup((req, res) => {
    if ((req.body as { stream?: boolean }).stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
      res.once('close', closed);
    } else json(res, 200, { choices: [] });
  });
  const response = await app.send({ ...body, stream: true });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"content":"OK"');
  expect((await app.send(body)).status).toBe(429);
  await reader.cancel();
  await backendClosed;
  // Let the gateway's pipeline rejection and queue cleanup complete.
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await app.send(body)).status).toBe(200);
});

test('five distinct users are admitted FIFO, one backend request at a time, and a sixth is rejected', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let began!: () => void;
  const firstStarted = new Promise<void>(resolve => { began = resolve; });
  let active = 0;
  let peak = 0;
  const app = await setup(async (_req, res) => {
    peak = Math.max(peak, ++active);
    began();
    await gate;
    json(res, 200, { choices: [] });
    active--;
  });
  for (let i = 2; i <= 6; i++) app.keys.push({ user: `user-${i}`, sha256: hashKey(`key-${i}`), enabled: true });
  const pending = [app.send(body)];
  await firstStarted;
  for (let i = 2; i <= 5; i++) {
    pending.push(app.send(body, `key-${i}`));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  try {
    expect((await app.send(body, 'key-6')).status).toBe(429);
    expect(app.backend.requests).toHaveLength(1);
  } finally { release(); }
  expect((await Promise.all(pending)).map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
  expect(peak).toBe(1);
  expect(app.backend.requests.map(request => (request.body as { user: string }).user))
    .toEqual(['alice', 'user-2', 'user-3', 'user-4', 'user-5']);
});
