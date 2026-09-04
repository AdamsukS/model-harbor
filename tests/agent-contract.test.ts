import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentContract } from '../src/agent-contract';

describe('loadAgentContract', () => {
  it('compiles the product DomainPack through Hypha', async () => {
    const contract = await loadAgentContract(path.resolve('.'));

    expect(contract).toMatchObject({
      agentId: 'agent.model-harbor.local',
      modelAlias: 'local-default',
      workflowId: 'workflow.local-chat',
      memoryProfileId: 'memory.plasmod',
      reasoningProfileId: 'reasoning.local-chat',
    });
    expect(contract.dependencySnapshot).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
