import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtemp, rm, rmdir, readFile, writeFile, mkdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeixinApi } from '../../src/adapters/weixin/weixin.mjs';
import { Bridge } from '../../src/adapters/weixin/bridge.mjs';
import { incomingAttachments, downloadMedia, mediaType, MAX_MEDIA_BYTES } from '../../src/adapters/weixin/media.mjs';
import { samples, key, encrypt, mediaItem, config, account, update, toolEvent } from './media-helpers.mjs';

test('CDN failures preserve HTTP/numeric error facts without disclosing headers or upload tickets', async () => {
  for (const [status, code, expected] of [[500, '-5104001', 'weixin_upload_http_500_cdn_-5104001'],
    [403, 'credential-secret', 'weixin_upload_http_403'], [200, '', 'weixin_upload_receipt_missing']]) {
    const api = new WeixinApi(account, async url => String(url).includes('getuploadurl') ? Response.json({ upload_param: 'private-ticket' })
      : new Response(null, { status, headers: { 'x-error-code': code, 'x-error-message': 'private-secret' } }));
    await assert.rejects(api.prepareMedia('owner', { name: 'image.png', bytes: samples.image }, 'image'), error => error.message === expected);
  }
});

for (const kind of ['image', 'video', 'file']) for (const encoding of ['raw', 'hex']) test(`${kind} downloads real bytes with ${encoding} key, bounded CDN transport and no API credentials`, async () => {
  const attachment = incomingAttachments([mediaItem(kind, { encoding, fullUrl: encoding === 'raw' })], 'message').attachments[0];
  const result = await downloadMedia(attachment, async (url, options) => {
    assert.equal(url.hostname, 'novac2c.cdn.weixin.qq.com'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined); return new Response(encrypt(samples[kind]));
  });
  assert.deepEqual(result.bytes, samples[kind]); assert.equal(result.sha256, createHash('sha256').update(samples[kind]).digest('hex'));
});

test('images accept the preferred raw hex key and unencrypted image references', async () => {
  const image = mediaItem('image'); image.image_item.aeskey = key.toString('hex'); image.image_item.media.aes_key = 'invalid';
  const attachment = incomingAttachments([image], 'message').attachments[0];
  assert.deepEqual((await downloadMedia(attachment, async () => new Response(encrypt(samples.image)))).bytes, samples.image);
  const plain = incomingAttachments([mediaItem('image', { plaintext: true })], 'plain').attachments[0];
  assert.deepEqual((await downloadMedia(plain, async () => new Response(samples.image))).bytes, samples.image);
});

test('empty files round trip and ISO image containers are not accepted as MP4 videos', async () => {
  const item = mediaItem('file'); item.file_item.len = '0'; delete item.file_item.md5;
  const attachment = incomingAttachments([item], 'empty').attachments[0];
  assert.equal((await downloadMedia(attachment, async () => new Response(encrypt(Buffer.alloc(0))))).bytes.length, 0);
  assert.equal(mediaType(samples.video).kind, 'video');
  for (const brand of ['avif', 'heic', 'mif1']) {
    const invalid = Buffer.from(samples.video); invalid.write(brand, 8);
    assert.notEqual(mediaType(invalid).kind, 'video');
    const api = new WeixinApi(account, () => assert.fail('must not upload an image container as video'));
    await assert.rejects(api.prepareMedia('owner', { name: 'fake.mp4', bytes: invalid }, 'video'), /media_type_mismatch/);
  }
});

test('download rejects foreign hosts, invalid keys, oversize streams, bad padding, size/hash mismatches and non-image bytes', async () => {
  const original = incomingAttachments([mediaItem('image')], 'message').attachments[0]; let fetched = 0;
  const fetcher = async () => { fetched++; return new Response(encrypt(samples.image)); };
  for (const url of ['http://novac2c.cdn.weixin.qq.com/a', 'https://evil.test/a', 'https://weixin.qq.com.evil.test/a', 'https://u:p@novac2c.cdn.weixin.qq.com/a', 'https://novac2c.cdn.weixin.qq.com:999/a'])
    await assert.rejects(downloadMedia({ ...original, media: { ...original.media, full_url: url } }, fetcher), /untrusted_media_host/);
  await assert.rejects(downloadMedia({ ...original, aeskey: 'bad' }, fetcher), /invalid_media_key/); assert.equal(fetched, 0);
  await assert.rejects(downloadMedia(original, async () => new Response('x', { headers: { 'content-length': String(MAX_MEDIA_BYTES + 17) } })), /media_too_large/);
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); } });
  await assert.rejects(downloadMedia({ ...original, cipherSize: undefined }, async () => new Response(stream)), /media_too_large/);
  await assert.rejects(downloadMedia({ ...original, cipherSize: undefined }, async () => new Response(Buffer.alloc(17))), /media_decryption_failed/);
  await assert.rejects(downloadMedia({ ...original, size: 999 }, fetcher), /media_size_mismatch/);
  await assert.rejects(downloadMedia({ ...original, md5: '0'.repeat(32) }, fetcher), /media_hash_mismatch/);
  await assert.rejects(downloadMedia({ ...original, cipherSize: undefined }, async () => new Response(encrypt(Buffer.from('<html>bad</html>')))), /media_type_mismatch/);
  await assert.rejects(downloadMedia(original, async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } })), /media_http_302/);
});

for (const kind of ['image', 'video', 'file']) test(`${kind} native send reuses persisted upload on retry/restart and keeps the exact source`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-native-')); let bridge, uploads = 0, fail = true, mediaKey;
  const sent = [], api = new WeixinApi(account, async (url, options) => {
    if (String(url).endsWith('/getuploadurl')) {
      uploads++; const body = JSON.parse(options.body); mediaKey = Buffer.from(body.aeskey, 'hex');
      assert.equal(body.media_type, { image: 1, video: 2, file: 3 }[kind]); return Response.json({ upload_param: 'upload' });
    }
    if (String(url).includes('/c2c/upload')) {
      assert.equal(options.headers.Authorization, undefined);
      const decrypt = createDecipheriv('aes-128-ecb', mediaKey, null);
      assert.deepEqual(Buffer.concat([decrypt.update(options.body), decrypt.final()]), samples[kind]);
      return new Response('', { headers: { 'x-encrypted-param': 'uploaded-secret' } });
    }
    const msg = JSON.parse(options.body).msg; sent.push(msg);
    if (fail) { fail = false; return Response.json({ ret: 123 }); } return Response.json({ ret: 0 });
  });
  try {
    bridge = await new Bridge(root, config, account, api, { log() {} }).load(); await bridge.ingest(update([{ type: 1, text_item: { text: 'send' } }]));
    const record = bridge.state.records[0], bytes = samples[kind], event = toolEvent(bridge, record, 'send_' + kind, { file: { part: 'file_0' } });
    event.files = [{ part: 'file_0', name: 'sample.' + { image: 'png', video: 'mp4', file: 'txt' }[kind], mimeType: 'application/octet-stream',
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
    await bridge.receive(event, [bytes]); await bridge.sendOutbound(); assert.equal(uploads, 1); assert.equal(bridge.state.outbound[0].done, false);
    await bridge.close(); bridge = await new Bridge(root, config, account, api, { log() {} }).load();
    bridge.outbound.now = () => Date.now() + 1001;
    await bridge.sendOutbound(); assert.equal(uploads, 1); assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
    assert.equal(sent[1].to_user_id, 'owner'); assert.equal(sent[1].context_token, 'context-1');
    assert.equal(sent[1].item_list[0].type, { image: 2, video: 5, file: 4 }[kind]);
    if (kind !== 'file') assert.equal(sent[1].item_list[0][kind + '_item'][kind === 'image' ? 'mid_size' : 'video_size'], encrypt(bytes).length);
    assert.equal(bridge.state.outbound[0].done, true); await bridge.receive(event, [bytes]); await bridge.sendOutbound(); assert.equal(sent.length, 2);
    const changed = { ...event, tool: kind === 'image' ? 'send_file' : 'send_image' };
    await assert.rejects(bridge.receive(changed, [bytes]), /event_id_conflict|media_type_mismatch/);
  } finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});

test('inbound attachments survive restart, redact secrets, isolate senders, paginate and detect changed cached files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-inbound-')); let bridge, downloads = 0;
  const api = new WeixinApi(account, async url => { downloads++; const kind = String(url).match(/sample-(image|video|file)/)[1]; return new Response(encrypt(samples[kind])); });
  const settings = { ...config, allowedSenders: ['owner', 'other'] };
  try {
    bridge = await new Bridge(root, settings, account, api, { log() {} }).load();
    await bridge.ingest(update([mediaItem('image'), mediaItem('video'), mediaItem('file')]));
    const original = bridge.state.records[0]; assert.equal(original.accepted, false); assert.equal(original.attachments.length, 3);
    await bridge.ingest(update([mediaItem('image')], '2', 'other'));
    let forwarded;
    bridge.fetch = async (url, options) => { forwarded = JSON.parse(options.body); return Response.json({ messageId: original.id }); };
    await bridge.cardbush(original); assert.match(forwarded.text, /download_attachment/); assert.doesNotMatch(forwarded.text, /aes_key|sample-image|context-1|test-account-secret/);
    await bridge.close(); bridge = await new Bridge(root, settings, account, api, { log() {} }).load();
    const event = toolEvent(bridge, original, 'list_attachments', { limit: 2 });
    const page = (await bridge.receive(event)).result; assert.equal(page.attachments.length, 2); assert.equal(page.next_cursor, 2);
    assert.equal((await bridge.receive({ ...event, arguments: { cursor: 2 } })).result.attachments.length, 1);
    const fileId = original.attachments[2].id, get = toolEvent(bridge, original, 'download_attachment', { attachment_id: fileId });
    const [a, b] = await Promise.all([bridge.receive(get), bridge.receive(get)]);
    assert.equal(downloads, 1); assert.equal(a.result.localPath, b.result.localPath); assert.deepEqual(await readFile(a.result.localPath), samples.file);
    assert.ok(a.result.localPath.startsWith(root)); assert.doesNotMatch(JSON.stringify(a), /aes_key|sample-file/);
    await assert.rejects(bridge.receive({ ...get, arguments: { attachment_id: bridge.state.records[1].attachments[0].id } }), /attachment_not_found/);
    await bridge.close(); bridge = await new Bridge(root, settings, account, api, { log() {} }).load();
    assert.equal((await bridge.receive(get)).result.status, 'downloaded'); assert.equal(downloads, 1);
    await writeFile(a.result.localPath, 'tampered'); assert.equal((await bridge.receive(get)).result.code, 'attachment_file_changed');
  } finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});

test('malformed media and excess attachments have explicit status without losing valid text or attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-invalid-')); let bridge;
  try {
    bridge = await new Bridge(root, config, account, {}, { log() {} }).load();
    const invalid = mediaItem('image'); invalid.image_item.media.full_url = 'http://127.0.0.1/private';
    const named = mediaItem('file'); named.file_item.file_name = '../../dangerous\r\nname.txt';
    await bridge.ingest(update([{ type: 1, text_item: { text: '请看附件' } }, invalid, named, ...Array.from({ length: 8 }, () => mediaItem('video'))]));
    const record = bridge.state.records[0];
    assert.equal(record.text, '请看附件'); assert.equal(record.attachments.length, 8); assert.equal(record.omittedAttachments, 2);
    assert.equal(record.attachments[0].error, 'untrusted_media_host'); assert.equal(record.attachments[0].media, undefined);
    assert.equal(record.attachments[1].name, 'dangerous__name.txt');
    const event = toolEvent(bridge, record, 'download_attachment', { attachment_id: record.attachments[0].id });
    assert.equal((await bridge.receive(event)).result.code, 'untrusted_media_host');
    const noSize = mediaItem('image'); noSize.image_item.mid_size = 0;
    assert.equal(incomingAttachments([noSize], 'default-size').attachments[0].error, undefined);
  } finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed downloads can retry, missing cached files redownload and cache directory redirection is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-recover-')); let bridge, attempts = 0;
  const api = new WeixinApi(account, async () => ++attempts === 1 ? new Response('', { status: 503 }) : new Response(encrypt(samples.file)));
  try {
    bridge = await new Bridge(root, config, account, api, { log() {} }).load(); await bridge.ingest(update([mediaItem('file')]));
    const record = bridge.state.records[0], event = toolEvent(bridge, record, 'download_attachment', { attachment_id: record.attachments[0].id });
    assert.equal((await bridge.receive(event)).result.code, 'media_http_503');
    const downloaded = (await bridge.receive({ ...event, eventId: 'retry' })).result;
    assert.equal(downloaded.status, 'downloaded'); assert.equal(attempts, 2);
    await unlink(downloaded.localPath);
    assert.equal((await bridge.receive({ ...event, eventId: 'recover' })).result.status, 'downloaded'); assert.equal(attempts, 3);
    assert.equal(bridge.state.records[0].attachments[0].lastError, undefined);
    await unlink(downloaded.localPath); await rmdir(join(root, 'inbound-files'));
    const other = join(root, 'redirected'); await mkdir(other); await symlink(other, join(root, 'inbound-files'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await bridge.receive({ ...event, eventId: 'redirect' })).result.code, 'attachment_path_changed'); assert.equal(attempts, 3);
    await unlink(join(root, 'inbound-files'));
  } finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});
