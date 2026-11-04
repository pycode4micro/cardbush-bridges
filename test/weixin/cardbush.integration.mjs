// Real desktop Webhook host and Runtime; only Tencent transport and the model are mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Bridge } from '../../src/adapters/weixin/bridge.mjs';
import { connectLocalService } from '../../src/shared/local-connection.mjs';
const source = resolve(process.env.CARDBUSH_SOURCE_DIR || '../cardbush');
const { bridgeModelStep } = await import(pathToFileURL(join(source, 'scripts/helpers/bridge-plugin-fixture.mjs')));
const { ContextWebhookHost } = await import(pathToFileURL(join(source, 'dist-electron/contextWebhookHost.mjs')));
const { InMemoryRuntimeHost, SessionStore } = await import(pathToFileURL(join(source, 'packages/bush-runtime/dist/index.js')));

for (const order of ['desktop-first', 'bridge-first']) test(`generic pairing accepts ${order} startup over real local HTTP`, { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pairing-order-')), abort = new AbortController();
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const gateway = new ContextWebhookHost(root, { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() },
    { command: async () => ({}) }, { port });
  const notices = []; let connecting, saved;
  try {
    if (order === 'desktop-first') await gateway.start();
    connecting = connectLocalService({ port: 4792, callbackToken: 'b'.repeat(64), cardbush: { url: '', token: '' } }, {
      name: 'Generic local service', baseUrl: `http://127.0.0.1:${port}`, signal: abort.signal,
      save: async value => { saved = value; }, onStatus: value => notices.push(value), wait: async () => new Promise(r => setTimeout(r, 30)),
    });
    void connecting.catch(() => {});
    if (order === 'bridge-first') {
      for (let i = 0; i < 100 && !notices.includes('waiting_for_cardbush'); i++) await new Promise(r => setTimeout(r, 20));
      assert.ok(notices.includes('waiting_for_cardbush')); await gateway.start();
    }
    let pending;
    for (let i = 0; i < 100 && !pending; i++) { pending = (await gateway.command({ action: 'read', sessionId: 'existing' })).pairings[0]; await new Promise(r => setTimeout(r, 20)); }
    assert.ok(pending, 'late startup must become visible without reopening the desktop or dialog');
    const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'bind', turnId: 'bind', sessionId: 'existing', model: 'fixture', tools: [],
      prefixMessages: [], inputMessages: [{ messageId: 'bind', message: { role: 'user', content: 'Existing context' } }], metadata: {}, permissionMode: 'task_free' };
    await gateway.command({ action: 'approve_pairing', requestId: pending.requestId, binding: { kind: 'conversation', sessionId: 'existing', title: 'Chosen context', parent } });
    const config = await connecting;
    assert.equal(config.cardbush.url, saved.cardbush.url); assert.match(config.cardbush.url, /\/messages$/);
    assert.equal(notices.at(-1), 'connected');
  } finally { abort.abort(); await connecting?.catch(() => {}); await gateway.close(); await rm(root, { recursive: true, force: true }); }
});
test('Weixin message completes through the actual Cardbush session and returns over HTTP to the correct Weixin context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-cardbush-')); const sent = [], calls = []; let bridge, gateway;
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), provider: { async *stream(request) {
    calls.push(request); const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'response_started' }; yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Earlier topic: olive.' };
    yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
  } } });
  const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'first', turnId: 'first', sessionId: 'existing', model: 'fixture',
    tools: [], prefixMessages: [], inputMessages: [{ messageId: 'first', message: { role: 'user', content: 'Remember olive.' } }], metadata: {}, permissionMode: 'task_free' };
  try {
    await runtime.runSessionTurn(parent);
    bridge = await new Bridge(root, { port: 4792, callbackToken: 'b'.repeat(64), cardbush: { url: 'http://127.0.0.1:4791/api/webhooks/v1/pending/messages', token: 'a'.repeat(64) } },
      { id: 'wx-bot', userId: 'owner' }, { send: async (...args) => sent.push(args) }, { log() {} }).load();
    const port = await bridge.listen(0);
    gateway = await new ContextWebhookHost(root, { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() },
      { command: (kind, payload) => runtime.sendCommand({ kind, payload }) }, { port: 0 }).start();
    const baseUrl = 'http://127.0.0.1:' + (await gateway.command({ action: 'read', sessionId: 'existing' })).port;
    const connecting = connectLocalService({ ...bridge.config, port }, { name: 'Independent generic bot', baseUrl, force: true,
      save: async () => {}, wait: async () => new Promise(r => setTimeout(r, 20)) });
    let pending;
    for (let n = 0; n < 100 && !pending; n++) { pending = (await gateway.command({ action: 'read', sessionId: 'existing' })).pairings[0]; await new Promise(r => setTimeout(r, 20)); }
    assert.ok(pending, 'service appears automatically in the desktop connection UI');
    await gateway.command({ action: 'approve_pairing', requestId: pending.requestId, binding: { kind: 'conversation', sessionId: 'existing', title: 'Existing context', parent } });
    bridge.config = await connecting;
    await bridge.ingest({ get_updates_buf: 'cursor', msgs: [{ message_type: 1, message_id: '9007199254740993', from_user_id: 'owner', context_token: 'wx-private-context', item_list: [{ type: 1, text_item: { text: 'What was the topic?' } }] }] });
    for (let n = 0; n < 100 && !sent.length; n++) { await bridge.processOnce(); await new Promise(r => setTimeout(r, 50)); }
    assert.equal(calls.length, 2); assert.match(JSON.stringify(calls[1].messages), /Remember olive/);
    assert.equal(sent.length, 1); assert.equal(sent[0][0], 'owner'); assert.equal(sent[0][1], 'wx-private-context'); assert.equal(sent[0][2], 'Earlier topic: olive.');
    await new Promise(r => setTimeout(r, 1500)); await bridge.processOnce(); assert.equal(sent.length, 1, 'polling and callback race is deduplicated');
  } finally { await gateway?.close(); await bridge?.close(); await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await rm(root, { recursive: true, force: true }); }
});

test('Agent file tool -> generic multipart Webhook -> independent Weixin bridge preserves bytes and source', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-file-chain-')), sent = [], calls = []; let gateway, bridge;
  const file = join(root, 'report.txt'), bytes = Buffer.from('完整链路附件\n'); await writeFile(file, bytes);
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), botMessaging: {
    context: (sessionId, sourceRef, signal) => gateway.botRequest({ action: 'context', sessionId, sourceRef }, signal),
    catalog: (sessionId, signal) => gateway.botRequest({ action: 'catalog', sessionId }, signal),
    call: (sessionId, input, signal, files) => gateway.botRequest({ action: 'call', sessionId, input, files }, signal),
  }, provider: { async *stream(input) {
    calls.push(input);
    const base = { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'response_started' };
    const state = JSON.parse(input.messages.filter(m => m.name === 'bot_context').at(-1).content.split('\n').at(-1));
    assert.equal(state.source.botName, 'Weixin'); assert.equal(state.source.senderId, 'owner'); assert.equal(state.source.available, true);
    const call = bridgeModelStep(input.messages, file);
    if (call) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: call.id, nameDelta: call.name, argumentsDelta: JSON.stringify(call.arguments) };
    else yield { ...base, sequence: 1, kind: 'text_delta', delta: '已交给 Bot 发送。' };
    yield { ...base, sequence: 2, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
  } } });
  const local = { command: (kind, payload) => runtime.sendCommand({ kind, payload }) };
  try {
    await local.command('runtime.create_session', { sessionId: 'files' });
    gateway = await new ContextWebhookHost(root, { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() }, local, { port: 0 }).start();
    bridge = await new Bridge(root, { cardbush: { url: 'http://127.0.0.1:4791/api/webhooks/v1/test/messages', token: 'a'.repeat(64) }, callbackToken: 'b'.repeat(64), port: 4792 },
      { id: 'bot', userId: 'owner' }, { send: async () => {}, sendFile: async (...args) => { sent.push(args); } }, { log() {} }).load();
    const port = await bridge.listen(0);
    const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'bind', turnId: 'bind', sessionId: 'files', model: 'fixture', tools: await local.command('runtime.get_tool_catalog', {}),
      prefixMessages: [], inputMessages: [{ messageId: 'bind', message: { role: 'user', content: 'Context' } }], metadata: {}, permissionMode: 'all_free' };
    const saved = await gateway.command({ action: 'save', config: { name: 'Weixin', enabled: true, url: `http://127.0.0.1:${port}/reply`,
      headers: { Authorization: 'Bearer ' + bridge.config.callbackToken }, parameters: {}, body: { protocol: '{{protocol}}', type: '{{type}}', eventId: '{{eventId}}', sequence: '{{sequence}}', messageId: '{{messageId}}', senderId: '{{senderId}}', conversationId: '{{conversationId}}', status: '{{status}}', reply: '{{reply}}' },
      incoming: { messageId: 'messageId', text: 'text', senderId: 'senderId', conversationId: 'conversationId' } },
      binding: { kind: 'conversation', sessionId: 'files', title: 'Files', parent } });
    bridge.config.cardbush = { url: saved.connections[0].endpoint, token: saved.connections[0].token }; await bridge.advertise();
    await bridge.ingest({ msgs: [{ message_type: 1, message_id: '9007199254740995', from_user_id: 'owner', context_token: 'original-weixin-context', item_list: [{ type: 1, text_item: { text: '把报告作为文件发给我。' } }] }] });
    const deadline = Date.now() + 15000;
    while (!sent.length && Date.now() < deadline) { await bridge.processOnce(); await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(sent.length, 1, JSON.stringify(calls.at(-1)?.messages.filter(message => message.role === 'tool')));
    assert.equal(sent[0][0], 'owner'); assert.equal(sent[0][1], 'original-weixin-context'); assert.equal(sent[0][2].name, 'report.txt'); assert.deepEqual(sent[0][2].bytes, bytes);
    assert.ok(calls.every(call => !call.tools.some(t => t.name === 'send_to_bot')));
    assert.ok(JSON.stringify(calls).includes('bridge-schema-call'));
    await bridge.processOnce(); assert.equal(sent.length, 1);
  } finally { await gateway?.close(); await bridge?.close(); await local.command('runtime.shutdown', {}); await rm(root, { recursive: true, force: true }); }
});
