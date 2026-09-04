import path from 'node:path';
import { loadAgentContract } from './agent-contract';
import { loadConfig } from './config';
import { OllamaClient } from './ollama-client';
import { PlasmodClient } from './plasmod-client';
import { createService } from './service';
import { createAgentTools } from './tool-runtime';

async function main(): Promise<void> {
  const config = loadConfig();
  const contract = await loadAgentContract(path.resolve('.'));
  const service = createService({
    config,
    contract,
    ollama: new OllamaClient(config.ollama),
    plasmod: new PlasmodClient(config.plasmod),
    tools: await createAgentTools(path.resolve('.')),
  });
  const baseUrl = await service.listen();
  process.stdout.write(`ModelHarbor listening at ${baseUrl}\n`);

  const shutdown = async () => {
    await service.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
