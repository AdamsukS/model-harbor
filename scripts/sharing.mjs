#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = resolve(process.env.INFERENCE_STATE_DIR || join(homedir(), process.platform === 'darwin'
  ? 'Library/Application Support/ModelHarbor/inference' : '.local/share/modelharbor/inference'));
const configFile = join(state, 'sharing.local.json');
const registryFile = join(state, 'keys.json');
const command = process.argv[2] || 'help';
if (/[\r\n"\\]/.test(state)) throw new Error('State path cannot contain line breaks, double quotes, or backslashes.');
const sh = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} failed (${result.status ?? result.error?.message}).`);
}
function privateWrite(path, content) {
  writeFileSync(path + '.tmp', content, { mode: 0o600 });
  chmodSync(path + '.tmp', 0o600);
  renameSync(path + '.tmp', path);
}
const saveJSON = (path, value) => privateWrite(path, JSON.stringify(value, null, 2) + '\n');
const loadKeys = () => JSON.parse(readFileSync(registryFile, 'utf8'));
function addKey(user) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(user || '')) throw new Error('Use a short alphanumeric user name.');
  const keys = loadKeys();
  if (keys.some(key => key.user === user && key.enabled)) throw new Error('User already has an active key; revoke it first.');
  const key = 'sk-mh-' + randomBytes(32).toString('base64url');
  const delivery = join(state, `${user}.key`);
  privateWrite(delivery, key + '\n');
  keys.push({ user, sha256: createHash('sha256').update(key).digest('hex'), enabled: true });
  saveJSON(registryFile, keys);
  console.log(`Key saved to ${delivery}; give only that file to its owner.`);
}
function config() {
  const c = JSON.parse(readFileSync(configFile, 'utf8'));
  for (const name of ['port', 'sshPort', 'remotePort']) {
    if (!Number.isInteger(c[name]) || c[name] < 1024 && name !== 'sshPort' || c[name] < 1 || c[name] > 65535) throw new Error(`Invalid ${name}.`);
  }
  if (typeof c.model !== 'string' || !c.model || !Number.isSafeInteger(c.maxTokens) || c.maxTokens < 1) throw new Error('Invalid model or maxTokens.');
  if (c.timeoutSeconds !== undefined && (!Number.isSafeInteger(c.timeoutSeconds) || c.timeoutSeconds < 60 || c.timeoutSeconds > 86400)) throw new Error('timeoutSeconds must be an integer between 60 and 86400.');
  const upstream = new URL(c.upstream);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/') throw new Error('upstream must be an HTTP origin without credentials.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/.test(c.domain)) throw new Error('Invalid domain.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(c.sshHost) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(c.sshUser) || c.sshUser === 'root') throw new Error('Use a dedicated non-root SSH user.');
  if (isIP(c.remoteBind) !== 4 || !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.remoteBind)) throw new Error('remoteBind must be a loopback or private IPv4 address.');
  if (!/^[a-zA-Z0-9]*$/.test(c.sshInterface)) throw new Error('Invalid interface.');
  return c;
}
function render() {
  const c = config();
  const timeoutSeconds = c.timeoutSeconds ?? 1800;
  const key = join(state, 'tunnel_ed25519');
  if (!existsSync(key)) run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'modelharbor-tunnel', '-f', key]);
  const pub = readFileSync(key + '.pub', 'utf8').trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(pub)) throw new Error('Invalid tunnel public key.');
  const rendered = join(state, 'generated');
  mkdirSync(rendered, { recursive: true, mode: 0o700 });
  const forward = `${c.remoteBind}:${c.remotePort}`;
  privateWrite(join(state, 'ssh.conf'), `Host modelharbor-api-tunnel
    HostName ${c.sshHost}
    Port ${c.sshPort}
    User ${c.sshUser}
    IdentityFile "${key}"
    IdentitiesOnly yes
    BatchMode yes
    StrictHostKeyChecking yes
    ExitOnForwardFailure yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ConnectTimeout 10
    RemoteForward ${forward} 127.0.0.1:${c.port}
${c.sshInterface ? `    ProxyCommand /usr/bin/nc -b ${c.sshInterface} -G 10 %h %p\n` : ''}`);
  const policy = `Match User ${c.sshUser}
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    AllowStreamLocalForwarding no
    GatewayPorts ${c.remoteBind.startsWith('127.') ? 'no' : 'clientspecified'}
    PermitListen ${forward}
    PermitOpen none
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    MaxSessions 0
    ClientAliveInterval 30
    ClientAliveCountMax 3
Match all
`;
  privateWrite(join(rendered, 'sshd.conf'), policy);
  privateWrite(join(rendered, 'server-setup.sh'), `#!/bin/sh
set -eu
test "$(id -u)" = 0 || { echo 'Run on the public Linux server as root.' >&2; exit 1; }
user=${sh(c.sshUser)}
if ! id "$user" >/dev/null 2>&1; then useradd --create-home --shell /usr/sbin/nologin "$user"; fi
test "$(getent passwd "$user" | cut -d: -f6)" = "/home/$user" || { echo 'Unexpected home directory; inspect this account.' >&2; exit 1; }
install -d -m 700 -o "$user" -g "$user" "/home/$user/.ssh"
authorized="/home/$user/.ssh/authorized_keys"
touch "$authorized"
entry=${sh(`restrict,port-forwarding,permitlisten="${forward}" ${pub}`)}
grep -qxF "$entry" "$authorized" || printf '%s\n' "$entry" >> "$authorized"
chown "$user:$user" "$authorized"
chmod 600 "$authorized"
policy=/etc/ssh/sshd_config.d/90-modelharbor-tunnel.conf
backup=$(mktemp)
existed=0
if test -e "$policy"; then cp -p "$policy" "$backup"; existed=1; fi
printf '%s' ${sh(policy)} > "$policy"
if ! /usr/sbin/sshd -t; then
    if test "$existed" = 1; then cat "$backup" > "$policy"; else rm "$policy"; fi
    rm "$backup"
    exit 1
fi
rm "$backup"
systemctl reload ssh
echo 'Restricted tunnel account ready. Add the generated Caddy site separately.'
`);
  privateWrite(join(rendered, 'Caddyfile'), `${c.domain} {
    header {
        -Server
        Cache-Control "no-store"
        X-Content-Type-Options "nosniff"
    }
    @inference path /v1/models /v1/chat/completions
    handle @inference {
        request_body {
            max_size 2MB
        }
        reverse_proxy ${forward} {
            flush_interval 100ms
            transport http {
                dial_timeout 5s
                response_header_timeout ${timeoutSeconds + 10}s
            }
        }
    }
    handle {
        respond "Not found" 404
    }
}
`);
  if (process.platform === 'darwin') {
    for (const [suffix, args] of [['inference', [process.execPath, join(state, 'inference-gateway.js')]],
      ['tunnel', ['/usr/bin/ssh', '-F', join(state, 'ssh.conf'), '-NT', 'modelharbor-api-tunnel']]]) {
      const label = `com.codesoul.modelharbor.${suffix}`;
      privateWrite(join(rendered, label + '.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(state)}</string>
<key>EnvironmentVariables</key><dict><key>INFERENCE_STATE_DIR</key><string>${xml(state)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(state, 'logs', label + '.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, 'logs', label + '.stderr.log'))}</string>
</dict></plist>
`);
    }
  }
  console.log(`Deployment files rendered to ${rendered}. Nothing has been sent to a server.`);
}

try {
  if (command === 'init') {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    chmodSync(state, 0o700);
    mkdirSync(join(state, 'logs'), { recursive: true, mode: 0o700 });
    if (!existsSync(configFile)) privateWrite(configFile, readFileSync(join(root, 'config/sharing.example.json'), 'utf8'));
    if (!existsSync(registryFile)) {
      saveJSON(registryFile, []);
      for (let i = 1; i <= 5; i++) addKey(`collaborator-${i}`);
    }
    console.log(`Edit ${configFile}, then run: pnpm sharing render`);
  } else if (command === 'key-add') addKey(process.argv[3]);
  else if (command === 'key-revoke') {
    const keys = loadKeys();
    if (!keys.some(key => key.user === process.argv[3])) throw new Error('Unknown user.');
    keys.filter(key => key.user === process.argv[3]).forEach(key => { key.enabled = false; });
    saveJSON(registryFile, keys);
    console.log('Key revoked for subsequent requests.');
  } else if (command === 'handoff') {
    const c = config();
    let guide = readFileSync(join(root, 'docs/templates/CLIENT_HANDOFF.md'), 'utf8');
    for (const [name, value] of Object.entries({ BASE_URL: `https://${c.domain}/v1`, MODEL: c.model,
      MAX_TOKENS: c.maxTokens, DEFAULT_TOKENS: Math.min(1024, c.maxTokens),
      REQUEST_TIMEOUT_SECONDS: c.timeoutSeconds ?? 1800, CLIENT_TIMEOUT_SECONDS: (c.timeoutSeconds ?? 1800) + 60 })) {
      guide = guide.replaceAll(`{{${name}}}`, String(value));
    }
    const output = join(state, 'client-guide.local.md');
    privateWrite(output, guide);
    console.log(`Client guide saved to ${output}. Keys are not included; deliver each key separately.`);
  } else if (command === 'render') render();
  else if (command === 'install-macos') {
    if (process.platform !== 'darwin') throw new Error('install-macos requires macOS.');
    config();
    // No implicit build: use the repository's pinned Node/pnpm build first.
    for (const file of ['inference-gateway.js', 'admission-queue.js']) {
      copyFileSync(join(root, 'dist/src', file), join(state, file));
    }
    render();
    const target = join(homedir(), 'Library/LaunchAgents');
    mkdirSync(target, { recursive: true });
    for (const suffix of ['inference', 'tunnel']) {
      const label = `com.codesoul.modelharbor.${suffix}`;
      const destination = join(target, label + '.plist');
      run('plutil', ['-lint', join(state, 'generated', label + '.plist')]);
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
      copyFileSync(join(state, 'generated', label + '.plist'), destination);
      // bootout can return before launchd has finished removing the old job.
      let result;
      for (let attempt = 0; attempt < 40; attempt++) {
        result = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, destination], { encoding: 'utf8' });
        if (result.status === 0) break;
        if (result.status !== 5) break;
        await delay(250);
      }
      if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
    }
  } else if (command === 'status') {
    console.log(`State: ${state}`);
    console.table(loadKeys().map(({ user, enabled }) => ({ user, enabled })));
  } else {
    console.log('Usage: pnpm sharing init | render | install-macos | handoff | key-add USER | key-revoke USER | status');
    console.log('Optional INFERENCE_STATE_DIR overrides the private state directory. See docs/SHARING.md.');
    if (command !== 'help') process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
