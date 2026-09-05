import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { AdmissionQueue, AdmissionError } from './admission-queue.js';

export interface InferenceKey { user: string; sha256: string; enabled: boolean }
export interface Options {
  upstream: string;
  model: string;
  keys: () => InferenceKey[];
  log: (event: Record<string, unknown>) => void;
  timeoutMs?: number;
  maxTokens?: number;
}

const BODY_LIMIT = 2 * 1024 * 1024;
const MAX_TOKENS = 16384;
export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');
const fault = (status: number, message: string) => Object.assign(new Error(message), { status });
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const PARAMETER_FIELDS = ['max_tokens', 'temperature', 'top_p', 'seed', 'frequency_penalty', 'presence_penalty', 'reasoning_effort'];

// Keep the OpenAI SSE envelope, including empty choices on the final usage chunk.
export async function* annotateStream(source: AsyncIterable<Uint8Array>, metadata: () => Record<string, unknown>,
  onUsage: (usage: unknown) => void): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let first = true;
  for await (const bytes of source) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      if (boundary.index > BODY_LIMIT) throw new Error('SSE frame exceeds limit.');
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') { yield 'data: [DONE]\n\n'; return; }
      if (!data) { yield `${frame}\n\n`; continue; }
      const chunk: unknown = JSON.parse(data);
      if (!object(chunk)) throw new Error('Invalid SSE chunk.');
      if (chunk.usage) onUsage(chunk.usage);
      const finished = Array.isArray(chunk.choices) && chunk.choices.some(choice => object(choice) && choice.finish_reason != null);
      if (first || finished || chunk.usage) chunk.inference = metadata();
      first = false;
      yield `data: ${JSON.stringify(chunk)}\n\n`;
    }
    if (buffer.length > BODY_LIMIT) throw new Error('SSE frame exceeds limit.');
  }
  throw new Error('Backend stream ended before [DONE].');
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw fault(415, 'Use Content-Type: application/json.');
  }
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw fault(413, 'Body exceeds 2 MiB.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw fault(413, 'Body exceeds 2 MiB.');
    chunks.push(Buffer.from(chunk));
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fault(400, 'Invalid JSON.'); }
  if (!object(body)) throw fault(400, 'Expected a JSON object.');
  return body;
}

function completion(body: Record<string, unknown>, model: string, user: string, maxTokens: number): Record<string, unknown> {
  if (body.model !== model && body.model !== 'local-default') throw fault(404, 'Model not available.');
  if (!Array.isArray(body.messages) || !body.messages.length) throw fault(400, 'messages must be a nonempty array.');
  for (const message of body.messages) {
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(String(message.role))) {
      throw fault(400, 'Invalid message role.');
    }
    const content = message.content;
    // Text-only ingress prevents upstream image URL fetching into private networks.
    if (!(typeof content === 'string' || (content == null && message.role === 'assistant' && Array.isArray(message.tool_calls)) ||
      (Array.isArray(content) && content.every(part => object(part) && part.type === 'text' && typeof part.text === 'string')))) {
      throw fault(400, 'This endpoint accepts text content and function tool calls only.');
    }
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw fault(400, 'stream must be boolean.');
  if (body.n !== undefined && body.n !== 1) throw fault(400, 'Only n=1 is supported.');
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
    throw fault(400, 'Specify only one output-token limit.');
  }
  const tokens = body.max_completion_tokens ?? body.max_tokens ?? Math.min(1024, maxTokens);
  if (!Number.isSafeInteger(tokens) || Number(tokens) < 1 || Number(tokens) > maxTokens) {
    throw fault(400, `Output-token limit must be between 1 and ${maxTokens}.`);
  }
  for (const [key, min, max] of [['temperature', 0, 2], ['top_p', 0, 1], ['frequency_penalty', -2, 2], ['presence_penalty', -2, 2]] as const) {
    const value = body[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) throw fault(400, `Invalid ${key}.`);
  }
  if (body.seed !== undefined && !Number.isSafeInteger(body.seed)) throw fault(400, 'seed must be an integer.');
  if (body.reasoning !== undefined && (!object(body.reasoning) || typeof body.reasoning.effort !== 'string')) throw fault(400, 'Invalid reasoning.');
  const effort = body.reasoning_effort ?? (object(body.reasoning) ? body.reasoning.effort : undefined) ?? 'none';
  if (!['none', 'low', 'medium', 'high', 'max'].includes(String(effort))) throw fault(400, 'Invalid reasoning effort.');
  if (body.stream_options !== undefined && (!object(body.stream_options) ||
    (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean'))) throw fault(400, 'Invalid stream_options.');
  const fields = ['messages', 'stream', 'stream_options', 'temperature', 'top_p', 'seed', 'stop',
    'frequency_penalty', 'presence_penalty', 'response_format', 'tools', 'tool_choice'];
  return {
    ...Object.fromEntries(fields.filter(key => body[key] !== undefined).map(key => [key, body[key]])),
    model, user, max_tokens: tokens,
    reasoning_effort: effort,
    ...(body.stream ? { stream_options: { include_usage: object(body.stream_options) ? body.stream_options.include_usage ?? true : true } } : {}),
  };
}

export function createInferenceGateway(options: Options) {
  const maxTokens = options.maxTokens ?? MAX_TOKENS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Invalid maximum token limit.');
  const queue = new AdmissionQueue({ concurrency: 1, queueSize: 5, maxUsers: 5 });
  const busy = new Set<string>();
  const rates = new Map<string, { start: number; count: number }>();
  return createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, (req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const id = randomUUID();
    let user: string | undefined;
    let admitted = false;
    let usage: unknown;
    let parameters: Record<string, unknown> | undefined;
    let queueMs = 0;
    let upstreamStarted: number | undefined;
    const metadata = () => ({ request_id: id, model: options.model, parameters,
      parameter_source: 'forwarded_request',
      backend_default_parameters: PARAMETER_FIELDS.filter(key => parameters?.[key] === undefined),
      timing_ms: { queue: queueMs, upstream: upstreamStarted === undefined ? 0 : Date.now() - upstreamStarted, total: Date.now() - started },
      usage_source: usage ? 'backend' : 'not_reported',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 600_000);
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', disconnected);
    req.setTimeout(30_000, () => { controller.abort(); req.destroy(); });
    res.setHeader('X-Request-ID', id);
    res.setHeader('Cache-Control', 'no-store');
    try {
      // Keys are reloaded per request, so disabling a key takes effect immediately.
      const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const hash = token ? hashKey(token) : '';
      user = options.keys().find(key => key.enabled && key.sha256 === hash)?.user;
      if (!user) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw fault(401, 'A valid API key is required.');
      }
      let rate = rates.get(user);
      if (!rate || started - rate.start >= 60_000) {
        rate = { start: started, count: 0 };
        rates.set(user, rate);
      }
      if (++rate.count > 30) throw fault(429, 'Maximum 30 requests per minute per key.');
      if (req.method === 'GET' && req.url === '/v1/models') {
        json(res, 200, { object: 'list', data: [{ id: options.model, object: 'model', created: 0, owned_by: 'local' }] });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw fault(404, 'Endpoint not available.');
      if (busy.has(user) || busy.size >= 5) throw fault(429, 'One in-flight request per key; five requests total.');
      busy.add(user);
      admitted = true;
      const body = completion(await readBody(req), options.model, user, maxTokens);
      parameters = Object.fromEntries(PARAMETER_FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
      req.setTimeout(0);
      const queuedAt = Date.now();
      await queue.run(user, async () => {
        controller.signal.throwIfAborted();
        upstreamStarted = Date.now();
        queueMs = upstreamStarted - queuedAt;
        const upstream = await fetch(`${options.upstream}/v1/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
        });
        // Do not reflect backend errors or internal URLs to public callers.
        if (!upstream.ok) {
          await upstream.body?.cancel();
          throw fault(upstream.status === 400 ? 400 : 503,
            upstream.status === 400 ? 'Backend rejected the request parameters.' : 'Inference backend is unavailable.');
        }
        if (body.stream) {
          if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
            throw fault(502, 'Invalid streaming response from backend.');
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
          const source = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
          await pipeline(Readable.from(annotateStream(source, metadata, value => { usage = value; })), res,
            { signal: controller.signal });
        } else {
          const result = await upstream.json() as Record<string, unknown>;
          usage = result.usage;
          json(res, 200, { ...result, inference: metadata() });
        }
      });
    } catch (error) {
      const status = controller.signal.aborted ? 504 : error instanceof AdmissionError ? 429 :
        object(error) && typeof error.status === 'number' ? error.status : 503;
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy();
        else {
          if (status === 429) res.setHeader('Retry-After', '10');
          // Drain rejected uploads without buffering, so clients can read the HTTP error.
          if (!req.complete) req.resume();
          json(res, status, { error: { message: status === 504 ? 'Request timed out.' :
            object(error) && typeof error.status === 'number' && error instanceof Error ? error.message : 'Inference service is unavailable.',
          type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'api_error', code: String(status) } });
        }
      }
    } finally {
      clearTimeout(timer);
      res.off('close', disconnected);
      if (admitted && user) busy.delete(user);
      options.log({ time: new Date().toISOString(), request_id: id, user: user ?? 'unauthenticated',
        status: res.destroyed && !res.writableFinished ? 499 : res.statusCode,
        duration_ms: Date.now() - started, ...(usage ? { usage } : {}), ...(parameters ? { inference: metadata() } : {}) });
    }
  }
}

if (require.main === module) {
  const stateDir = process.env.INFERENCE_STATE_DIR;
  const config = stateDir ? JSON.parse(readFileSync(join(stateDir, 'sharing.local.json'), 'utf8')) : {};
  const keyFile = process.env.INFERENCE_KEYS_FILE ?? (stateDir ? join(stateDir, 'keys.json') : undefined);
  const logDir = process.env.INFERENCE_LOG_DIR ?? (stateDir ? join(stateDir, 'logs') : undefined);
  if (!keyFile || !logDir) throw new Error('INFERENCE_KEYS_FILE and INFERENCE_LOG_DIR are required.');
  const keys = () => JSON.parse(readFileSync(keyFile, 'utf8')) as InferenceKey[];
  if (!keys().some(key => key.enabled && /^[a-f0-9]{64}$/.test(key.sha256))) throw new Error('No valid keys configured.');
  const server = createInferenceGateway({
    upstream: config.upstream ?? 'http://127.0.0.1:11434', model: config.model ?? 'qwen3.5:9b-128k', keys,
    maxTokens: config.maxTokens ?? MAX_TOKENS,
    log: event => {
      try { appendFileSync(`${logDir}/${new Date().toISOString().slice(0, 10)}.jsonl`, `${JSON.stringify(event)}\n`, { mode: 0o600 }); }
      catch { console.error('Unable to write inference access log.'); }
    },
  });
  server.listen(config.port ?? 8788, '127.0.0.1', () => console.log('Inference gateway listening on loopback'));
  process.once('SIGTERM', () => { server.close(); setTimeout(() => process.exit(0), 5000).unref(); });
}
