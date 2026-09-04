import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export interface RecordedRequest {
  method: string;
  pathname: string;
  body: unknown;
}

export async function startTestServer(
  handler: (
    request: RecordedRequest,
    response: ServerResponse<IncomingMessage>
  ) => void | Promise<void>
) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const recorded: RecordedRequest = {
      method: request.method ?? 'GET',
      pathname: new URL(request.url ?? '/', 'http://localhost').pathname,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
    requests.push(recorded);
    await handler(recorded, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind TCP.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}
