import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage } from '../../src/adapters/feishu/events.mjs';
import { Bridge } from '../../src/adapters/feishu/bridge.mjs';
import { fixture, message } from './helpers.mjs';

test('normalizes real v2 events, rich text and explicit group mentions; ignores bots and malformed data', () => {
  const event = message(); assert.equal(normalizeMessage({ event }, 'ou_bot').text, '你好');
  const rich = message('om_post', '', 'ou_owner', 'oc_origin', { message_type: 'post', content: JSON.stringify({ title: '标题', content: [[{ tag: 'text', text: '阅读 ' }, { tag: 'a', text: '资料', href: 'https://example.com' }]] }) });
  assert.equal(normalizeMessage(rich, 'ou_bot').text, '标题\n阅读 资料 (https://example.com)');
  const group = message('om_group', '@_user_1 问题', 'ou_owner', 'oc_group', { chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] });
  assert.equal(normalizeMessage(group, 'ou_bot'), undefined);
  assert.equal(normalizeMessage(group, 'ou_bot', ['oc_group']).text, '问题');
  group.message.mentions = []; assert.equal(normalizeMessage(group, 'ou_bot', ['oc_group']), undefined);
  event.sender.sender_type = 'app'; assert.equal(normalizeMessage(event, 'ou_bot'), undefined);
  assert.equal(normalizeMessage(message('om_bot', 'loop', 'ou_bot'), 'ou_bot'), undefined);
  for (const content of ['null', '{}', '{', '{"content": "wrong"}']) {
    assert.doesNotThrow(() => normalizeMessage(message('bad', '', 'ou_owner', 'oc_origin', { message_type: 'post', content }), 'ou_bot'));
  }
  assert.equal(normalizeMessage(null, 'ou_bot'), undefined);
});

test('first-user pairing is private, expiring, persistent; strangers and replayed events cannot hijack it', async t => {
  let now = 1000;
  const { bridge, root, api } = await fixture(t, { config: { allowedSenders: [] }, options: { now: () => now } });
  const code = bridge.pairingCode(); assert.match(code, /^\d{8}$/);
  assert.deepEqual(await bridge.ingest(message('unknown')), { ignored: true });
  assert.deepEqual(await bridge.ingest(message('group', '连接 ' + code, 'ou_owner', 'oc_group', { chat_type: 'group' })), { ignored: true });
  now += 600001; assert.deepEqual(await bridge.ingest(message('expired', '连接 ' + code)), { ignored: true });
  const current = bridge.pairingCode();
  assert.equal((await bridge.ingest(message('pair', '连接 ' + current))).paired, true);
  assert.equal(bridge.state.owner, 'ou_owner'); assert.equal(bridge.state.records[0].text, '');
  assert.equal((await bridge.ingest(message('pair', '连接 ' + current))).duplicate, true);
  assert.deepEqual(await bridge.ingest(message('foreign', '连接 ' + current, 'ou_stranger')), { ignored: true });
  await bridge.processOnce(); await bridge.close();
  const restarted = await new Bridge(root, bridge.config, api).load();
  t.after(() => restarted.close()); assert.equal(restarted.pairingCode(), undefined); assert.equal(restarted.state.owner, 'ou_owner');
  assert.equal((await restarted.ingest(message('next', '继续'))).accepted, true);
});

test('media receives an honest local notice and never fabricates text for the model', async t => {
  const { bridge, sent } = await fixture(t);
  await bridge.ingest(message('image', '', 'ou_owner', 'oc_origin', { message_type: 'image', content: '{"image_key":"fixture"}' }));
  await bridge.processOnce(); assert.equal(sent.length, 1); assert.match(sent[0][2], /暂不自动读取/);
  assert.equal(bridge.state.records[0].terminal, true);
});
