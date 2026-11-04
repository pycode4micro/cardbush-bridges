import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseInvocation } from '../src/arguments.mjs';

const exec = promisify(execFile), entry = resolve('bin/cardbush-bridge.mjs');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-bridge-cli-')), data = join(root, 'data');
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  return { data, async run(args, executable = entry) {
    try { return { ...await exec(process.execPath, [executable, ...args], { cwd: root, windowsHide: true, timeout: 10000,
      env: { ...process.env, CARDBUSH_BRIDGES_DATA: data, CARDBUSH_WEIXIN_DATA: '', CARDBUSH_FEISHU_DATA: '' } }), code: 0 }; }
    catch (error) { if (typeof error.code !== 'number') throw error; return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  } };
}

test('public CLI help/version work from any directory without credentials or creating a profile', async t => {
  const f = await fixture(t), { version } = JSON.parse(await readFile('package.json'));
  for (const args of [[], ['--help'], ['-h'], ['help'], ['start', '--help'], ['help', 'start'], ['start', 'feishu', '-h']]) {
    const result = await f.run(args); assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    assert.match(result.stdout, /Usage: cardbush-bridge/); assert.match(result.stdout, /--all/);
    assert.doesNotMatch(result.stdout, /选择平台：|npm start/);
  }
  for (const flag of ['--version', '-v']) assert.deepEqual(await f.run([flag]), { stdout: version + '\n', stderr: '', code: 0 });
  assert.equal((await f.run(['--version'], resolve('bin/cardbush-bridges.mjs'))).stdout.trim(), version, 'plural alias stays compatible');
  await assert.rejects(access(f.data), { code: 'ENOENT' });
});

test('invalid CLI usage fails on stderr with exit 2 before prompting or changing configuration', async t => {
  const f = await fixture(t);
  for (const args of [['bogus'], ['--feishu'], ['start', '--feishu'], ['start', 'bogus'], ['start', 'feishu', 'extra'],
    ['status', 'feishu', 'extra'], ['status', '--all'], ['connect', '--all'], ['start', 'feishu', '--all'], ['start', '--json'],
    ['doctor', 'weixin'], ['start', '--no-interactive'], ['--version', 'start'], ['login-check', 'weixin', '123', '456']]) {
    const result = await f.run(args); assert.equal(result.code, 2, JSON.stringify({ args, ...result }));
    assert.equal(result.stdout, ''); assert.match(result.stderr, /cardbush-bridge: error:/); assert.match(result.stderr, /--help/);
    assert.doesNotMatch(result.stderr, /Error:|at file:|选择平台：/);
  }
  await assert.rejects(access(f.data), { code: 'ENOENT' });
});

test('status can select one platform or emit JSON and never creates or migrates private data', async t => {
  const f = await fixture(t);
  const result = await f.run(['status', 'feishu', '--json']);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { bridges: [{ platform: 'feishu', configured: false, running: false, port: 4793 }] });
  const all = await f.run(['status', '--json']); assert.deepEqual(JSON.parse(all.stdout).bridges.map(b => b.platform), ['weixin', 'feishu']);
  const one = await f.run(['status', 'weixin']); assert.match(one.stdout, /微信/); assert.doesNotMatch(one.stdout, /飞书/);
  await assert.rejects(access(f.data), { code: 'ENOENT' });
});

test('old npm arguments remain compatible and -- terminates option parsing', () => {
  assert.deepEqual(parseInvocation(['start', 'all']), parseInvocation(['start', '--all']));
  assert.equal(parseInvocation(['connect', 'feishu']).platform, 'feishu');
  assert.deepEqual(parseInvocation(['login-check', 'weixin', '--', '123456']).args, ['123456']);
});
