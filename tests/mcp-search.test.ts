import { describe, expect, it, vi } from 'vitest';
import type { MCPConnectionSession, MCPServerProfile } from '@codesoul-co/hypha-mcp';
import { createExaSearchPort, loadExaSearchPort } from '../src/mcp-search';

const profile: MCPServerProfile = { id: 'exa', mode: 'remote', transport: { type: 'streamable_http', endpoint: 'https://mcp.exa.ai/mcp?tools=web_search_exa' }, contentPolicy: { maxToolResultBytes: 256 } };
const request = { serverId: 'exa', capabilityId: 'web_search_exa', input: { query: 'public query', privateHistory: 'must not leave' }, context: { runId: 'test', stepId: 'search' } };

describe('Exa MCP boundary', () => {
  it('loads the reviewed profile without making a network request', async () => {
    const port = await loadExaSearchPort(process.cwd());
    expect(await port.health('exa')).toMatchObject({ status: 'unknown' });
  });

  it('projects only approved fields and closes the connection after success, failure and oversize output', async () => {
    for (const outcome of ['success', 'error', 'oversize']) {
      const session: MCPConnectionSession = {
        connect: vi.fn(async () => ({})), listCapabilities: async () => [], ping: async () => {}, close: vi.fn(async () => {}),
        callTool: vi.fn(async () => {
          if (outcome === 'error') throw new Error('remote failure');
          return { content: [{ type: 'text', text: outcome === 'oversize' ? 'x'.repeat(1000) : 'source https://example.com' }] };
        }),
      };
      const port = createExaSearchPort(profile, { create: () => session });
      if (outcome === 'success') await expect(port.invoke(request)).resolves.toHaveProperty('content');
      else await expect(port.invoke(request)).rejects.toThrow();
      expect(session.callTool).toHaveBeenCalledWith('web_search_exa', { query: 'public query', numResults: 3 }, expect.anything());
      expect(session.close).toHaveBeenCalledOnce();
    }
  });

  it('rejects unapproved capabilities, malformed queries and cancellation before opening a connection', async () => {
    const create = vi.fn();
    const port = createExaSearchPort(profile, { create });
    await expect(port.invoke({ ...request, capabilityId: 'web_fetch_exa' })).rejects.toThrow('not allowed');
    await expect(port.invoke({ ...request, input: { query: 42 } })).rejects.toThrow('Invalid');
    await expect(port.invoke({ ...request, context: { ...request.context, signal: AbortSignal.abort() } })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
