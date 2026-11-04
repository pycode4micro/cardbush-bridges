import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.mjs';
import { bridges } from '../src/registry.mjs';

test('all starts configured adapters concurrently, isolates one failure, and the registry can add another platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-bridge-launcher-'));
  const env = process.env.CARDBUSH_BRIDGES_DATA, exitCode = process.exitCode, log = console.log, errorLog = console.error;
  const loads = bridges.map(b => b.load), starts = [], notices = []; let release;
  process.env.CARDBUSH_BRIDGES_DATA = root; console.log = text => notices.push(text); console.error = text => notices.push(text);
  try {
    for (const bridge of bridges) {
      const directory = join(root, bridge.id); await mkdir(directory);
      await writeFile(join(directory, 'config.json'), JSON.stringify({ cardbush: { url: 'fixture', token: 'fixture' }, feishu: { appId: 'fixture', appSecret: 'fixture' } }));
      await writeFile(join(directory, 'account.json'), '{"token":"fixture"}');
      bridge.load = async () => ({ main: async (command, options) => {
        starts.push({ platform: bridge.id, command, ...options });
        if (bridge.id === 'weixin') throw Error('fixture_adapter_failed');
        await new Promise(r => { release = r; });
      } });
    }
    let finished = false; const running = main(['start', 'all']).then(() => { finished = true; });
    for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(starts.length, 2); assert.equal(finished, false);
    assert.ok(starts.every(s => s.interactive === false && s.root === join(root, s.platform)));
    assert.ok(notices.includes('操作未完成：fixture_adapter_failed'));
    release(); await running;
    bridges.push({ id: 'example', name: '示例', port: 4794, commands: ['start'], configured: () => false,
      load: async () => ({ main: async (command, options) => starts.push({ platform: 'example', command, ...options }) }) });
    await main(['start', 'example']); assert.equal(starts.at(-1).root, join(root, 'example'));
    await assert.rejects(main(['connect', 'example']), /unsupported_command/);
  } finally {
    release?.(); bridges.splice(loads.length); bridges.forEach((b, i) => { b.load = loads[i]; });
    console.log = log; console.error = errorLog; process.exitCode = exitCode;
    if (env === undefined) delete process.env.CARDBUSH_BRIDGES_DATA; else process.env.CARDBUSH_BRIDGES_DATA = env;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true });
  }
});
