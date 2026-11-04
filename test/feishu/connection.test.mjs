import test from 'node:test';
import assert from 'node:assert/strict';
import * as lark from '@larksuiteoapi/node-sdk';
import { connectFeishu } from '../../src/adapters/feishu/connection.mjs';
import { fixture, message, app } from './helpers.mjs';

test('official dispatcher acknowledges only persisted v2 messages, with reconnect hooks and cancellation', async t => {
  const { bridge } = await fixture(t); const logs = []; let options, dispatcher, closed = 0;
  class WSClient {
    constructor(value) { options = value; }
    async start(value) { dispatcher = value.eventDispatcher; options.onReady(); }
    close() { closed++; }
  }
  const connection = connectFeishu(app, bridge, { sdk: { ...lark, WSClient }, signal: bridge.abort.signal, log: text => logs.push(text) });
  await connection.started;
  const envelope = { schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'ev_real_shape' }, event: message() };
  assert.deepEqual(await dispatcher.invoke(envelope, { needCheck: false }), {});
  assert.equal(bridge.state.records.length, 1); assert.equal(bridge.state.records[0].text, '你好');
  await dispatcher.invoke(envelope, { needCheck: false }); assert.equal(bridge.state.records.length, 1);
  bridge.ingest = async () => { throw Error('disk_full'); };
  await assert.rejects(dispatcher.invoke(envelope, { needCheck: false }), /disk_full/);
  options.onReconnecting(); options.onReconnected(); options.logger.error({ secret: app.appSecret });
  options.onError(new Error('secret: ' + app.appSecret));
  assert.equal(bridge.abort.signal.reason.message, 'feishu_connection_failed'); assert.equal(closed, 1);
  assert.ok(!logs.join().includes(app.appSecret)); connection.close();
  assert.throws(() => connectFeishu(app, bridge, { sdk: { ...lark, WSClient }, signal: bridge.abort.signal }), /feishu_connection_failed/);
});
