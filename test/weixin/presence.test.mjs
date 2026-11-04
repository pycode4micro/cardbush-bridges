import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WeixinApi } from '../../src/adapters/weixin/weixin.mjs';
import { WeixinPresence } from '../../src/adapters/weixin/presence.mjs';
import { Bridge } from '../../src/adapters/weixin/bridge.mjs';
import { config, account } from './media-helpers.mjs';

test('configuration, typing and start/stop use independent authenticated iLink endpoints', async () => {
  const calls = [], api = new WeixinApi(account, async (url, options) => {
    calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body), headers: options.headers });
    return String(url).endsWith('sendtyping') ? new Response(null, { status: 204 }) : Response.json({ ret: 0, typing_ticket: 'private-ticket' });
  });
  await api.notifyStart(); const value = await api.getConfig('owner', 'original-context');
  await api.sendTyping('owner', value.typing_ticket, 1); await api.sendTyping('owner', value.typing_ticket, 2); await api.notifyStop();
  assert.deepEqual(calls.map(call => call.path), ['/ilink/bot/msg/notifystart', '/ilink/bot/getconfig', '/ilink/bot/sendtyping', '/ilink/bot/sendtyping', '/ilink/bot/msg/notifystop']);
  assert.ok(calls.every(call => call.headers.Authorization === 'Bearer ' + account.token && call.body.base_info.bot_agent.startsWith('CardbushWeixinBridge/')));
  assert.equal(calls[1].body.context_token, 'original-context'); assert.equal(calls[2].body.typing_ticket, 'private-ticket');
  const failed = new WeixinApi(account, async () => Response.json({ typing_ticket: 'unconfirmed' }));
  await assert.rejects(failed.getConfig('owner', 'context'), /weixin_config_unavailable/);
});

test('presence caches configuration, refreshes typing, cancels only after all sender jobs end and cleans up once', async () => {
  let now = 0, configs = 0; const sent = [], lifecycle = [];
  const presence = new WeixinPresence({ getConfig: async () => { configs++; return { typing_ticket: 'ticket' }; },
    sendTyping: async (...args) => sent.push(args), notifyStart: async () => lifecycle.push('start'), notifyStop: async () => lifecycle.push('stop') }, { now: () => now });
  const job = { sender: 'owner', context: 'context', accepted: true, terminal: false };
  await presence.start(); await presence.start(); await presence.sync([job]);
  await presence.sync([job]); assert.equal(sent.length, 1); assert.equal(configs, 1);
  now = 9000; await presence.sync([job]); assert.equal(sent.length, 2); assert.equal(configs, 1);
  await presence.sync([{ ...job, terminal: true }, job]); assert.equal(sent.length, 2);
  await presence.sync([{ ...job, terminal: true }]); assert.equal(sent.at(-1)[2], 2);
  now = 310000; await presence.sync([job]); assert.equal(configs, 2); await presence.stop(); await presence.stop();
  assert.deepEqual(lifecycle, ['start', 'stop']); assert.equal(sent.at(-1)[2], 2); assert.equal(presence.cache.size, 0);
});

test('presence failures are isolated and throttled without leaking server messages', async () => {
  let now = 0, calls = 0; const logs = [];
  const presence = new WeixinPresence({ getConfig: async () => { calls++; throw Error('secret=https://token'); }, sendTyping: async () => {},
    notifyStart: async () => { throw Error('weixin_http_503'); } }, { now: () => now, log: line => logs.push(line) });
  const jobs = [{ sender: 'owner', context: 'context', accepted: true }];
  await presence.start(); await presence.sync(jobs); await presence.sync(jobs); assert.equal(calls, 1);
  now = 31000; await presence.sync(jobs); assert.equal(calls, 2); assert.doesNotMatch(logs.join(), /secret|token/);
  await presence.stop();
});

test('typing failures back off, retain cancellation and bound failed configuration cache entries', async () => {
  let now = 0, configs = 0, sends = 0;
  const presence = new WeixinPresence({ getConfig: async () => { configs++; return { typing_ticket: 'ticket' }; },
    sendTyping: async () => { sends++; throw Error('weixin_http_503'); } }, { now: () => now });
  const job = { sender: 'owner', context: 'context', accepted: true };
  await presence.sync([job]); now = 9000; await presence.sync([job]); assert.equal(configs, 1); assert.equal(sends, 1);
  now = 31000; await presence.sync([job]); assert.equal(configs, 2); assert.equal(sends, 2);
  await presence.sync([]); await presence.sync([]); assert.equal(sends, 3);
  now = 62000; await presence.sync([]); assert.equal(sends, 4);
  presence.api.getConfig = async () => { throw Error('weixin_http_503'); };
  for (let i = 0; i < 300; i++) await presence.ticket({ sender: 'owner', context: 'context-' + i });
  assert.equal(presence.cache.size, 256);
});

test('actual bridge startup and shutdown own lifecycle calls and do not expose them as plugin tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weixin-lifecycle-')), calls = []; let bridge;
  try {
    bridge = await new Bridge(root, config, account, { notifyStart: async () => calls.push('start'), notifyStop: async signal => {
      assert.equal(signal.aborted, false); calls.push('stop'); }, updates: async () => { bridge.abort.abort(); return {}; } },
    { log() {}, fetcher: async () => Response.json({ protocol: 'cardbush.webhook.v1', status: 'connected', features: ['bridge_plugins'] }) }).load();
    const listen = bridge.listen.bind(bridge); bridge.listen = () => listen(0);
    await assert.rejects(bridge.run(), { name: 'AbortError' }); await bridge.close();
    assert.deepEqual(calls, ['start', 'stop']);
    const names = bridge.plugins[0].manifest.tools.map(tool => tool.name);
    assert.equal(names.length, 7); assert.ok(!names.some(name => /login|config|typing|start|stop/.test(name)));
  } finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});
