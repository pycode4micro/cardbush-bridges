import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge as Weixin } from '../src/adapters/weixin/bridge.mjs';
import { fixture, message, outbound } from './feishu/helpers.mjs';
import { advertisePlugins, withdrawPlugins } from '../src/shared/plugins.mjs';

for (const platform of ['weixin', 'feishu']) test(`${platform} plugin tools validate source, queue once, expose delivery status and reject stale tools`, async t => {
  let bridge;
  if (platform === 'feishu') {
    ({ bridge } = await fixture(t)); await bridge.ingest(message());
  } else {
    const root = await mkdtemp(join(tmpdir(), 'weixin-plugin-'));
    bridge = await new Weixin(root, { port: 4792, callbackToken: 'b'.repeat(64), cardbush: { url: 'http://127.0.0.1:1/api/webhooks/v1/test/messages', token: 'a'.repeat(64) } },
      { id: 'bot', userId: 'owner' }, { send: async () => {}, sendFile: async () => {} }, { log() {} }).load();
    t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
    await bridge.ingest({ msgs: [{ message_type: 1, message_id: '1', from_user_id: 'owner', context_token: 'original', item_list: [{ type: 1, text_item: { text: 'Send file' } }] }] });
  }
  const record = bridge.state.records[0], bytes = Buffer.from('plugin bytes\n');
  const event = { ...outbound(platform === 'feishu' ? record : { id: record.id, senderId: record.sender, conversationId: 'bot:owner' }, bytes),
    type: 'tool.call', pluginId: platform, pluginVersion: '1.0.0', tool: 'send_file', arguments: { file: { part: 'file_0' }, caption: 'Requested file' } };
  const port = await bridge.listen(0);
  const request = async value => {
    const form = new FormData(); form.set('payload', JSON.stringify(value)); form.set('file_0', new Blob([bytes]), 'report.txt');
    return fetch(`http://127.0.0.1:${port}/reply`, { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.config.callbackToken }, body: form });
  };
  assert.equal((await request({ ...event, arguments: { file: 'D:/private.txt' } })).status, 400);
  assert.equal((await request({ ...event, senderId: 'another-user' })).status, 400);
  assert.equal((await request({ ...event, pluginVersion: 'old' })).status, 400);
  assert.equal((await request({ ...event, tool: 'toString' })).status, 400);
  const receipt = await (await request(event)).json();
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.result.deliveryId, event.eventId);
  assert.equal((await request(event)).status, 202); assert.equal(bridge.state.outbound.length, 1);
  const status = { ...event, eventId: 'status-1', tool: 'delivery_status', files: [], arguments: { delivery_id: event.eventId } };
  assert.equal((await bridge.receive(status, [])).result.status, 'queued');
  await assert.rejects(bridge.receive({ ...status, conversationId: 'other-room' }, []), /invalid_tool_arguments/);
  await bridge.sendOutbound();
  assert.equal((await bridge.receive(status, [])).result.status, 'delivered');
  const text = { ...status, eventId: 'text-1', tool: 'send_text', arguments: { text: 'User-requested text' } };
  assert.equal((await bridge.receive(text, [])).result.status, 'queued');
  await bridge.sendOutbound(); assert.equal(bridge.state.outbound.length, 2);
  await bridge.close(); await assert.rejects(bridge.receive(text, []), { name: 'AbortError' });
});

test('plugin handshake publishes declarations, rejects old hosts and withdraws only this process instance', async () => {
  const requests = [], bridge = { abort: new AbortController(), instanceId: 'instance', plugins: [{ manifest: { id: 'arbitrary' } }],
    config: { cardbush: { url: 'http://127.0.0.1:1/api/webhooks/v1/id/messages', token: 'test' } },
    fetch: async (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) }); return Response.json({ protocol: 'cardbush.webhook.v1', status: 'connected', features: ['bridge_plugins'] }); } };
  await advertisePlugins(bridge, { text: true }); assert.equal(bridge.ready, true);
  assert.deepEqual(requests[0].body.plugins, [{ id: 'arbitrary' }]);
  bridge.abort.abort(); await withdrawPlugins(bridge);
  assert.equal(bridge.ready, false); assert.equal(requests[1].method, 'DELETE'); assert.equal(requests[1].body.instanceId, 'instance');
  bridge.abort = new AbortController(); bridge.fetch = async () => Response.json({ status: 'connected' });
  await assert.rejects(advertisePlugins(bridge, {}), /cardbush_plugins_upgrade_required/); assert.equal(bridge.ready, false);
});
