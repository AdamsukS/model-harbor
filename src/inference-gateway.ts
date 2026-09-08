import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { json as readJson } from 'node:stream/consumers';
import { compileResponseSchema } from './inference-schema.js';
import { join } from 'node:path';
import { AdmissionQueue, AdmissionError } from './admission-queue.js';

export interface InferenceKey { user: string; sha256: string; enabled: boolean }
export interface Options {
  upstream: string;
  model: string;
  models?: Record<string, number>;
  keys: () => InferenceKey[];
  log: (event: Record<string, unknown>) => void;
  timeoutMs?: number;
  maxTokens?: number;
  concurrency?: number;
  perKeyConcurrency?: number;
  backend?: 'ollama' | 'llama.cpp';
  heartbeatMs?: number;
}

const BODY_LIMIT = 2 * 1024 * 1024;
const MAX_TOKENS = 16384;
const REQUEST_TIMEOUT_MS = 1_800_000;
export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');
const fault = (status: number, message: string, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Native HTTP honors our AbortSignal without fetch's separate 300-second header/body timers.
function requestCompletion(url: string, body: unknown, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      // The native router advertises keep-alive but can close the socket after a response.
      // A new loopback connection avoids replaying a POST or reusing that stale socket.
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, agent: false,
    }, resolve);
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

const PARAMETER_FIELDS = ['max_tokens', 'temperature', 'top_p', 'seed', 'frequency_penalty', 'presence_penalty', 'reasoning_effort'];

// Keep the OpenAI SSE envelope, including empty choices on the final usage chunk.
export async function* annotateStream(source: AsyncIterable<Uint8Array>, metadata: () => Record<string, unknown>,
  onUsage: (usage: unknown) => void, model?: string, onChunk?: (chunk: Record<string, unknown>) => void): AsyncGenerator<string> {
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
      if (model !== undefined) chunk.model = model;
      if (chunk.usage) onUsage(chunk.usage);
      onChunk?.(chunk);
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
  if (body.model !== model && body.model !== 'local-default') throw fault(404, 'Model not available.', 'MODEL_NOT_FOUND');
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
    throw fault(400, `Output-token limit must be between 1 and ${maxTokens}.`, 'OUTPUT_TOKEN_LIMIT_EXCEEDED');
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
  const concurrency = options.concurrency ?? 1;
  const perKeyConcurrency = options.perKeyConcurrency ?? 1;
  for (const value of [concurrency, perKeyConcurrency]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 8) throw new Error('Concurrency must be between 1 and 8.');
  }
  const models = options.models ?? { [options.model]: undefined };
  if (!Object.hasOwn(models, options.model) || Object.entries(models).some(([name, context]) =>
    !name || (context !== undefined && (!Number.isSafeInteger(context) || context < 1)))) throw new Error('Invalid model profiles.');
  const capacity = Math.max(5, concurrency);
  const queue = new AdmissionQueue({ concurrency, queueSize: capacity, maxUsers: 5 });
  const busy = new Map<string, number>();
  let inFlight = 0;
  const rates = new Map<string, { start: number; count: number }>();
  // Caddy retains idle upstream connections for 120s; expire here afterwards to avoid POST reset/502 races.
  return createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 185_000, maxHeaderSize: 16_384 }, (req, res) => {
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
    let upstreamStatus: number | undefined;
    let errorCode: string | undefined;
    let messageRoles: Record<string, number> | undefined;
    let stage = 'validation';
    let promptTokens: number | undefined;
    let timedOut = false;
    let failureStatus: number | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let model = options.model;
    const metadata = () => ({ request_id: id, model, parameters,
      parameter_source: 'forwarded_request',
      backend_default_parameters: PARAMETER_FIELDS.filter(key => parameters?.[key] === undefined),
      timing_ms: { queue: queueMs, upstream: upstreamStarted === undefined ? 0 : Date.now() - upstreamStarted, total: Date.now() - started },
      usage_source: usage ? 'backend' : 'not_reported', prompt_tokens: promptTokens ?? null, charged: false,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
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
        throw fault(401, 'A valid API key is required.', 'AUTHENTICATION_REQUIRED');
      }
      let rate = rates.get(user);
      if (!rate || started - rate.start >= 60_000) {
        rate = { start: started, count: 0 };
        rates.set(user, rate);
      }
      if (++rate.count > 60) throw fault(429, 'Maximum 60 requests per minute per key.', 'RPM_LIMIT_EXCEEDED');
      if (req.method === 'GET' && req.url === '/v1/models') {
        json(res, 200, { object: 'list', data: Object.entries(models).map(([id, context_window]) =>
          ({ id, object: 'model', created: 0, owned_by: 'local', ...(context_window ? { context_window } : {}) })),
          service: { max_output_tokens: maxTokens, context_policy: 'reject_input_plus_max_output_over_window',
            timeout_seconds: (options.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000, per_key_inflight: perKeyConcurrency, total_inflight: capacity,
            rpm_per_key: 60, tpm_limit: null, daily_token_limit: null, priority_queue: false, idempotency: false, billing: 'none',
            queue: queue.snapshot(), health: 'gateway_only' } });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw fault(404, 'Endpoint not available.', 'ENDPOINT_NOT_FOUND');
      if ((busy.get(user) ?? 0) >= perKeyConcurrency || inFlight >= capacity) {
        throw fault(429, `Maximum ${perKeyConcurrency} in-flight requests per key; ${capacity} requests total.`, 'CONCURRENCY_LIMIT_EXCEEDED');
      }
      busy.set(user, (busy.get(user) ?? 0) + 1);
      inFlight++;
      admitted = true;
      if (req.headers['idempotency-key'] !== undefined) throw fault(400, 'Idempotency-Key is not supported; disconnect cancels this request. Do not assume retries are deduplicated.', 'IDEMPOTENCY_NOT_SUPPORTED');
      const input = await readBody(req);
      if (input.model !== 'local-default') {
        if (typeof input.model !== 'string' || !Object.hasOwn(models, input.model)) throw fault(404, 'Model not available.', 'MODEL_NOT_FOUND');
        model = input.model;
      }
      const body = completion(input, model, user, maxTokens);
      const messages = body.messages as Record<string, unknown>[];
      messageRoles = {};
      for (const message of messages) {
        const role = String(message.role);
        messageRoles[role] = (messageRoles[role] ?? 0) + 1;
      }
      // Qwen's Jinja template requires a user turn even for a system-only task.
      // Keep instruction roles intact; the empty turn adds no task content.
      if (options.backend === 'llama.cpp' && messages.length === 1 && messages.every(message =>
        message.role === 'system' || message.role === 'developer')) {
        body.messages = [...messages, { role: 'user', content: '' }];
      }
      // llama.cpp b10630 needs an explicit object schema to constrain bare JSON mode.
      if (options.backend === 'llama.cpp' && object(body.response_format) &&
          body.response_format.type === 'json_object' && body.response_format.schema === undefined) {
        body.response_format = { ...body.response_format, schema: { type: 'object' } };
      }
      const validateSchema = compileResponseSchema(body.response_format);
      parameters = Object.fromEntries(PARAMETER_FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
      req.setTimeout(0);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        heartbeat = setInterval(() => { if (!res.destroyed && !res.writableNeedDrain) res.write(': heartbeat\n\n'); }, options.heartbeatMs ?? 15_000);
      }
      stage = 'queue';
      const queuedAt = Date.now();
      await queue.run(user, async () => {
        controller.signal.throwIfAborted();
        upstreamStarted = Date.now();
        queueMs = upstreamStarted - queuedAt;
        const callBackend = async (path: string, payload: unknown): Promise<IncomingMessage> => {
          const upstream = await requestCompletion(`${options.upstream}${path}`, payload, controller.signal);
          upstreamStatus = upstream.statusCode;
          if (upstreamStatus === 200) return upstream;
          let detail = '';
          for await (const chunk of upstream) {
            detail += Buffer.from(chunk).toString('utf8').slice(0, 16384 - detail.length);
            if (detail.length >= 16384) break;
          }
          upstream.destroy();
          if (options.backend === 'llama.cpp' && /Jinja Exception: (No user query found in messages\.|No messages provided\.|System message must be at the beginning\.)/.test(detail)) {
            throw fault(400, 'This model requires initial system/developer instructions and a user task retained in messages.', 'CHAT_TEMPLATE_INVALID_MESSAGES');
          }
          if (upstreamStatus === 400) throw fault(400, 'Backend rejected the request parameters.', 'BACKEND_INVALID_REQUEST');
          if (upstreamStatus === 429) throw fault(429, 'Inference capacity is temporarily full.', 'BACKEND_CAPACITY_EXCEEDED');
          if (upstreamStatus === 503 && /loading|no slot|busy|queue|capacity/i.test(detail)) throw fault(429, 'Model is loading or capacity is temporarily full.', 'MODEL_BUSY');
          if (upstreamStatus === 504) throw fault(504, 'Inference backend timed out.', 'UPSTREAM_TIMEOUT');
          throw fault(503, 'Inference backend is unavailable.', 'BACKEND_UNAVAILABLE');
        };
        // Count the actual templated prompt with the loaded model tokenizer, including tools.
        // Reject the full requested budget; never trim input or silently lower max_tokens.
        const context = models[model];
        if (options.backend === 'llama.cpp' && context !== undefined) {
          stage = 'validation';
          const rendered = await readJson(await callBackend('/apply-template', body)) as Record<string, unknown>;
          if (typeof rendered.prompt !== 'string') throw fault(502, 'Invalid template response.', 'INVALID_BACKEND_RESPONSE');
          const tokenized = await readJson(await callBackend('/tokenize', { model, content: rendered.prompt, add_special: true, parse_special: true })) as Record<string, unknown>;
          if (!Array.isArray(tokenized.tokens)) throw fault(502, 'Invalid tokenizer response.', 'INVALID_BACKEND_RESPONSE');
          promptTokens = tokenized.tokens.length;
          if (promptTokens + Number(body.max_tokens) > context) throw fault(400,
            `Prompt (${promptTokens}) plus max_tokens (${body.max_tokens}) exceeds context window (${context}). Reduce input or max_tokens.`, 'CONTEXT_LENGTH_EXCEEDED');
        }
        const checkContent = (content: string): void => {
          if (!validateSchema) return;
          let parsed: unknown;
          try { parsed = JSON.parse(content); } catch { throw fault(502, 'Generated content is not valid JSON.', 'SCHEMA_VALIDATION_FAILED'); }
          if (!validateSchema(parsed)) throw fault(502, 'Generated content did not satisfy the requested schema.', 'SCHEMA_VALIDATION_FAILED');
        };
        stage = 'inference';
        const upstream = await callBackend('/v1/chat/completions', body);
        if (body.stream) {
          if (!upstream.headers['content-type']?.includes('text/event-stream')) {
            upstream.destroy();
            throw fault(502, 'Invalid streaming response from backend.');
          }
          let content = '';
          for await (const frame of annotateStream(upstream, metadata, value => { usage = value; }, model, chunk => {
            if (!validateSchema || !Array.isArray(chunk.choices)) return;
            for (const choice of chunk.choices) if (object(choice)) {
              if (object(choice.delta) && typeof choice.delta.content === 'string') content += choice.delta.content;
              if (content.length > BODY_LIMIT) throw fault(502, 'Generated content exceeds validation limit.', 'INVALID_BACKEND_RESPONSE');
              if (choice.finish_reason === 'stop') checkContent(content);
            }
          })) {
            if (!res.write(frame)) await once(res, 'drain', { signal: controller.signal });
          }
          res.end();
        } else {
          const result = await readJson(upstream) as Record<string, unknown>;
          usage = result.usage;
          if (validateSchema && Array.isArray(result.choices)) for (const choice of result.choices) {
            if (!object(choice) || choice.finish_reason !== 'stop') continue;
            checkContent(object(choice.message) ? String(choice.message.content) : '');
          }
          json(res, 200, { ...result, model, inference: metadata() });
        }
      }, controller.signal);
    } catch (error) {
      if (object(error) && typeof error.code === 'string') errorCode = error.code;
      if (controller.signal.aborted) errorCode = timedOut ? (stage === 'queue' ? 'QUEUE_TIMEOUT' : 'REQUEST_TIMEOUT') : 'CLIENT_DISCONNECTED';
      const status = controller.signal.aborted ? 504 : error instanceof AdmissionError ? 429 :
        object(error) && typeof error.status === 'number' ? error.status : 503;
      failureStatus = status;
      if (!res.destroyed && !res.writableEnded) {
        const retryable = [429, 502, 503, 504].includes(status);
        const payload = { error: {
          message: status === 504 ? 'Request timed out.' : object(error) && typeof error.status === 'number' && error instanceof Error ? error.message : 'Inference service is unavailable.',
          type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'provider_error',
          code: errorCode ?? 'BACKEND_UNAVAILABLE', request_id: id, stage, retryable,
          retry_after: retryable ? 10 : null, usage: usage ?? null, usage_source: usage ? 'backend' : 'not_reported', charged: false,
        } };
        if (res.headersSent) res.end(`data: ${JSON.stringify(payload)}\n\n`);
        else {
          if (retryable) res.setHeader('Retry-After', '10');
          if (!req.complete) req.resume();
          json(res, status, payload);
        }
      }
    } finally {
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      res.off('close', disconnected);
      if (admitted && user) {
        inFlight--;
        const remaining = (busy.get(user) ?? 1) - 1;
        if (remaining) busy.set(user, remaining);
        else busy.delete(user);
      }
      options.log({ time: new Date().toISOString(), request_id: id, user: user ?? 'unauthenticated',
        received_at: new Date(started).toISOString(), stage, prompt_tokens: promptTokens ?? null, charged: false,
        ...(failureStatus ? { failure_status: failureStatus } : {}),
        status: res.destroyed && !res.writableFinished ? 499 : res.statusCode,
        ...(upstreamStatus !== undefined ? { upstream_status: upstreamStatus } : {}),
        ...(errorCode ? { error_code: errorCode } : {}),
        ...(messageRoles ? { message_roles: messageRoles } : {}),
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
    models: config.models,
    maxTokens: config.maxTokens ?? MAX_TOKENS,
    concurrency: config.concurrency ?? 1, perKeyConcurrency: config.perKeyConcurrency ?? 1,
    backend: config.backend ?? 'ollama',
    timeoutMs: (config.timeoutSeconds ?? REQUEST_TIMEOUT_MS / 1000) * 1000,
    log: event => {
      try { appendFileSync(`${logDir}/${new Date().toISOString().slice(0, 10)}.jsonl`, `${JSON.stringify(event)}\n`, { mode: 0o600 }); }
      catch { console.error('Unable to write inference access log.'); }
    },
  });
  server.listen(config.port ?? 8788, '127.0.0.1', () => console.log('Inference gateway listening on loopback'));
  process.once('SIGTERM', () => { server.close(); setTimeout(() => { server.closeAllConnections(); process.exit(0); }, (config.timeoutSeconds ?? 1800) * 1000 + 5000).unref(); });
}
