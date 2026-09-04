import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('sharing setup is repeatable, keeps secrets private, validates templates, and supports revocation', () => {
  const state = mkdtempSync(join(tmpdir(), 'modelharbor-sharing-'));
  const cli = (command: string, ...args: string[]) => spawnSync(process.execPath, [resolve('scripts/sharing.mjs'), command, ...args], {
    encoding: 'utf8', env: { ...process.env, INFERENCE_STATE_DIR: state },
  });
  try {
    const initialized = cli('init');
    expect(initialized.status, initialized.stderr).toBe(0);
    const registry = readFileSync(join(state, 'keys.json'), 'utf8');
    expect(JSON.parse(registry)).toHaveLength(5);
    expect(initialized.stdout).not.toContain('sk-mh-');
    expect(registry).not.toContain('sk-mh-');
    expect(statSync(join(state, 'collaborator-1.key')).mode & 0o777).toBe(0o600);
    expect(cli('init').status).toBe(0);
    expect(readFileSync(join(state, 'keys.json'), 'utf8')).toBe(registry);
    expect(cli('key-revoke', 'collaborator-1').status).toBe(0);
    expect(JSON.parse(readFileSync(join(state, 'keys.json'), 'utf8'))[0].enabled).toBe(false);
    expect(cli('key-add', 'collaborator-1').status).toBe(0);
    expect(cli('key-add', 'collaborator-1').status).toBe(1);
    const rendered = cli('render');
    expect(rendered.status, rendered.stderr).toBe(0);
    expect(readFileSync(join(state, 'generated/Caddyfile'), 'utf8')).toContain('api.example.com');
    const serverScript = readFileSync(join(state, 'generated/server-setup.sh'), 'utf8');
    expect(serverScript).not.toMatch(/PRIVATE KEY|sk-mh-/);
    expect(serverScript).toContain('MaxSessions 0');
    expect(serverScript).toContain('PermitListen 127.0.0.1:18788');
    expect(spawnSync('/bin/sh', ['-n', join(state, 'generated/server-setup.sh')]).status).toBe(0);
    expect(spawnSync('ssh', ['-G', '-F', join(state, 'ssh.conf'), 'modelharbor-api-tunnel'], { encoding: 'utf8' }).status).toBe(0);
    if (process.platform === 'darwin') {
      expect(spawnSync('plutil', ['-lint', join(state, 'generated/com.codesoul.modelharbor.inference.plist')]).status).toBe(0);
    }
    const configPath = join(state, 'sharing.local.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.domain = 'inference.example.net';
    config.model = 'another-model';
    config.maxTokens = 512;
    writeFileSync(configPath, JSON.stringify(config));
    const handoff = cli('handoff');
    expect(handoff.status, handoff.stderr).toBe(0);
    const guidePath = join(state, 'client-guide.local.md');
    const guide = readFileSync(guidePath, 'utf8');
    expect(guide).toContain('https://inference.example.net/v1');
    expect(guide).toContain('another-model');
    expect(guide).toContain('默认 `512`');
    expect(guide).not.toMatch(/\{\{|203\.0\.113\.10|modelharbor-tunnel|sk-mh-/);
    expect(statSync(guidePath).mode & 0o777).toBe(0o600);
    expect(handoff.stdout).not.toContain(config.domain);
    expect(guide).not.toContain(readFileSync(join(state, 'collaborator-1.key'), 'utf8').trim());
    config.remoteBind = '0.0.0.0';
    writeFileSync(configPath, JSON.stringify(config));
    expect(cli('render').status).toBe(1);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
