import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createDecipheriv } from 'node:crypto';
import { Bridge } from '../../src/adapters/weixin/bridge.mjs';
import { digest } from '../../src/shared/bot-outbound.mjs';
import { WeixinApi } from '../../src/adapters/weixin/weixin.mjs';

test('independent Weixin file transport encrypts bytes, omits API credentials from CDN and uses the original reply context', async () => {
  const requests = [], bytes = Buffer.from('真实附件\n'); let key;
  const api = new WeixinApi({ token: 'api-secret' }, async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/getuploadurl')) {
      const body = JSON.parse(options.body); key = Buffer.from(body.aeskey, 'hex');
      assert.equal(body.media_type, 3); assert.equal(body.rawfilemd5, createHash('md5').update(bytes).digest('hex'));
      assert.equal(body.rawsize, bytes.length);
      return Response.json({ upload_param: 'cdn-upload-parameter' });
    }
    if (String(url).includes('/c2c/upload?')) {
      assert.equal(options.headers.Authorization, undefined); assert.equal(options.redirect, 'error');
      const decrypt = createDecipheriv('aes-128-ecb', key, null);
      assert.deepEqual(Buffer.concat([decrypt.update(options.body), decrypt.final()]), bytes);
      return new Response('', { headers: { 'x-encrypted-param': 'download-param' } });
    }
    const msg = JSON.parse(options.body).msg;
    assert.equal(msg.to_user_id, 'correct-user'); assert.equal(msg.context_token, 'original-context'); assert.equal(msg.client_id, 'stable-client-id');
    assert.equal(msg.item_list[0].type, 4); assert.equal(msg.item_list[0].file_item.file_name, '附件.txt');
    assert.equal(Buffer.from(msg.item_list[0].file_item.media.aes_key, 'base64').toString(), key.toString('hex'));
    return Response.json({ ret: 0 });
  });
  await api.sendFile('correct-user', 'original-context', { name: '附件.txt', bytes }, 'stable-client-id'); assert.equal(requests.length, 3);
  const foreign = new WeixinApi({ token: 'secret' }, async () => Response.json({ upload_full_url: 'https://attacker.example/upload' }));
  await assert.rejects(foreign.sendFile('user', 'context', { name: 'test', bytes }, 'id'), /untrusted_upload_host/);
});

test('generic multipart callback is verified and durably queued; duplicate/restart retries keep the original sender and file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-files-')), sends = [], bytes = Buffer.from('file payload'); let bridge;
  const config = { cardbush: { url: 'http://127.0.0.1:4791/api/webhooks/v1/test/messages', token: 'a'.repeat(64) }, callbackToken: 'b'.repeat(64), port: 4792 };
  const account = { id: 'bot', userId: 'owner', token: 'secret' };
  let fail = true;
  const api = { sendFile: async (...args) => { sends.push(args); if (fail) { fail = false; throw Error('retry'); } } };
  try {
    bridge = await new Bridge(root, config, account, api, { log() {} }).load();
    await bridge.ingest({ msgs: [{ message_type: 1, message_id: '1', from_user_id: 'owner', context_token: 'original-context', item_list: [{ type: 1, text_item: { text: 'Send file.' } }] }] });
    const record = bridge.state.records[0];
    await bridge.write(state => { state.records[0].accepted = true; state.records[0].terminal = true; });
    const event = { protocol: 'cardbush.webhook.v1', type: 'message.send', eventId: 'fixed-event', messageId: record.id,
      senderId: 'owner', conversationId: 'bot:owner', text: '', files: [{ part: 'file_0', name: '附件.txt', mimeType: 'text/plain', size: bytes.length, sha256: digest(bytes) }] };
    const port = await bridge.listen(0);
    const send = async payload => {
      const body = new FormData(); body.set('payload', JSON.stringify(payload)); body.set('file_0', new Blob([bytes]), '附件.txt');
      return fetch(`http://127.0.0.1:${port}/reply`, { method: 'POST', headers: { Authorization: 'Bearer ' + config.callbackToken }, body });
    };
    assert.equal((await send({ ...event, senderId: 'other-user' })).status, 400);
    assert.equal((await send({ ...event, files: [{ ...event.files[0], sha256: '0'.repeat(64) }] })).status, 400);
    const accepted = await (await send(event)).json(); assert.equal(accepted.status, 'accepted'); assert.equal(accepted.eventId, 'fixed-event');
    await send(event); assert.equal(bridge.state.outbound.length, 1);
    assert.deepEqual(await readFile(bridge.outboundFile(event.eventId, 0)), bytes);
    await bridge.processOnce(); assert.equal(sends.length, 1); await bridge.close();
    bridge = await new Bridge(root, config, account, api, { log() {}, now: () => Date.now() + 1001 }).load(); await bridge.processOnce();
    assert.equal(sends.length, 2); assert.equal(sends[0][3], sends[1][3]); assert.equal(sends[1][0], 'owner'); assert.equal(sends[1][1], 'original-context');
    assert.deepEqual(sends[1][2].bytes, bytes); assert.equal(bridge.state.outbound[0].done, true);
    await bridge.receive(event, [bytes]); await bridge.processOnce(); assert.equal(sends.length, 2);
    await assert.rejects(readFile(bridge.outboundFile(event.eventId, 0)), /ENOENT/);
  } finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});
