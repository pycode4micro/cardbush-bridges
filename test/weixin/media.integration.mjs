// Actual Cardbush Runtime, plugin discovery, permissions, image/file tools and HTTP.
// Only the model and external Tencent API/CDN are deterministic simulators.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDecipheriv } from 'node:crypto';
import { Bridge } from '../../src/adapters/weixin/bridge.mjs';
import { WeixinApi } from '../../src/adapters/weixin/weixin.mjs';
import { samples, encrypt, mediaItem, config, account, update } from './media-helpers.mjs';
const source = resolve(process.env.CARDBUSH_SOURCE_DIR || '../cardbush');
const { ContextWebhookHost } = await import(pathToFileURL(join(source, 'dist-electron/contextWebhookHost.mjs')));
const { InMemoryRuntimeHost, SessionStore } = await import(pathToFileURL(join(source, 'packages/bush-runtime/dist/index.js')));
const { assistantProfileSchema } = await import(pathToFileURL(join(source, 'packages/bush-protocol/dist/index.js')));
function find(value, predicate) {
  if (typeof value === 'string') {
    try { return find(JSON.parse(value), predicate); } catch {
      for (const line of value.split('\n')) { try { const match = find(JSON.parse(line), predicate); if (match) return match; } catch {} }
      return;
    }
  }
  if (!value || typeof value !== 'object') return;
  if (predicate(value)) return value;
  for (const item of Object.values(value)) { const match = find(item, predicate); if (match) return match; }
}
for (const scope of ['conversation', 'assistant']) for (const kind of ['image', 'video', 'file'])
test(`${scope}: incoming ${kind} -> actual Runtime/plugin download -> native Weixin media send`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-media-runtime-')), calls = [], sent = [], uploadedBytes = [];
  let gateway, bridge, downloadPath, uploadKey, modelError, downloadCount = 0, vision = false;
  const sessionId = scope === 'assistant' ? 'personal-assistant' : 'media';
  const api = new WeixinApi(account, async (url, options) => {
    url = String(url);
    if (options.method === 'GET') { downloadCount++; assert.equal(options.headers.Authorization, undefined); return new Response(encrypt(samples[kind])); }
    if (url.endsWith('/getconfig')) return Response.json({ ret: 0, typing_ticket: 'private-typing-ticket' });
    if (url.endsWith('/sendtyping')) return Response.json({ ret: 0 });
    if (url.endsWith('/getuploadurl')) { const body = JSON.parse(options.body); uploadKey = Buffer.from(body.aeskey, 'hex');
      assert.equal(body.media_type, { image: 1, video: 2, file: 3 }[kind]); return Response.json({ upload_param: 'outbound-parameter' }); }
    if (url.includes('/c2c/upload')) {
      const decrypt = createDecipheriv('aes-128-ecb', uploadKey, null);
      uploadedBytes.push(Buffer.concat([decrypt.update(options.body), decrypt.final()])); return new Response('', { headers: { 'x-encrypted-param': 'outgoing-cdn-ref' } });
    }
    assert.ok(url.endsWith('/sendmessage')); sent.push(JSON.parse(options.body).msg); return Response.json({ ret: 0 });
  });
  function step(input) {
    const has = id => input.messages.some(message => message.role === 'tool' && message.toolCallId === id);
    if (scope === 'assistant' && input.sessionId === sessionId && input.metadata.agentRole !== 'child')
      return has('delegate') ? undefined : { id: 'delegate', name: 'subagent', arguments: { prompt: 'Inspect the attachment in the current Weixin request using its bridge plugin, then send it back using the matching native media tool.' } };
    const context = find(input.messages.filter(message => message.name === 'bot_context').at(-1)?.content.split('\n').at(-1), object => !!object.source)?.source;
    assert.equal(context?.senderId, 'owner');
    const tools = context.plugins.flatMap(plugin => plugin.tools), tool = suffix => tools.find(name => name.endsWith('__' + suffix));
    const schema = suffix => ({ id: 'schema-' + suffix, name: 'get_tool_schema', arguments: { name: tool(suffix) } });
    const call = (suffix, args) => ({ id: 'invoke-' + suffix, name: 'call_tool', arguments: { name: tool(suffix), arguments: args } });
    if (!has('search')) return { id: 'search', name: 'mcp_search', arguments: { query: tool('list_attachments') } };
    assert.ok(input.messages.find(message => message.toolCallId === 'search')?.content.includes(tool('list_attachments')));
    if (!has('schema-list_attachments')) return schema('list_attachments');
    if (!has('invoke-list_attachments')) return call('list_attachments', {});
    const listed = find(input.messages.find(message => message.toolCallId === 'invoke-list_attachments')?.content, object => Array.isArray(object.attachments));
    assert.equal(listed?.attachments.length, 1);
    if (!has('schema-download_attachment')) return schema('download_attachment');
    if (!has('invoke-download_attachment')) return call('download_attachment', { attachment_id: listed.attachments[0].attachment_id });
    const result = find(input.messages.find(message => message.toolCallId === 'invoke-download_attachment')?.content, object => typeof object.localPath === 'string');
    assert.equal(result?.status, 'downloaded'); downloadPath = result.localPath;
    if (kind === 'image' && !has('inspect')) return { id: 'inspect', name: 'inject_image_input', arguments: { url: downloadPath, detail: 'high' } };
    if (kind === 'image') {
      vision ||= !!find(input.messages, object => Array.isArray(object.images) && object.images.length > 0);
      const receipt = input.messages.find(message => message.toolCallId === 'inspect')?.content;
      assert.ok(find(receipt, object => object.queued === true), receipt);
    }
    if (kind === 'file' && !has('inspect')) return { id: 'inspect', name: 'read_file', arguments: { path: downloadPath } };
    if (kind === 'file') assert.match(input.messages.find(message => message.toolCallId === 'inspect')?.content, /实际文件字节/);
    const sending = 'send_' + kind;
    if (!has('schema-' + sending)) return schema(sending);
    if (!has('invoke-' + sending)) return call(sending, { file: downloadPath });
  }
  const runtime = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), sessionStore: new SessionStore(), botMessaging: {
    context: (sessionId, sourceRef, signal) => gateway.botRequest({ action: 'context', sessionId, sourceRef }, signal),
    catalog: (sessionId, signal) => gateway.botRequest({ action: 'catalog', sessionId }, signal),
    call: (sessionId, input, signal, files) => gateway.botRequest({ action: 'call', sessionId, input, files }, signal),
  }, provider: { async *stream(input) {
    calls.push(input); let call;
    try { call = step(input); } catch (error) { modelError = error; throw error; }
    const base = { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'response_started' };
    if (call) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: call.id, nameDelta: call.name, argumentsDelta: JSON.stringify(call.arguments) };
    else yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Done.' };
    yield { ...base, sequence: 2, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
  } } });
  const local = { command: (kind, payload) => runtime.sendCommand({ kind, payload }) };
  try {
    await local.command('runtime.create_session', { sessionId });
    gateway = await new ContextWebhookHost(root, { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() }, local, { port: 0 }).start();
    bridge = await new Bridge(root, config, account, api, { log() {} }).load(); const port = await bridge.listen(0);
    const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'bind', turnId: 'bind', sessionId, model: 'fixture',
      tools: await local.command('runtime.get_tool_catalog', {}), prefixMessages: [], inputMessages: [{ messageId: 'bind', message: { role: 'user', content: 'Context' } }],
      metadata: { mcpCatalogUpdates: 'additions' }, requestCapabilities: { vision: true }, permissionMode: 'all_free' };
    const body = Object.fromEntries(['protocol', 'type', 'eventId', 'sequence', 'messageId', 'senderId', 'conversationId', 'status', 'reply'].map(key => [key, '{{' + key + '}}']));
    const saved = await gateway.command({ action: 'save', config: { name: '微信服务', enabled: true, url: `http://127.0.0.1:${port}/reply`,
      headers: { Authorization: 'Bearer ' + config.callbackToken }, parameters: {}, body, incoming: { messageId: 'messageId', text: 'text', senderId: 'senderId', conversationId: 'conversationId' } },
      binding: { kind: scope, sessionId, title: 'Media', parent, ...(scope === 'assistant' ? { generation: 0, profile: assistantProfileSchema.parse({}) } : {}) } });
    bridge.config = { ...config, cardbush: { url: saved.connections[0].endpoint, token: saved.connections[0].token } }; await bridge.advertise();
    await bridge.ingest(update([mediaItem(kind)]));
    const expectedType = { image: 2, video: 5, file: 4 }[kind];
    for (let i = 0; i < 250 && !modelError && !sent.some(message => message.item_list[0].type === expectedType); i++) {
      await bridge.processOnce(); await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (modelError) throw modelError;
    assert.equal(sent.filter(message => message.item_list[0].type === expectedType).length, 1);
    assert.equal(downloadCount, 1); assert.deepEqual(await readFile(downloadPath), samples[kind]); assert.deepEqual(uploadedBytes, [samples[kind]]);
    assert.ok(sent.every(message => message.to_user_id === 'owner' && message.context_token === 'context-1'));
    if (kind === 'image') assert.ok(vision, 'the model receives the actual image, not just a filename');
    assert.doesNotMatch(JSON.stringify(calls), /test-account-secret|private-typing-ticket|sample-image|sample-video|sample-file|outgoing-cdn-ref/);
    await bridge.processOnce(); assert.equal(sent.filter(message => message.item_list[0].type === expectedType).length, 1);
  } finally { await bridge?.close(); await gateway?.close(); await local.command('runtime.shutdown', {}); await rm(root, { recursive: true, force: true }); }
});
