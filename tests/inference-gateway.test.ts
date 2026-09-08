import { once } from 'node:events';
import { Agent, get } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { annotateStream, createInferenceGateway, hashKey, type InferenceKey, type Options } from '../src/inference-gateway.js';
import { startTestServer, json } from './test-http-server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function setup(handler: Parameters<typeof startTestServer>[0], options: Partial<Options> = {}) {
  const backend = await startTestServer(handler);
  cleanups.push(backend.close);
  const keys: InferenceKey[] = [{ user: 'alice', sha256: hashKey('test-key'), enabled: true }];
  const logs: Record<string, unknown>[] = [];
  const server = createInferenceGateway({ upstream: backend.baseUrl, model: 'test-model', keys: () => keys, log: e => logs.push(e), ...options });
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

test.each(['system', 'developer'])('llama.cpp accepts a %s-only task without changing instruction roles', async role => {
  const app = await setup((_req, res) => json(res, 200, { choices: [] }), { backend: 'llama.cpp' });
  const messages = [{ role, content: 'private instruction' }];
  expect((await app.send({ ...body, messages })).status).toBe(200);
  expect(app.backend.requests[0]!.body).toMatchObject({ messages: [...messages, { role: 'user', content: '' }] });
  expect(app.logs[0]).toMatchObject({ message_roles: { [role]: 1 } });
  expect(JSON.stringify(app.logs)).not.toContain('private instruction');
  expect((await app.send(body)).status).toBe(200);
  expect(app.backend.requests[1]!.body).toMatchObject({ messages: body.messages });
});

test('known Jinja message errors are actionable 400s while unrelated backend errors remain 503', async () => {
  let detail = 'Jinja Exception: No user query found in messages. private backend details';
  const app = await setup((_req, res) => json(res, 500, { error: { message: detail } }), { backend: 'llama.cpp' });
  for (const message of ['No user query found in messages.', 'No messages provided.', 'System message must be at the beginning.']) {
    detail = `Jinja Exception: ${message} private backend details`;
    const r = await app.send(body);
    expect(r.status).toBe(400);
    expect(r.headers.get('retry-after')).toBeNull();
    expect(await r.text()).not.toContain('private backend details');
    expect(app.logs.at(-1)).toMatchObject({ error_code: 'CHAT_TEMPLATE_INVALID_MESSAGES', upstream_status: 500 });
  }
  detail = 'Out of memory: private backend details';
  const r = await app.send(body);
  expect(r.status).toBe(503);
  expect(r.headers.get('retry-after')).toBe('10');
});

test('proxy connections remain reusable beyond Node’s default five-second idle timeout', async () => {
  const app = await setup((_req, res) => json(res, 200, {}));
  const agent = new Agent({ keepAlive: true });
  const request = () => new Promise<number | undefined>((resolve, reject) => {
    get(`${app.url}/v1/models`, { agent, headers: { Authorization: 'Bearer test-key' } }, res => {
      const port = res.socket.localPort;
      res.resume();
      res.on('end', () => resolve(port));
    }).on('error', reject);
  });
  try {
    const port = await request();
    await new Promise(resolve => setTimeout(resolve, 6100));
    expect(await request()).toBe(port);
  } finally { agent.destroy(); }
}, 10_000);

test('configured context profiles route exact model names and describe their real backend windows', async () => {
  const app = await setup((_req, res) => json(res, 200, { choices: [] }),
    { models: { 'test-model': 131072, 'standard-model': 32768 } });
  const response = await app.send({ ...body, model: 'standard-model' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ model: 'standard-model', inference: { model: 'standard-model' } });
  expect(app.backend.requests[0]!.body).toMatchObject({ model: 'standard-model' });
  expect((await app.send(body)).status).toBe(200);
  expect(app.backend.requests[1]!.body).toMatchObject({ model: 'test-model' });
  expect((await app.send({ ...body, model: 'toString' })).status).toBe(404);
  const listed = await fetch(`${app.url}/v1/models`, { headers: { Authorization: 'Bearer test-key' } });
  expect((await listed.json()).data).toEqual([
    { id: 'test-model', context_window: 131072, object: 'model', created: 0, owned_by: 'local' },
    { id: 'standard-model', context_window: 32768, object: 'model', created: 0, owned_by: 'local' },
  ]);
});

test('eight configured slots admit eight requests without the old five-request cap', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = await setup(async (_req, res) => { await gate; json(res, 200, { choices: [] }); },
    { concurrency: 8, perKeyConcurrency: 8 });
  const pending = Array.from({ length: 8 }, () => app.send(body));
  try {
    await expect.poll(() => app.backend.requests.length).toBe(8);
    expect((await app.send(body)).status).toBe(429);
  } finally { release(); }
  expect((await Promise.all(pending)).every(r => r.status === 200)).toBe(true);
});

test('llama.cpp JSON mode gets an explicit object schema while supplied schemas are preserved', async () => {
  const app = await setup((_req, res) => json(res, 200, { choices: [] }), { backend: 'llama.cpp' });
  expect((await app.send({ ...body, response_format: { type: 'json_object' } })).status).toBe(200);
  expect(app.backend.requests[0]!.body).toMatchObject({ response_format: { type: 'json_object', schema: { type: 'object' } } });
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'] };
  expect((await app.send({ ...body, response_format: { type: 'json_object', schema } })).status).toBe(200);
  expect(app.backend.requests[1]!.body).toMatchObject({ response_format: { type: 'json_object', schema } });
});

test.each([1, 2])('configurable admission allows two requests per key with %i backend slots', async concurrency => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = await setup(async (_req, res) => { await gate; json(res, 200, { choices: [] }); },
    { concurrency, perKeyConcurrency: 2 });
  const pending = [app.send(body), app.send(body)];
  try {
    await expect.poll(() => app.backend.requests.length).toBe(concurrency);
    expect((await app.send(body)).status).toBe(429);
  } finally { release(); }
  expect((await Promise.all(pending)).map(r => r.status)).toEqual([200, 200]);
  expect((await app.send(body)).status).toBe(200);
});

test('configured deadline aborts a backend that has not sent response headers', async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const app = await setup((_req, res) => { res.once('close', closed); }, { timeoutMs: 100 });
  const response = await app.send(body);
  expect(response.status).toBe(504);
  expect(await response.json()).toMatchObject({ error: { code: 'REQUEST_TIMEOUT', request_id: response.headers.get('x-request-id'), stage: 'inference', retryable: true, usage: null, charged: false } });
  await disconnected;
  expect(app.logs.at(-1)).toMatchObject({ status: 504, error_code: 'REQUEST_TIMEOUT' });
});

test('backend overload stays retryable, errors are sanitized, and redirects are not followed', async () => {
  let status = 429;
  const app = await setup((_req, res) => {
    res.setHeader('Location', 'http://127.0.0.1/private');
    json(res, status, { error: 'private backend details' });
  });
  for (status of [429, 500, 302]) {
    const response = await app.send(body);
    expect(response.status).toBe(status === 429 ? 429 : 503);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(await response.text()).not.toMatch(/private/);
    expect(app.logs.at(-1)).toMatchObject({ upstream_status: status });
  }
  expect(app.backend.requests).toHaveLength(3);
});

test('each key identity allows 60 requests per minute and rejects request 61', async () => {
  const app = await setup((_req, res) => json(res, 200, { choices: [] }));
  const models = (key: string) => fetch(`${app.url}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  for (let i = 0; i < 60; i++) {
    const response = await models('test-key');
    expect(response.status).toBe(200);
    await response.json();
  }
  const rejected = await models('test-key');
  expect(rejected.status).toBe(429);
  expect((await rejected.json()).error.message).toBe('Maximum 60 requests per minute per key.');
  app.keys.push({ user: 'bob', sha256: hashKey('other-key'), enabled: true });
  const independent = await models('other-key');
  expect(independent.status).toBe(200);
  await independent.json();
});

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

test('context budget uses rendered token count, preserves exact limits and rejects before generation', async () => {
  const app = await setup((req, res) => {
    if (req.pathname === '/apply-template') json(res, 200, { prompt: 'rendered private instruction with tools' });
    else if (req.pathname === '/tokenize') json(res, 200, { tokens: Array(17146).fill(1) });
    else json(res, 200, { choices: [] });
  }, { backend: 'llama.cpp', models: { 'test-model': 32768 } });
  const rejected = await app.send({ ...body, max_tokens: 16384 });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ error: { code: 'CONTEXT_LENGTH_EXCEEDED', stage: 'validation', retryable: false } });
  expect(app.backend.requests.map(r => r.pathname)).toEqual(['/apply-template', '/tokenize']);
  expect((await app.send({ ...body, max_tokens: 15622 })).status).toBe(200);
  expect(app.backend.requests.at(-1)!.body).toMatchObject({ max_tokens: 15622, messages: body.messages });
  expect((await app.send({ ...body, max_tokens: 16385 })).status).toBe(400);
});

test('SSE heartbeats cover waiting for headers, and late errors remain identifiable', async () => {
  const app = await setup(async (_req, res) => {
    await new Promise(resolve => setTimeout(resolve, 80));
    json(res, 500, { error: 'private failure' });
  }, { heartbeatMs: 10 });
  const response = await app.send({ ...body, stream: true });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain(': heartbeat');
  let text = first;
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
  expect(text).toContain('BACKEND_UNAVAILABLE');
  expect(text).toContain(response.headers.get('x-request-id'));
  expect(text).not.toContain('private failure');
  expect(app.logs.at(-1)).toMatchObject({ error_code: 'BACKEND_UNAVAILABLE' });
});

test('schema mismatch is never returned as successful stop; length remains an explicit partial result', async () => {
  let finish = 'stop';
  const app = await setup((_req, res) => json(res, 200, { choices: [{ finish_reason: finish, message: { content: '{"answer":9}' } }], usage: { total_tokens: 20 } }));
  const request = { ...body, response_format: { type: 'json_schema', json_schema: { name: 'bounded', strict: true,
    schema: { type: 'object', properties: { answer: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['answer'], additionalProperties: false } } } };
  const invalid = await app.send(request);
  expect(invalid.status).toBe(502);
  expect(await invalid.json()).toMatchObject({ error: { code: 'SCHEMA_VALIDATION_FAILED', usage: { total_tokens: 20 } } });
  finish = 'length';
  const partial = await app.send(request);
  expect(partial.status).toBe(200);
  expect((await partial.json()).choices[0].finish_reason).toBe('length');
});

test('backend keep-alive advertisement cannot cause a stale connection to be reused', async () => {
  const sockets = new Set();
  const app = await setup((_req, res) => {
    const socket = res.socket!;
    sockets.add(socket);
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=5');
    res.once('finish', () => socket.end());
    json(res, 200, { choices: [] });
  });
  expect((await app.send(body)).status).toBe(200);
  expect((await app.send(body)).status).toBe(200);
  expect(sockets.size).toBe(2);
});
