import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { prepareData, configurationState } from '../src/data.mjs';
import { bridges } from '../src/registry.mjs';
import { acquireLock } from '../src/shared/storage.mjs';

test('migration keeps login, binding, queue progress and file bytes without mixing platforms or overwriting data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-bridge-migration-')), dataRoot = join(root, 'new');
  try {
    for (const bridge of bridges) {
      const legacy = join(root, bridge.legacyDirectory, '.private'); await mkdir(join(legacy, 'outbound-files'), { recursive: true });
      await writeFile(join(legacy, 'config.json'), JSON.stringify({ port: bridge.port, cardbush: { url: 'saved', token: 'saved' }, feishu: { appId: 'saved', appSecret: 'saved' } }));
      await writeFile(join(legacy, 'account.json'), JSON.stringify({ token: bridge.id }));
      await writeFile(join(legacy, 'queue.json'), JSON.stringify({ sent: 3, platform: bridge.id }));
      await writeFile(join(legacy, 'outbound-files', 'pending'), Buffer.from([0, 255, 32]));
      const options = { env: {}, dataRoot, legacyRoot: root, log() {} };
      const target = await prepareData(bridge, options);
      assert.equal(JSON.parse(await readFile(join(target, 'account.json'))).token, bridge.id);
      assert.deepEqual(JSON.parse(await readFile(join(target, 'queue.json'))), { sent: 3, platform: bridge.id });
      assert.deepEqual(await readFile(join(target, 'outbound-files', 'pending')), Buffer.from([0, 255, 32]));
      assert.equal((await configurationState(bridge, target)).configured, true);
      await assert.rejects(readFile(join(target, 'service.lock')), { code: 'ENOENT' });
      await writeFile(join(target, 'queue.json'), '{"new":true}');
      await prepareData(bridge, options);
      assert.deepEqual(JSON.parse(await readFile(join(target, 'queue.json'))), { new: true });
      assert.equal(JSON.parse(await readFile(join(legacy, 'queue.json'))).sent, 3, 'legacy queue stays unchanged');
    }
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); }
});

test('migration refuses a running legacy bridge and explicit data roots never import unrelated profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-bridge-locked-')), bridge = bridges[0], legacy = join(root, bridge.legacyDirectory, '.private');
  let release;
  try {
    await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, 'account.json'), '{"token":"private"}'); release = await acquireLock(legacy);
    await assert.rejects(prepareData(bridge, { env: {}, dataRoot: join(root, 'new'), legacyRoot: root }), /legacy_bridge_running/);
    const target = await prepareData(bridge, { env: { CARDBUSH_BRIDGES_DATA: join(root, 'explicit') }, legacyRoot: root });
    await assert.rejects(readFile(join(target, 'account.json')), { code: 'ENOENT' });
  } finally { await release?.(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); }
});
