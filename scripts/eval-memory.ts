import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// These are realistic workflow fixtures, not an official benchmark or private-account tasks.
const cases = [
  { id: 'email-renewal', seed: 'For the Aster supplier renewal, the contact is renewal@example.invalid and the reference is AST-7319. All renewal drafts must quote that reference.',
    task: 'Draft a short Aster supplier renewal email. Use the contact and reference I gave you. Do not invent missing details.', required: ['renewal@example.invalid', 'AST-7319'] },
  { id: 'calendar-planning', seed: 'My Lumen project check-in is 25 minutes, starts at 14:15 Asia/Shanghai, and must use room Cedar-42. This is my confirmed Lumen scheduling preference.',
    task: 'Prepare a Lumen project check-in calendar entry using my saved time, duration and room. Return those details only; do not invent missing details.', required: ['14:15', '25', 'Cedar-42'] },
  { id: 'deployment-handoff', seed: 'For the Nova staging deployment, the approved port is 9347, model alias is nova-canary-17, and KV format is q8_0. These are staging-only settings.',
    task: 'Write the Nova staging handoff with my approved port, model alias and KV format. Do not substitute general defaults or invent missing details.', required: ['9347', 'nova-canary-17', 'q8_0'] },
  { id: 'followup-tracking', seed: 'For the Iris follow-up, Mira owns the review, the ticket is IRIS-5826, and the required deliverable is a two-page risk memo. Use these details when preparing the Iris follow-up.',
    task: 'Draft the Iris follow-up checklist using the owner, ticket and deliverable I previously specified. Do not invent missing details.', required: ['Mira', 'IRIS-5826', 'two-page'] },
];
const baseUrl = process.env.MODEL_HARBOR_EVAL_URL || 'http://127.0.0.1:8787';
const runId = `memory-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const directory = path.resolve('runtime/evals', runId);
const rows: Array<Record<string, unknown>> = [];

async function chat(user: string, session: string, task: string, mode: string, write = false) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-ID': user, 'X-Session-ID': session },
    body: JSON.stringify({ messages: [{ role: 'user', content: task }], memory_mode: mode, memory_write: write, tool_mode: 'off' }),
    signal: AbortSignal.timeout(320_000),
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = { runId, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }),
    runtime: await (await fetch(`${baseUrl}/v1/bench/runtime`)).json(),
    protocol: '2 repetitions; alternating on/off order; fresh request without seed/history; read-only probes; isolated user per case; exact required facts; no retries or best-of selection', cases };
  await writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  for (const item of cases) {
    const user = `eval-${randomUUID()}`;
    const seedSession = `seed-${item.id}`;
    const seed = await chat(user, seedSession, item.seed + ' Acknowledge briefly.', 'off', true);
    await writeFile(path.join(directory, `${item.id}-seed.json`), JSON.stringify(seed, null, 2), { mode: 0o600 });
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const mode of repeat === 0 ? ['off', 'user'] : ['user', 'off']) {
        const data = await chat(user, `probe-${repeat}-${mode}`, item.task, mode);
        const answer = data.choices[0].message.content as string;
        const satisfied = item.required.filter((fact) => answer.toLowerCase().includes(fact.toLowerCase()));
        const row = { case: item.id, repeat, mode, satisfied, required: item.required, passed: satisfied.length === item.required.length,
          memoryHits: data.benchmark.memoryHits, elapsedMs: data.benchmark.totalMs, response: data };
        rows.push(row);
        await writeFile(path.join(directory, 'traces.json'), JSON.stringify(rows, null, 2), { mode: 0o600 });
        console.log(`${item.id} #${repeat + 1} ${mode}: ${satisfied.length}/${item.required.length}; recall=${data.benchmark.memoryHits}`);
      }
    }
    const isolation = await chat(`outsider-${randomUUID()}`, 'probe', item.task, 'user');
    const leaked = item.required.filter((fact) => isolation.choices[0].message.content.toLowerCase().includes(fact.toLowerCase()));
    rows.push({ case: item.id, mode: 'other-user', leaked, memoryHits: isolation.benchmark.memoryHits, passed: leaked.length === 0 && isolation.benchmark.memoryHits === 0, response: isolation });
    const sessionOnly = await chat(user, 'new-session', item.task, 'session');
    rows.push({ case: item.id, mode: 'new-session-only', memoryHits: sessionOnly.benchmark.memoryHits, passed: sessionOnly.benchmark.memoryHits === 0, response: sessionOnly });
    await writeFile(path.join(directory, 'traces.json'), JSON.stringify(rows, null, 2), { mode: 0o600 });
  }
  const summary = Object.fromEntries(['off', 'user', 'other-user', 'new-session-only'].map((mode) => {
    const group = rows.filter((row) => row.mode === mode);
    return [mode, { passed: group.filter((row) => row.passed).length, total: group.length }];
  }));
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory, summary }, null, 2));
}
main().catch(async (error) => {
  await writeFile(path.join(directory, 'failure.txt'), String(error), { mode: 0o600 });
  console.error(error);
  process.exitCode = 1;
});
