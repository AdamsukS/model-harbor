import { readFile } from 'node:fs/promises';

export interface RuntimeConfig {
  server: { host: string; port: number };
  ollama: {
    baseUrl: string;
    model: string;
    sourceModel: string;
    contextTokens: number;
    timeoutMs: number;
  };
  plasmod: { baseUrl: string; timeoutMs: number; topK: number };
  limits: {
    concurrency: number;
    queueSize: number;
    maxUsers: number;
    contextCharacters: number;
  };
  agent: { id: string; tenantId: string };
}

export interface RuntimeSource {
  repository: string;
  revision: string;
  directory: string;
}

export interface RuntimeSources {
  hypha: RuntimeSource;
  plasmod: RuntimeSource;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    server: {
      host: stringValue(env.MODEL_HARBOR_HOST, '127.0.0.1', 'MODEL_HARBOR_HOST'),
      port: positiveInteger(env.MODEL_HARBOR_PORT, 8787, 'MODEL_HARBOR_PORT'),
    },
    ollama: {
      baseUrl: httpUrl(env.OLLAMA_BASE_URL, 'http://127.0.0.1:11434', 'OLLAMA_BASE_URL'),
      model: stringValue(env.OLLAMA_MODEL, 'qwen3.5:9b-128k', 'OLLAMA_MODEL'),
      sourceModel: stringValue(
        env.OLLAMA_SOURCE_MODEL,
        'qwen3.5:9b-q4_K_M',
        'OLLAMA_SOURCE_MODEL'
      ),
      contextTokens: positiveInteger(
        env.MODEL_HARBOR_CONTEXT_TOKENS,
        131_072,
        'MODEL_HARBOR_CONTEXT_TOKENS'
      ),
      timeoutMs: positiveInteger(env.OLLAMA_TIMEOUT_MS, 300_000, 'OLLAMA_TIMEOUT_MS'),
    },
    plasmod: {
      baseUrl: httpUrl(env.PLASMOD_BASE_URL, 'http://127.0.0.1:8080', 'PLASMOD_BASE_URL'),
      timeoutMs: positiveInteger(env.PLASMOD_TIMEOUT_MS, 10_000, 'PLASMOD_TIMEOUT_MS'),
      topK: positiveInteger(env.PLASMOD_TOP_K, 5, 'PLASMOD_TOP_K'),
    },
    limits: {
      concurrency: positiveInteger(
        env.MODEL_HARBOR_CONCURRENCY,
        1,
        'MODEL_HARBOR_CONCURRENCY'
      ),
      queueSize: positiveInteger(env.MODEL_HARBOR_QUEUE_SIZE, 5, 'MODEL_HARBOR_QUEUE_SIZE'),
      maxUsers: boundedInteger(env.MODEL_HARBOR_MAX_USERS, 5, 'MODEL_HARBOR_MAX_USERS', 1, 5),
      contextCharacters: positiveInteger(
        env.MODEL_HARBOR_CONTEXT_CHARACTERS,
        360_000,
        'MODEL_HARBOR_CONTEXT_CHARACTERS'
      ),
    },
    agent: {
      id: stringValue(env.MODEL_HARBOR_AGENT_ID, 'agent.model-harbor.local', 'MODEL_HARBOR_AGENT_ID'),
      tenantId: stringValue(
        env.MODEL_HARBOR_TENANT_ID,
        'model-harbor.local',
        'MODEL_HARBOR_TENANT_ID'
      ),
    },
  };
}

export async function loadRuntimeSources(filePath: string): Promise<RuntimeSources> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read runtime source manifest: ${messageOf(error)}`);
  }
  if (!isRecord(value)) throw new Error('Runtime source manifest must be an object.');
  return {
    hypha: runtimeSource(value.hypha, 'hypha'),
    plasmod: runtimeSource(value.plasmod, 'plasmod'),
  };
}

function runtimeSource(value: unknown, name: string): RuntimeSource {
  if (!isRecord(value)) throw new Error(`Runtime source ${name} must be an object.`);
  const repository = requiredString(value.repository, `${name}.repository`);
  const revision = requiredString(value.revision, `${name}.revision`);
  const directory = requiredString(value.directory, `${name}.directory`);
  const parsed = new URL(repository);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error(`${name}.repository must be an HTTPS GitHub URL.`);
  }
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error(`${name}.revision must be an immutable 40-character Git commit.`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(directory)) {
    throw new Error(`${name}.directory must be a simple lowercase directory name.`);
  }
  return { repository, revision, directory };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  return boundedInteger(value, fallback, name, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function httpUrl(value: string | undefined, fallback: string, name: string): string {
  const raw = stringValue(value, fallback, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid HTTP URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  return raw.replace(/\/+$/u, '');
}

function stringValue(value: string | undefined, fallback: string, name: string): string {
  const result = value?.trim() || fallback;
  if (!result) throw new Error(`${name} must not be empty.`);
  return result;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
