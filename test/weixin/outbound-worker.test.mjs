import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../../src/adapters/weixin/bridge.mjs';
import { digest } from '../../src/shared/bot-outbound.mjs';
import { deliverySnapshot, deliveryReceipt } from '../../src/shared/outbound-worker.mjs';
import { WeixinApi } from '../../src/adapters/weixin/weixin.mjs';
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async fn => { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('condition timed out'); };
async function fixture(t, api, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'weixin-outbound-'));
  const bridge = await new Bridge(root, { port: 4792, callbackToken: 'b'.repeat(64),
    cardbush: { url: 'http://127.0.0.1:1/api/webhooks/v1/test/messages', token: 'a'.repeat(64) } },
    { id: 'bot', userId: 'owner' }, api, { log() {}, ...options }).load();
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  await bridge.ingest({ msgs: [{ message_type: 1, message_id: '1', from_user_id: 'owner', context_token: 'private-context', item_list: [{ type: 1, text_item: { text: 'Send image' } }] }] });
  const bytes = Buffer.from('89504e470d0a1a0a','hex');
  const enqueue = () => bridge.receiveSend({ protocol: 'cardbush.webhook.v1', type: 'message.send', eventId: '11111111-1111-4111-8111-111111111111',
    messageId: bridge.state.records[0].id, sourceRef: 'webhook:test', senderId: 'owner', conversationId: 'bot:owner', text: 'caption',
    files: [{ part: 'file_0', name: 'image.png', mimeType: 'image/png', size: bytes.length, sha256: digest(bytes) }] }, [bytes], 'image');
  return { bridge, enqueue, state: () => bridge.state.outbound[0] };
}
test('new image wakes an idle sender while an unrelated reply query stays blocked', async t => {
  const blocked = gate(), sent = [];
  const f = await fixture(t, { send: async () => sent.push('caption'), sendImage: async () => sent.push('image') });
  f.bridge.cardbush = async () => { await blocked.promise; return {}; }; f.bridge.receive = async () => {};
  const work = f.bridge.processOnce(), outgoing = f.bridge.outbound.run();
  try {
    await f.enqueue(); await until(() => f.state()?.done);
    assert.deepEqual(sent, ['caption', 'image']);
    assert.equal(f.state().attempts, 1);
  } finally { blocked.resolve(); f.bridge.abort.abort(); await Promise.all([work, outgoing]); }
});
test('concurrent drains cannot resend; status exposes upload phase and transport retry with a deadline', async t => {
  const uploading = gate(); let attempts = 0, now = 100, sent = 0;
  const f = await fixture(t, { send: async () => {}, prepareMedia: async () => { attempts++; await uploading.promise; throw Error('file_upload_failed'); }, sendPrepared: async () => { sent++; } }, { now: () => now });
  await f.enqueue(); const first = f.bridge.sendOutbound();
  await until(() => f.state().status === 'uploading');
  assert.equal(f.bridge.sendOutbound(), first);
  assert.equal(deliverySnapshot(f.state()).phase, 'uploading');
  now += 50; uploading.resolve(); await first;
  const failed = deliverySnapshot(f.state());
  assert.equal(failed.status, 'retrying'); assert.equal(failed.lastError.code, 'file_upload_failed'); assert.equal(failed.timings.uploadMs, 50);
  await f.bridge.sendOutbound(); assert.equal(attempts, 1, 'no retry before its deadline');
  now = failed.nextAttemptAt;
  f.bridge.api.prepareMedia = async () => { attempts++; return { type: 2, privateKey: 'must-not-leak' }; };
  await f.bridge.sendOutbound();
  assert.equal(sent, 1); assert.equal(attempts, 2); assert.equal(f.state().status, 'delivered');
  assert.equal(JSON.stringify(deliverySnapshot(f.state())).includes('must-not-leak'), false);
});
test('permanent transport failures terminate and completion notification retries retain identical facts', async t => {
  let now = 100, calls = 0, failAck = true; const notifications = [];
  const f = await fixture(t, { send: async () => {}, prepareMedia: async () => { calls++; throw Error('media_type_mismatch'); }, sendPrepared: async () => {} },
    { now: () => now, fetcher: async (_, options) => { const body = JSON.parse(options.body); notifications.push(body);
      if (failAck) throw Error('connection_failed'); return Response.json({ eventId: body.eventId, status: 'accepted' }); } });
  await f.enqueue(); await f.bridge.sendOutbound(); await f.bridge.sendOutbound();
  assert.equal(calls, 1); assert.equal(f.state().status, 'failed');
  f.bridge.deliveryEvents = true;
  await f.bridge.outbound.notify(); assert.equal(f.state().notified, undefined);
  now += 5000; failAck = false; await f.bridge.outbound.notify(); await f.bridge.outbound.notify();
  assert.deepEqual(notifications[0], notifications[1]); assert.equal(notifications.length, 2); assert.equal(f.state().notified, true);
  assert.equal(JSON.stringify(notifications).includes('private-context'), false);
});
test('shutdown during upload does not dispatch a subsequent platform send', async t => {
  const uploading = gate(); let sends = 0;
  const f = await fixture(t, { send: async () => {}, prepareMedia: async () => { await uploading.promise; return { type: 2 }; }, sendPrepared: async () => { sends++; } });
  await f.enqueue(); const pending = f.bridge.sendOutbound(); await until(() => f.state().phase === 'uploading');
  f.bridge.abort.abort(); uploading.resolve(); await pending;
  assert.equal(sends, 0); assert.equal(f.state().done, false); assert.ok(f.state().files[0].uploaded);
});

test('platform rejection retains sending phase and redacted diagnostic facts; successful retry needs no model query', async t => {
  let now = 100, fail = true, uploads = 0, notifications = 0;
  const account = { token: 'account-secret' };
  const api = new WeixinApi(account, async () => fail ? Response.json({ ret: -2, errcode: -2,
    errmsg: 'send rejected account-secret private-context https://host/upload?key=hidden\n' + 'x'.repeat(800) }) : Response.json({ ret: 0 }));
  api.prepareMedia = async () => { uploads++; return { type: 2 }; };
  const f = await fixture(t, api, { now: () => now, fetcher: async (_url, options) => {
    notifications++; const event = JSON.parse(options.body);
    assert.equal(event.result.lastError.details.operation, 'sendmessage');
    return Response.json({ eventId: event.eventId, status: 'accepted' });
  } });
  await f.enqueue(); f.bridge.deliveryEvents = true;
  assert.equal(deliveryReceipt(f.bridge, f.state()).completion.mode, 'event');
  await f.bridge.sendOutbound();
  const error = deliverySnapshot(f.state()).lastError;
  assert.equal(error.phase, 'sending_text'); assert.equal(error.code, 'weixin_error_-2');
  assert.equal(error.details.httpStatus, 200); assert.equal(error.details.ret, -2);
  assert.ok(error.details.message.length <= 512);
  assert.doesNotMatch(JSON.stringify(error), /account-secret|private-context|host\/upload|key=hidden/);
  assert.equal(uploads, 0, 'a caption rejection is not an upload failure');
  now = f.state().nextAttemptAt; fail = false;
  await f.bridge.sendOutbound(); await f.bridge.outbound.notify();
  assert.equal(f.state().status, 'delivered'); assert.equal(uploads, 1); assert.equal(notifications, 1);
  assert.equal(deliveryReceipt({ deliveryEvents: false }, f.state()).completion.mode, 'query');
  assert.equal(deliveryReceipt({ deliveryEvents: true }, f.state()).completion.mode, 'query', 'an adapter without a completion worker cannot promise events');
});
