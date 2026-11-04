import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuApi, MAX_FILE_BYTES } from '../../src/adapters/feishu/feishu.mjs';
import { configure } from '../../src/adapters/feishu/config.mjs';
import { splitText, safeError } from '../../src/adapters/feishu/bridge.mjs';
import { app } from './helpers.mjs';

test('credentials are collected once with a hidden secret prompt; saved/env values need no prompts', async () => {
  const prompts = [];
  assert.deepEqual(await configure(undefined, { env: {}, ask: async (text, secret) => { prompts.push({ text, secret }); return secret ? app.appSecret : app.appId; } }), app);
  assert.equal(prompts.length, 2); assert.equal(prompts[1].secret, true);
  assert.deepEqual(await configure(app, { env: {}, ask: () => assert.fail() }), app);
  assert.deepEqual(await configure(undefined, { env: { FEISHU_APP_ID: app.appId, FEISHU_APP_SECRET: app.appSecret }, ask: () => assert.fail() }), app);
  await assert.rejects(configure({ appId: 'not-an-app', appSecret: app.appSecret }, { env: {} }), /invalid_app_id/);
});

test('Feishu token single-flight and refresh, authenticated text/file send, binary upload and platform receipts', async () => {
  let tokens = 0, expireOnce = true; const sends = [], uploads = [], bytes = Buffer.from([0, 1, 10, 13, 255]);
  const api = new FeishuApi(app, async (url, options) => {
    assert.ok(url.startsWith('https://open.feishu.cn/open-apis/')); assert.equal(options.redirect, 'error');
    if (url.endsWith('/tenant_access_token/internal')) {
      tokens++; assert.deepEqual(JSON.parse(options.body), { app_id: app.appId, app_secret: app.appSecret });
      return Response.json({ code: 0, tenant_access_token: 'fixture-token-' + tokens, expire: 7200 });
    }
    assert.equal(options.headers.Authorization, 'Bearer fixture-token-' + tokens);
    if (url.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot' } });
    if (url.endsWith('/im/v1/files')) {
      assert.ok(options.body instanceof FormData); assert.equal(options.headers['Content-Type'], undefined);
      assert.equal(options.body.get('file_type'), 'stream'); assert.equal(options.body.get('file_name'), '文件.bin');
      assert.equal(options.body.get('file').name, '文件.bin');
      const actual = Buffer.from(await options.body.get('file').arrayBuffer()); assert.deepEqual(actual, bytes); uploads.push(actual);
      return Response.json({ code: 0, data: { file_key: 'fixture-file-key' } });
    }
    assert.ok(url.endsWith('/im/v1/messages?receive_id_type=chat_id'));
    if (expireOnce) { expireOnce = false; return Response.json({ code: 99991663, msg: 'private request data' }); }
    sends.push(JSON.parse(options.body)); return Response.json({ code: 0, data: { message_id: 'om_sent' } });
  });
  await Promise.all([api.identity(), api.identity()]); assert.equal(tokens, 1);
  assert.equal(await api.text('oc_origin', '中文 "\n🙂', 'uuid-text'), 'om_sent'); assert.equal(tokens, 2);
  assert.equal(await api.upload({ name: '文件.bin', mimeType: 'application/octet-stream', bytes }), 'fixture-file-key');
  await api.file('oc_origin', 'fixture-file-key', 'uuid-file');
  assert.equal(sends[0].receive_id, 'oc_origin'); assert.deepEqual(JSON.parse(sends[0].content), { text: '中文 "\n🙂' });
  assert.equal(sends[1].msg_type, 'file'); assert.equal(sends[1].uuid, 'uuid-file'); assert.deepEqual(JSON.parse(sends[1].content), { file_key: 'fixture-file-key' });
  assert.equal(uploads.length, 1);
});

test('invalid/empty files and unsafe destinations are rejected before network; API errors never include secrets', async () => {
  const api = new FeishuApi(app, async () => assert.fail('no network'));
  await assert.rejects(api.upload({ bytes: Buffer.alloc(0) }), /invalid_file_size/);
  await assert.rejects(api.upload({ bytes: Buffer.alloc(MAX_FILE_BYTES + 1) }), /invalid_file_size/);
  await assert.rejects(api.text('https://attacker.invalid', 'text', 'id'), /invalid_chat_id/);
  const failed = new FeishuApi(app, async () => Response.json({ code: 999, msg: app.appSecret }));
  await assert.rejects(failed.identity(), { message: 'feishu_error_999' });
  assert.equal(safeError(new Error('request with secret: ' + app.appSecret)), 'connection_failed');
});

test('text splitting preserves Unicode and bounds escaped JSON bytes', () => {
  const text = ('中文🙂\n\t"\\' + String.fromCharCode(1)).repeat(5000), parts = splitText(text);
  assert.equal(parts.join(''), text); assert.ok(parts.length > 1);
  assert.ok(parts.every(part => Buffer.byteLength(JSON.stringify(part)) - 2 <= 12000));
  assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/.test(part)));
});
