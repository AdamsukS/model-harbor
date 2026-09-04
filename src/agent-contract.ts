import path from 'node:path';
import {
  compileDomainPackToHarnessedSystem,
  loadDomainPackFile,
} from '@codesoul-co/hypha-domain';

export interface AgentContract {
  agentId: string;
  modelAlias: string;
  workflowId: string;
  memoryProfileId: string;
  reasoningProfileId: string;
  dependencySnapshot: string;
}

export async function loadAgentContract(projectRoot: string): Promise<AgentContract> {
  const agentId = 'agent.model-harbor.local';
  const modelAlias = 'local-default';
  const workflowId = 'workflow.local-chat';
  const memoryProfileId = 'memory.plasmod';
  const reasoningProfileId = 'reasoning.local-chat';
  const domainPack = await loadDomainPackFile(path.join(projectRoot, 'agent', 'domain-pack.yaml'));
  const compiled = compileDomainPackToHarnessedSystem(domainPack, {
    agentRef: { id: agentId, version: '0.1.0' },
    taskSchemaId: 'task.local-chat',
    workflowId,
    memoryProfileId,
    contextProfileId: 'context.local-chat',
    reasoningProfileId,
    agentSkillRefs: [],
    agentToolRefs: [],
    modelProfileRef: { id: modelAlias, version: '0.1.0' },
  });
  return {
    agentId,
    modelAlias,
    workflowId: compiled.bindings.workflow.id,
    memoryProfileId: compiled.bindings.memoryProfile?.id ?? memoryProfileId,
    reasoningProfileId: compiled.bindings.reasoningProfile?.id ?? reasoningProfileId,
    dependencySnapshot: compiled.dependencySnapshot.dependencyHash,
  };
}
