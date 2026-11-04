import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from '../../src/adapters/feishu/bridge.mjs';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../../src/adapters/feishu/feishu.mjs';
import { fixture, message, outbound } from './helpers.mjs';

test('real multipart callback requires auth, original destination, unchanged bytes and durable idempotent acknowledgement', async t => {
  const { bridge, root } = await fixture(t); await bridge.ingest(message());
  const bytes = Buffer.from([0, 13, 10, 255]), event = outbound(bridge.state.records[0], bytes);
  const port = await bridge.listen(0), url = `http://127.0.0.1:${port}/reply`;
  const request = (value = event, options = {}) => {
    const body = new FormData(); body.set('payload', JSON.stringify(value)); body.set('file_0', new Blob([bytes]), '测试附件.txt');
    return fetch(url, { method: 'POST', body, headers: { Authorization: 'Bearer ' + bridge.config.callbackToken, ...options } });
  };
  assert.equal((await request(event, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request(event, { Origin: 'http://website.invalid' })).status, 404);
  assert.equal((await request({ ...event, conversationId: 'oc_elsewhere' })).status, 400);
  assert.equal((await request({ ...event, files: [{ ...event.files[0], sha256: '0'.repeat(64) }] })).status, 400);
  const response = await request(); assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { protocol: event.protocol, eventId: event.eventId, status: 'accepted' });
  const stored = JSON.parse(await readFile(join(root, 'queue.json'), 'utf8')); assert.equal(stored.outbound.length, 1);
  assert.deepEqual(await readFile(bridge.outboundFile(event.eventId, 0)), bytes);
  assert.equal((await request()).status, 202); assert.equal(bridge.state.outbound.length, 1);
  assert.equal((await request({ ...event, text: 'changed' })).status, 400);
  await assert.rejects(bridge.receiveSend({ ...event, eventId: 'empty', files: [{ ...event.files[0], size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }] }, [Buffer.alloc(0)]), /file_size_unsupported/);
});

test('uploaded file key and stable send UUID survive failure/restart without uploading twice or changing recipient', async t => {
  let uploads = 0, fail = true; const attempts = [], bytes = Buffer.from('完整字节\n');
  const { bridge, root, api } = await fixture(t, { api: {
    upload: async file => { uploads++; assert.deepEqual(file.bytes, bytes); return 'stored-key'; },
    file: async (...args) => { attempts.push(args); if (fail) throw Error('feishu_http_503'); },
  } });
  await bridge.ingest(message()); const event = outbound(bridge.state.records[0], bytes); await bridge.receiveSend(event, [bytes]);
  await bridge.sendOutbound(); assert.equal(uploads, 1); assert.equal(bridge.state.outbound[0].done, false);
  await bridge.close(); fail = false;
  const restarted = await new Bridge(root, bridge.config, api, { log() {} }).load(); t.after(() => restarted.close());
  await restarted.sendOutbound(); assert.equal(uploads, 1); assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].slice(0, 3), attempts[1].slice(0, 3)); assert.equal(attempts[1][0], 'oc_origin'); assert.equal(attempts[1][1], 'stored-key');
  assert.match(attempts[1][2], /^[a-f0-9]{32}$/); assert.equal(restarted.state.outbound[0].done, true);
  await assert.rejects(access(restarted.outboundFile(event.eventId, 0)), { code: 'ENOENT' });
  await restarted.receiveSend(event, [bytes]); await restarted.sendOutbound(); assert.equal(attempts.length, 2);
});

test('capabilities register before forwarding, concurrent workers deduplicate and callback/poll races send once', async t => {
  const calls = []; let receipt;
  const { bridge, sent } = await fixture(t, { options: { fetcher: async (url, options) => {
    calls.push(url);
    if (url.endsWith('/capabilities')) {
      assert.deepEqual(JSON.parse(options.body).capabilities, { text: true, files: true, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
      return Response.json({ protocol: 'cardbush.webhook.v1', status: 'connected', features: ['bridge_plugins'] });
    }
    return Response.json(receipt);
  } } });
  await bridge.ingest(message()); const r = bridge.state.records[0];
  receipt = { protocol: 'cardbush.webhook.v1', type: 'message.completed', messageId: r.id, senderId: r.senderId, conversationId: r.conversationId,
    sequence: 3, status: 'completed', reply: '处理完成' };
  await bridge.processOnce(); assert.equal(calls.length, 0);
  await bridge.advertise(); const a = bridge.processOnce(), b = bridge.processOnce(); assert.equal(a, b); await Promise.all([a, b]);
  assert.equal(sent.length, 1); assert.equal(sent[0][1], 'oc_origin'); assert.equal(sent[0][2], '处理完成');
  await bridge.receive(receipt); await bridge.processOnce(); assert.equal(sent.length, 1);
  await assert.rejects(bridge.receive({ ...receipt, sequence: 4, senderId: 'ou_foreign' }), /unknown_message/);
});
