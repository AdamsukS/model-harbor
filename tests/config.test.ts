import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadRuntimeSources } from '../src/config';

describe('loadConfig', () => {
  it('returns local 128K defaults with a five-user single-worker boundary', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      server: { host: '127.0.0.1', port: 8787 },
      ollama: {
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3.5:9b-128k',
        sourceModel: 'qwen3.5:9b-q4_K_M',
        contextTokens: 131_072,
        kvCacheType: 'q4_0',
        thinking: false,
        timeoutMs: 300_000,
      },
      plasmod: {
        baseUrl: 'http://127.0.0.1:8080',
        timeoutMs: 10_000,
        topK: 5,
      },
      limits: {
        concurrency: 1,
        queueSize: 5,
        maxUsers: 5,
        contextCharacters: 360_000,
      },
      agent: {
        id: 'agent.model-harbor.local',
        tenantId: 'model-harbor.local',
      },
    });
  });

  it.each([
    ['MODEL_HARBOR_PORT', '0'],
    ['MODEL_HARBOR_MAX_USERS', '6'],
    ['MODEL_HARBOR_QUEUE_SIZE', '-1'],
    ['MODEL_HARBOR_CONTEXT_TOKENS', '12.5'],
    ['OLLAMA_BASE_URL', 'not-a-url'],
    ['PLASMOD_BASE_URL', 'file:///tmp/plasmod'],
  ])('rejects invalid %s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow();
  });

  it('normalizes dependency base URLs without a trailing slash', () => {
    const config = loadConfig({
      OLLAMA_BASE_URL: 'http://localhost:11434/',
      PLASMOD_BASE_URL: 'http://localhost:8080///',
    });

    expect(config.ollama.baseUrl).toBe('http://localhost:11434');
    expect(config.plasmod.baseUrl).toBe('http://localhost:8080');
  });

  it('allows deliberate opt-in to model thinking', () => {
    expect(loadConfig({ OLLAMA_THINKING: 'true' }).ollama.thinking).toBe(true);
    expect(() => loadConfig({ OLLAMA_THINKING: 'sometimes' })).toThrow('OLLAMA_THINKING');
  });
});

describe('loadRuntimeSources', () => {
  it('loads immutable GitHub fork revisions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'model-harbor-sources-'));
    const manifestPath = path.join(directory, 'runtime-sources.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        hypha: {
          repository: 'https://github.com/AdamsukS/Hypha.git',
          revision: 'ac80a8f7d1fbc8136b3bd85d94c48cf6e18dedf5',
          directory: 'hypha',
        },
        plasmod: {
          repository: 'https://github.com/AdamsukS/Plasmod.git',
          revision: '26ae0b58cae7798d106d65ca1a4bd8120828a011',
          directory: 'plasmod',
        },
      })
    );

    await expect(loadRuntimeSources(manifestPath)).resolves.toMatchObject({
      hypha: { directory: 'hypha' },
      plasmod: { directory: 'plasmod' },
    });
  });

  it('rejects mutable branch names and non-GitHub repositories', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'model-harbor-sources-'));
    const manifestPath = path.join(directory, 'runtime-sources.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        hypha: {
          repository: 'https://example.com/Hypha.git',
          revision: 'main',
          directory: 'hypha',
        },
        plasmod: {
          repository: 'https://github.com/AdamsukS/Plasmod.git',
          revision: '26ae0b58cae7798d106d65ca1a4bd8120828a011',
          directory: 'plasmod',
        },
      })
    );

    await expect(loadRuntimeSources(manifestPath)).rejects.toThrow();
  });
});
