import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, splitText } from '../../src/adapters/weixin/bridge.mjs';
import { WeixinApi, apiBase } from '../../src/adapters/weixin/weixin.mjs';

const account = { id: 'bot', userId: 'owner', token: 'weixin-token' };
const config = { cardbush: { url: 'http://127.0.0.1:4791/api/webhooks/v1/test/messages', token: 'a'.repeat(64) }, callbackToken: 'b'.repeat(64), port: 4792 };
const update = (extra = {}) => ({ get_updates_buf: 'next', msgs: [{ message_type: 1, message_id: '10000000000000000999', from_user_id: 'owner', context_token: 'context-A', item_list: [{ type: 1, text_item: { text: 'Remember olive.' } }], ...extra }] });
test('Tencent transport uses protocol headers, preserves uint64 IDs, rejects foreign redirects and session expiry', async () => {
  const requests = [];
  const api = new WeixinApi(account, async (url, options) => { requests.push({ url: String(url), ...options }); return new Response('{"msgs":[{"message_id":18446744073709551615}]}'); });
  assert.equal((await api.updates('previous')).msgs[0].message_id, '18446744073709551615');
  assert.equal(requests[0].headers.Authorization, 'Bearer weixin-token'); assert.equal(JSON.parse(requests[0].body).get_updates_buf, 'previous');
  await api.qr(); assert.equal(requests[1].headers.Authorization, undefined); assert.equal(JSON.parse(requests[1].body).base_info, undefined);
  await api.qrStatus('qr', 'https://ilinkai.weixin.qq.com'); assert.equal(requests[2].method, 'GET'); assert.equal(requests[2].headers.AuthorizationType, undefined);
  assert.throws(() => apiBase('https://weixin.qq.com.attacker.test'), /untrusted/);
  await assert.rejects(new WeixinApi(account, async () => new Response('{"errcode":-14}')).updates(''), /login_expired/);
});
test('long-poll inbox -> Webhook -> callback -> Weixin reply; duplicates, unknown senders, restart and chunk retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-bridge-test-')); const posted = [], sent = [];
  let fail = true, bridge;
  const api = { send: async (...args) => { sent.push(args); if (fail) { fail = false; throw Error('send_failed'); } } };
  const fetcher = async (url, options) => { assert.equal(options.method, 'POST'); const body = JSON.parse(options.body); posted.push(body);
    return Response.json({ protocol: 'cardbush.webhook.v1', sequence: 1, ...body, status: 'accepted', reply: '' }); };
  try {
    bridge = await new Bridge(root, config, account, api, { fetcher, log() {} }).load();
    await bridge.ingest(update({ from_user_id: 'stranger' })); assert.equal(bridge.state.records.length, 0);
    await bridge.ingest(update()); await bridge.ingest(update()); assert.equal(bridge.state.records.length, 1); assert.equal(bridge.state.cursor, 'next');
    // Submit without querying yet; mimic a durable callback arriving while forwarding.
    const originalFetch = bridge.fetch; bridge.fetch = async (url, options) => options.method === 'GET'
      ? Response.json({ protocol: 'cardbush.webhook.v1', sequence: 2, messageId: bridge.state.records[0].id, senderId: 'owner', conversationId: 'bot:owner', status: 'running', reply: '' }) : originalFetch(url, options);
    await bridge.processOnce(); assert.equal(posted.length, 1);
    const id = bridge.state.records[0].id;
    const event = { protocol: 'cardbush.webhook.v1', messageId: id, senderId: 'owner', conversationId: 'bot:owner', status: 'completed', sequence: 3, reply: '记住了🙂'.repeat(1200) };
    await assert.rejects(bridge.receive({ ...event, senderId: 'stranger' }), /unknown_message/);
    const port = await bridge.listen(0), endpoint = `http://127.0.0.1:${port}/reply`;
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
    const callback = value => fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + config.callbackToken, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await callback(event)).status, 202); await bridge.processOnce(); assert.equal(sent.length, 1);
    await bridge.close(); bridge = await new Bridge(root, config, account, api, { fetcher, log() {} }).load();
    await bridge.processOnce(); assert.equal(sent[0][3], sent[1][3], 'retry uses stable Weixin client_id');
    assert.ok(sent.every(args => args[0] === 'owner' && args[1] === 'context-A' && Buffer.byteLength(args[2]) <= 3500));
    assert.equal(bridge.state.records[0].deliveredText, event.reply); const count = sent.length;
    await bridge.receive(event); await bridge.processOnce(); assert.equal(sent.length, count, 'duplicate callback is not resent'); assert.equal(posted.length, 1);
    await bridge.receive({ ...event, sequence: 4, reply: event.reply + '\n\n后续任务完成。' }); await bridge.processOnce();
    assert.equal(sent.at(-1)[2], '后续任务完成。', 'Assistant full snapshots only send the new suffix');
    assert.equal(splitText(event.reply).join(''), event.reply);
  } finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});
