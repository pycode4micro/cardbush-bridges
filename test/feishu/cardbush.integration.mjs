// Real Cardbush host, Runtime, native tool, local HTTP and official event dispatcher.
// Only the model and Feishu's external network are simulated. All data is temporary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as lark from '@larksuiteoapi/node-sdk';
import { Bridge } from '../../src/adapters/feishu/bridge.mjs';
import { FeishuApi } from '../../src/adapters/feishu/feishu.mjs';
import { connectLocalService } from '../../src/shared/local-connection.mjs';
import { config, app, message } from './helpers.mjs';

const source = resolve(process.env.CARDBUSH_SOURCE_DIR || '../cardbush');
const { ContextWebhookHost } = await import(pathToFileURL(join(source, 'dist-electron/contextWebhookHost.mjs')));
const { InMemoryRuntimeHost, SessionStore } = await import(pathToFileURL(join(source, 'packages/bush-runtime/dist/index.js')));
const { assistantProfileSchema } = await import(pathToFileURL(join(source, 'packages/bush-protocol/dist/index.js')));
const secrets = { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() };
const wait = () => new Promise(r => setTimeout(r, 25));
const until = async fn => { for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await wait(); } throw Error('test_timeout'); };
const parent = (id = 'existing') => ({ protocol: 'bush.session_turn_request.v1', requestId: 'bind', turnId: 'bind', sessionId: id, model: 'fixture', tools: [],
  prefixMessages: [], inputMessages: [{ messageId: 'bind', message: { role: 'user', content: 'Remember olive.' } }], metadata: {}, permissionMode: 'all_free' });

for (const order of ['desktop-first', 'bridge-first']) test(`automatic generic pairing accepts ${order}`, { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-pairing-')), abort = new AbortController();
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const gateway = new ContextWebhookHost(root, secrets, { command: async () => ({}) }, { port });
  const notices = []; let connecting, saved;
  try {
    if (order === 'desktop-first') await gateway.start();
    connecting = connectLocalService({ ...config(), cardbush: { url: '', token: '' } }, {
      name: '飞书服务', baseUrl: `http://127.0.0.1:${port}`, signal: abort.signal,
      save: async value => { saved = value; }, onStatus: value => notices.push(value), wait,
    });
    void connecting.catch(() => {});
    if (order === 'bridge-first') { await until(() => notices.includes('waiting_for_cardbush')); await gateway.start(); }
    const pending = await until(async () => (await gateway.command({ action: 'read', sessionId: 'existing' })).pairings[0]);
    await gateway.command({ action: 'approve_pairing', requestId: pending.requestId,
      binding: { kind: 'conversation', sessionId: 'existing', title: 'Chosen context', parent: parent() } });
    const connected = await connecting;
    assert.equal(connected.cardbush.url, saved.cardbush.url); assert.match(connected.cardbush.url, /\/messages$/);
    assert.equal(notices.at(-1), 'connected'); assert.deepEqual(connected.feishu, app);
  } finally { abort.abort(); await connecting?.catch(() => {}); await gateway.close(); await rm(root, { recursive: true, force: true }); }
});

for (const kind of ['conversation', 'assistant']) test(`${kind}: Feishu message -> actual Runtime/send_to_bot -> multipart -> Feishu upload/send preserves source, context and bytes`, { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-chain-')), sent = [], calls = [], uploads = []; let gateway, bridge;
  const file = join(root, 'report.txt'), bytes = Buffer.from('真实本机 HTTP 链路测试\n二进制不经过模型\n'); await writeFile(file, bytes);
  const api = new FeishuApi(app, async (url, options) => {
    if (url.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 });
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    if (url.endsWith('/im/v1/files')) {
      uploads.push(Buffer.from(await options.body.get('file').arrayBuffer())); assert.equal(options.body.get('file_name'), 'report.txt');
      return Response.json({ code: 0, data: { file_key: 'file_uploaded' } });
    }
    assert.ok(url.endsWith('/im/v1/messages?receive_id_type=chat_id')); sent.push(JSON.parse(options.body));
    return Response.json({ code: 0, data: { message_id: 'om_sent_' + sent.length } });
  });
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), botMessaging: {
    context: (sessionId, sourceRef, signal) => gateway.botRequest({ action: 'context', sessionId, sourceRef }, signal),
    send: (sessionId, input, signal, files) => gateway.botRequest({ action: 'send', sessionId, input, files }, signal),
  }, provider: { async *stream(input) {
    calls.push(input); const base = { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'response_started' };
    const source = input.messages.filter(m => m.name === 'bot_context').at(-1);
    const first = source && !input.messages.some(m => m.role === 'tool' && m.toolCallId === 'file-tool');
    if (first) {
      const state = JSON.parse(source.content.split('\n').at(-1));
      assert.equal(state.source.botName, '飞书服务'); assert.equal(state.source.senderId, 'ou_owner'); assert.equal(state.source.available, true);
      assert.equal(state.source.conversationId, 'oc_origin');
      assert.match(JSON.stringify(input.messages), /Remember olive/);
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'file-tool', nameDelta: 'send_to_bot',
        argumentsDelta: JSON.stringify({ source_ref: state.source.sourceRef, request_id: 'file-report', files: [file] }) };
    } else yield { ...base, sequence: 1, kind: 'text_delta', delta: source ? '报告已交给飞书服务发送。' : 'I remember olive.' };
    yield { ...base, sequence: 2, kind: 'response_completed', finishReason: first ? 'tool_calls' : 'stop' };
  } } });
  const local = { command: (type, payload) => runtime.sendCommand({ kind: type, payload }) };
  try {
    const sessionId = kind === 'assistant' ? 'personal-assistant' : 'files', request = parent(sessionId);
    if (kind === 'conversation') await runtime.runSessionTurn(request);
    else {
      await local.command('runtime.create_session', { sessionId });
      await local.command('runtime.assistant_conversation', { action: 'append', sessionId,
        entry: { id: 'prior', role: 'user', source: 'text', visibility: 'conversation', content: 'Remember olive.', createdAt: new Date().toISOString() } });
    }
    gateway = await new ContextWebhookHost(root, secrets, local, { port: 0 }).start();
    bridge = await new Bridge(root, { ...config(), allowedSenders: ['ou_owner'] }, api, { log() {}, botOpenId: 'ou_bot' }).load();
    const port = await bridge.listen(0);
    const body = Object.fromEntries(['protocol', 'type', 'eventId', 'sequence', 'messageId', 'senderId', 'conversationId', 'status', 'reply'].map(key => [key, '{{' + key + '}}']));
    const binding = { kind, sessionId, title: 'Files', parent: request,
      ...(kind === 'assistant' ? { generation: 0, profile: assistantProfileSchema.parse({}) } : {}) };
    const saved = await gateway.command({ action: 'save', config: { name: '飞书服务', enabled: true, url: `http://127.0.0.1:${port}/reply`,
      headers: { Authorization: 'Bearer ' + bridge.config.callbackToken }, parameters: {}, body,
      incoming: { messageId: 'messageId', text: 'text', senderId: 'senderId', conversationId: 'conversationId' } }, binding });
    bridge.config.cardbush = { url: saved.connections[0].endpoint, token: saved.connections[0].token }; await bridge.advertise();
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({ 'im.message.receive_v1': event => bridge.ingest(event) });
    const event = { schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'ev_in' }, event: message('om_in', '把报告作为文件发给我。') };
    await dispatcher.invoke(event, { needCheck: false });
    await until(async () => { await bridge.processOnce(); return sent.some(s => s.msg_type === 'file') && sent.some(s => s.msg_type === 'text'); });
    assert.equal(uploads.length, 1); assert.deepEqual(uploads[0], bytes);
    assert.equal(sent.filter(s => s.msg_type === 'file').length, 1); assert.equal(sent.filter(s => s.msg_type === 'text').length, 1);
    assert.ok(sent.every(s => s.receive_id === 'oc_origin')); assert.deepEqual(JSON.parse(sent.find(s => s.msg_type === 'file').content), { file_key: 'file_uploaded' });
    assert.ok(calls.some(call => call.tools.some(t => t.name === 'send_to_bot')));
    await dispatcher.invoke(event, { needCheck: false }); await bridge.processOnce(); assert.equal(sent.length, 2);
  } finally { await gateway?.close(); await bridge?.close(); await local.command('runtime.shutdown', {}); await rm(root, { recursive: true, force: true }); }
});
