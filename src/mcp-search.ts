import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MCPConnectionManager, SDKMCPConnectionSessionFactory, mcpServerProfileSchema,
  type MCPConnectionSessionFactory, type MCPServerProfile,
} from '@codesoul-co/hypha-mcp';
import type { MCPToolInvocationPort } from '@codesoul-co/hypha-tools';

// Only this reviewed capability is exposed; remote descriptions cannot add tools or permissions.
export function createExaSearchPort(profile: MCPServerProfile,
  sessionFactory: MCPConnectionSessionFactory = new SDKMCPConnectionSessionFactory({ clientInfo: { name: 'ModelHarbor', version: '0.2.0' } }),
): MCPToolInvocationPort {
  return {
    async invoke(request) {
      if (request.serverId !== 'exa' || request.capabilityId !== 'web_search_exa') throw new Error('MCP capability is not allowed.');
      const query = (request.input as { query?: unknown } | null)?.query;
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('Invalid search query.');
      request.context.signal?.throwIfAborted();
      // ponytail: one short-lived connection per search; pool only if handshake cost becomes material.
      const manager = new MCPConnectionManager({ sessionFactory });
      manager.register(profile);
      try {
        return await manager.call({ ...request, input: { query, numResults: 3 } });
      } finally {
        await manager.closeAll();
      }
    },
    async health() {
      return { status: 'unknown', checkedAt: new Date().toISOString(), message: 'Configured; remote availability is checked on each search.' };
    },
  };
}

export async function loadExaSearchPort(root: string): Promise<MCPToolInvocationPort> {
  const profile = mcpServerProfileSchema.parse(JSON.parse(await readFile(path.join(root, 'config/mcp.json'), 'utf8')));
  if (profile.id !== 'exa' || profile.transport.type !== 'streamable_http' ||
      profile.transport.endpoint !== 'https://mcp.exa.ai/mcp?tools=web_search_exa') {
    throw new Error('Only the reviewed Exa web-search MCP endpoint is supported.');
  }
  // JSON cannot contain explicit undefined; the validated optional fields match this contract.
  return createExaSearchPort(profile as MCPServerProfile);
}
