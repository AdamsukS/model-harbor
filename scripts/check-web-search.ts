import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const query = process.argv[2] || 'Model Context Protocol official documentation';
  const directory = path.resolve('runtime/evals', `web-search-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const response = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-ID': 'web-search-check', 'X-Session-ID': 'public-search' },
    body: JSON.stringify({ messages: [{ role: 'user', content: `Use web_search with this exact approved query: ${JSON.stringify(query)}. Summarize the results briefly and cite the returned URLs. If the tool fails, report the failure.` }],
      tool_mode: 'public', search_query: query, memory_mode: 'off', memory_write: false }),
    signal: AbortSignal.timeout(320000),
  });
  const result = await response.json() as { choices?: Array<{ message: { content: string } }>; benchmark?: { toolTrace?: Array<{ type: string }> } };
  await writeFile(path.join(directory, 'trace.json'), JSON.stringify({ query, status: response.status, result }, null, 2), { mode: 0o600 });
  const passed = response.ok && result.benchmark?.toolTrace?.some((event) => event.type === 'mcp.call.completed') && /https?:\/\//.test(result.choices?.[0]?.message.content || '');
  console.log(JSON.stringify({ passed: Boolean(passed), directory, status: response.status, answer: result.choices?.[0]?.message.content }, null, 2));
  if (!passed) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
