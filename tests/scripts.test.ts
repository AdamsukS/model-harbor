import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve('.');
const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

async function createRepository(root: string, name: string): Promise<{ path: string; revision: string }> {
  const repository = path.join(root, name);
  await mkdir(repository);
  await execFile('git', ['init', '-q'], { cwd: repository });
  await writeFile(path.join(repository, 'README.md'), `${name}\n`);
  await execFile(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'],
    { cwd: repository }
  );
  await execFile(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'initial'],
    { cwd: repository }
  );
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository });
  return { path: repository, revision: stdout.trim() };
}

async function prepareFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'model-harbor-scripts-'));
  const hypha = await createRepository(root, 'hypha-source');
  const plasmod = await createRepository(root, 'plasmod-source');
  const manifest = path.join(root, 'runtime-sources.json');
  const runtime = path.join(root, 'runtime-sources');
  await writeFile(
    manifest,
    JSON.stringify({
      hypha: { repository: hypha.path, revision: hypha.revision, directory: 'hypha' },
      plasmod: { repository: plasmod.path, revision: plasmod.revision, directory: 'plasmod' },
    })
  );
  return { root, hypha, plasmod, manifest, runtime };
}

function prepareEnvironment(fixture: Awaited<ReturnType<typeof prepareFixture>>) {
  return {
    ...process.env,
    MODEL_HARBOR_SOURCE_MANIFEST: fixture.manifest,
    MODEL_HARBOR_RUNTIME_DIR: fixture.runtime,
    MODEL_HARBOR_SKIP_INSTALLS: '1',
    MODEL_HARBOR_SKIP_MODEL: '1',
  };
}

describe('runtime scripts', () => {
  it('clones both sources at immutable revisions and is idempotent', async () => {
    const fixture = await prepareFixture();
    const script = path.join(projectRoot, 'scripts', 'prepare.sh');

    await execFile('bash', [script], { cwd: projectRoot, env: prepareEnvironment(fixture) });
    await execFile('bash', [script], { cwd: projectRoot, env: prepareEnvironment(fixture) });

    const hyphaHead = await execFile('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(fixture.runtime, 'hypha'),
    });
    const plasmodHead = await execFile('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(fixture.runtime, 'plasmod'),
    });
    expect(hyphaHead.stdout.trim()).toBe(fixture.hypha.revision);
    expect(plasmodHead.stdout.trim()).toBe(fixture.plasmod.revision);
  });

  it('refuses to change a dirty runtime checkout', async () => {
    const fixture = await prepareFixture();
    const script = path.join(projectRoot, 'scripts', 'prepare.sh');
    const environment = prepareEnvironment(fixture);
    await execFile('bash', [script], { cwd: projectRoot, env: environment });
    await writeFile(path.join(fixture.runtime, 'hypha', 'local-change.txt'), 'preserve me\n');

    await expect(execFile('bash', [script], { cwd: projectRoot, env: environment })).rejects.toMatchObject({
      stderr: expect.stringContaining('dirty'),
    });
  });

  it('does not stop a process whose command does not match the PID owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'model-harbor-stop-'));
    const pidDirectory = path.join(root, 'pids');
    await mkdir(pidDirectory, { recursive: true });
    const child = spawn('sleep', ['30']);
    children.push(child);
    if (!child.pid) throw new Error('sleep did not start');
    await writeFile(path.join(pidDirectory, 'model-harbor.pid'), `${child.pid}\n`);

    await execFile('bash', [path.join(projectRoot, 'scripts', 'stop.sh')], {
      cwd: projectRoot,
      env: { ...process.env, MODEL_HARBOR_STATE_DIR: root },
    });

    expect(child.exitCode).toBeNull();
  });
});
