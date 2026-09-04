import { describe, expect, it, vi } from 'vitest';
import { AgentTools } from '../src/tool-runtime';
import type { InferenceClient, InferenceMessage } from '../src/ollama-client';

const scope = { userId: 'owner', tenantId: 'tenant', agentId: 'agent', sessionId: 'session' };
const tools = new AgentTools({ owner: 'owner', token: 'x'.repeat(64), searchKey: 'test-key', appleScript: '/not-executed.js' });

function modelCalling(name: string, args: Record<string, unknown>) {
  const requests: InferenceMessage[][] = [];
  const client: InferenceClient = {
    health: async () => ({ modelAvailable: true }),
    chat: async (messages) => {
      requests.push([...messages]);
      return { model: 'test', content: requests.length === 1 ? '' : 'Done', promptTokens: 2, completionTokens: 1,
        ...(requests.length === 1 ? { toolCalls: [{ function: { name, arguments: args } }] } : {}) };
    },
  };
  return { client, requests };
}

describe('governed Agent tools', () => {
  it('requires both the owner and a matching token for local tools', () => {
    expect(tools.authorizeLocal('owner', 'x'.repeat(64))).toBe(true);
    expect(tools.authorizeLocal('other', 'x'.repeat(64))).toBe(false);
    expect(tools.authorizeLocal('owner', '')).toBe(false);
    expect(tools.definitions('local').some((tool) => tool.function.name === 'web_search')).toBe(false);
    expect(tools.definitions('public').some((tool) => tool.function.name === 'mail_list')).toBe(false);
  });

  it('runs native time through Hypha and preserves tool call/result ordering', async () => {
    const { client, requests } = modelCalling('current_time', { timezone: 'UTC' });
    const result = await tools.run(client, [{ role: 'user', content: 'Time?' }], scope, 'public', 5000);
    expect(result.content).toBe('Done');
    expect(result.promptTokens).toBe(4);
    expect(requests[1]?.at(-1)).toMatchObject({ role: 'tool', tool_name: 'current_time' });
    expect(JSON.parse(requests[1]!.at(-1)!.content)).toMatchObject({ status: 'completed', output: { timezone: 'UTC' } });
    expect(result.trace.length).toBeGreaterThan(0);
  });

  it('rejects invalid inputs and unknown tool names before provider execution', async () => {
    for (const [name, args] of [['current_time', { timezone: 42 }], ['exec_shell', { command: 'anything' }]] as const) {
      const { client, requests } = modelCalling(name, args);
      await tools.run(client, [{ role: 'user', content: 'Test' }], scope, 'public', 5000);
      expect(JSON.parse(requests[1]!.at(-1)!.content).status).not.toBe('completed');
    }
  });

  it('denies search queries changed by the model, preventing private-data exfiltration', async () => {
    const { client, requests } = modelCalling('web_search', { query: 'private email data' });
    await tools.run(client, [{ role: 'user', content: 'Search' }], scope, 'public', 5000, 'approved public query');
    expect(JSON.parse(requests[1]!.at(-1)!.content).status).toBe('denied');
  });

  it('routes approved public search through the MCP adapter and records actual MCP events', async () => {
    const invoke = vi.fn(async () => ({ content: [{ type: 'text', text: 'https://example.com' }] }));
    const exaTools = new AgentTools({ owner: 'owner', token: 'x'.repeat(64), searchKey: '', appleScript: '',
      exa: { invoke, health: async () => ({ status: 'healthy', checkedAt: new Date().toISOString() }) } });
    const { client } = modelCalling('web_search', { query: 'public query' });
    const result = await exaTools.run(client, [{ role: 'user', content: 'Search' }], scope, 'public', 5000, 'public query');
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'exa', capabilityId: 'web_search_exa', input: { query: 'public query' } }));
    expect(result.trace).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'mcp.call.completed' })]));
    expect(exaTools.catalog()).toContainEqual(expect.objectContaining({ name: 'web_search', provider: 'exa_mcp', status: 'configured_free_no_key' }));
    expect(exaTools.definitions('local').some((item) => item.function.name === 'web_search')).toBe(false);
    for (const approved of ['', 'different query']) {
      invoke.mockClear();
      await exaTools.run(modelCalling('web_search', { query: 'public query' }).client, [{ role: 'user', content: 'Search' }], scope, 'public', 5000, approved);
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  it('bounds models that keep requesting tools', async () => {
    const client: InferenceClient = {
      health: async () => ({ modelAvailable: true }),
      chat: async () => ({ model: 'test', content: '', promptTokens: 1, completionTokens: 1,
        toolCalls: [{ function: { name: 'current_time', arguments: {} } }] }),
    };
    await expect(tools.run(client, [{ role: 'user', content: 'Time' }], scope, 'public', 50_000)).rejects.toThrow('four inference steps');
  });
});
