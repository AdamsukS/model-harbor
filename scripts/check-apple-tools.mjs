import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
for (const [operation, input] of [['calendar', { days: 7 }], ['mail', { limit: 5 }]]) {
  try {
    const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', 'scripts/apple-tools.js', operation, JSON.stringify(input)], { timeout: 20000, maxBuffer: 128 * 1024 });
    const result = JSON.parse(stdout);
    console.log(JSON.stringify({ operation, status: 'ok', containers: result.calendarCount ?? result.accountCount, records: (result.events ?? result.messages).length }));
  } catch {
    console.log(JSON.stringify({ operation, status: 'unavailable_or_permission_denied' }));
    process.exitCode = 1;
  }
}
