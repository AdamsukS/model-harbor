// Local-only acceptance runner. No credentials, prompts or generated content are written to logs.
// Run explicitly: node scripts/inference-soak.cjs [hours=24] [long-attempts=21]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const state = process.env.INFERENCE_STATE_DIR || path.join(os.homedir(), 'Library/Application Support/ModelHarbor/inference');
const out = path.join(state, 'acceptance-20260908.jsonl');
const key = /^collaborator-1:\s*(\S+)/m.exec(fs.readFileSync(path.join(state, 'collaborator-keys.txt'), 'utf8'))?.[1];
if (!key) throw Error('Test key is unavailable');
const hours = Number(process.argv[2] || 24);
const longAttempts = Number(process.argv[3] || 21);
let started, deadline;
let count = 0, stopping = false;
const live = new Set();
const record = value => fs.appendFileSync(out, JSON.stringify({ time: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; for (const req of live) req.destroy(); });
const send = (lane, index) => new Promise(resolve => {
  const long = index < longAttempts, begin = Date.now();
  const body = { model: 'qwen3.5:9b-32k', stream: false, temperature: 0, max_tokens: long ? 16384 : 1024,
    messages: [{ role: 'user', content: 'Return the requested JSON array of zeros.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'soak', strict: true,
      // Native grammar caps a single repetition; use rows instead of one 3600-item rule.
      schema: long ? { type: 'array', minItems: 60, maxItems: 60,
        items: { type: 'array', minItems: 60, maxItems: 60, items: { enum: [0] } } }
        : { type: 'array', minItems: 300, maxItems: 300, items: { enum: [0] } } } } };
  const req = http.request('http://127.0.0.1:8788/v1/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 1860000 }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('error', e => done({ status: res.statusCode, error: e.code }));
    res.on('end', () => {
      let result; try { result = JSON.parse(Buffer.concat(chunks)); } catch { result = {}; }
      done({ status: res.statusCode, request_id: res.headers['x-request-id'], finish_reason: result.choices?.[0]?.finish_reason,
        usage: result.usage, code: result.error?.code, preflight_prompt_tokens: result.inference?.prompt_tokens });
    });
  });
  let finished = false;
  function done(result) { if (finished) return; finished = true; live.delete(req); record({ lane, index, long, duration_ms: Date.now() - begin, ...result }); resolve(result); }
  req.on('timeout', () => req.destroy(Object.assign(Error('client timeout'), { code: 'TEST_TIMEOUT' })));
  req.on('error', e => done({ error: e.code || 'REQUEST_ERROR' }));
  live.add(req); req.end(JSON.stringify(body));
});
record({ event: 'waiting_for_idle', pid: process.pid, hours, long_attempts: longAttempts, concurrency: 3, target: 'loopback' });
(async () => {
  // Start only after active user jobs have drained. Never restart the inference services.
  for (;;) {
    if (stopping) return;
    const models = await (await fetch('http://127.0.0.1:11435/models')).json();
    let busy = false;
    for (const model of models.data) if (model.status.value === 'loaded') {
      const slots = await (await fetch('http://127.0.0.1:11435/slots?model=' + encodeURIComponent(model.id))).json();
      busy ||= slots.some(slot => slot.is_processing);
    }
    if (!busy) break;
    await new Promise(r => setTimeout(r, 30000));
  }
  started = Date.now(); deadline = started + hours * 3600000;
  record({ event: 'started', pid: process.pid, hours, long_attempts: longAttempts, concurrency: 3, target: 'loopback', excludes: 'public proxy and client network' });
  await Promise.all([0, 1, 2].map(async lane => {
    let failures = 0;
    while (!stopping && Date.now() < deadline) {
      const result = await send(lane, count++);
      failures = result.status === 200 ? 0 : failures + 1;
      if (failures >= 3) { stopping = true; record({ event: 'stopped_after_repeated_failure', lane }); }
      if (result.status === 400) { stopping = true; record({ event: 'stopped_invalid_test_request', lane }); }
      if (result.status !== 200) await new Promise(r => setTimeout(r, 10000));
    }
  }));
  record({ event: 'finished', elapsed_ms: Date.now() - started, attempts: count, stopped_early: stopping });
})().catch(e => { record({ event: 'runner_error', error: e.code || 'UNEXPECTED' }); process.exitCode = 1; });
