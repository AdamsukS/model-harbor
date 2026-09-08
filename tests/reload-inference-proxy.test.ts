import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test.each([false, true])('proxy hot reload uses the validated host snapshot; validation failure=%s', fail => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-reload-'));
  const source = join(dir, 'host Caddyfile');
  const body = ':80 { respond "host configuration" }\n';
  writeFileSync(source, body);
  writeFileSync(join(dir, 'docker'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$RELOAD_TEST_DIR/commands"
cat > "$RELOAD_TEST_DIR/$5"
if [ "$5" = validate ]; then
  printf 'concurrent edit' > "$RELOAD_TEST_SOURCE"
  if [ "$RELOAD_TEST_FAIL" = true ]; then exit 1; fi
fi
`, { mode: 0o700 });
  try {
    const result = spawnSync('/bin/sh', [resolve('scripts/reload-inference-proxy.sh'), 'test-caddy', source], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RELOAD_TEST_DIR: dir, RELOAD_TEST_SOURCE: source, RELOAD_TEST_FAIL: String(fail) },
      encoding: 'utf8',
    });
    const commands = readFileSync(join(dir, 'commands'), 'utf8').trim().split('\n');
    expect(commands[0]).toBe('exec -i test-caddy caddy validate --config - --adapter caddyfile');
    expect(readFileSync(join(dir, 'validate'), 'utf8')).toBe(body);
    if (fail) {
      expect(result.status).toBe(1);
      expect(commands).toHaveLength(1);
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(commands[1]).toBe('exec -i test-caddy caddy reload --config - --adapter caddyfile');
      expect(readFileSync(join(dir, 'reload'), 'utf8')).toBe(body);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
