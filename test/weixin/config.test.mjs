import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCardbushUrl, validateConfig, configure, configurationError } from '../../src/adapters/weixin/config.mjs';
const endpoint = 'http://127.0.0.1:4791/api/webhooks/v1/connection-id/messages';
const config = () => ({ cardbush: { url: '', token: '' }, callbackToken: 'b'.repeat(64), port: 4792 });
test('reply URL gives a specific correction; copy formatting is normalized without allowing credentials or insecure remote HTTP', () => {
  for (const value of ['http://127.0.0.1:4792/reply', '[http://127.0.0.1:4792/reply](http://127.0.0.1:4792/reply)']) {
    assert.throws(() => normalizeCardbushUrl(value), error => error.message === 'cardbush_reply_url_used' && configurationError(error).includes('应填在 Cardbush'));
  }
  assert.equal(normalizeCardbushUrl(' "' + endpoint + '/" '), endpoint);
  assert.equal(normalizeCardbushUrl('[接收地址](' + endpoint + ')'), endpoint);
  assert.equal(normalizeCardbushUrl(endpoint.replace('127.0.0.1', '0.0.0.0')), endpoint);
  for (const value of [endpoint + '?token=secret', endpoint + '#fragment', endpoint.replace('127.0.0.1', 'user:password@127.0.0.1'), endpoint.replace('127.0.0.1', 'example.com')]) {
    assert.throws(() => normalizeCardbushUrl(value), /invalid_cardbush_url/);
  }
  assert.throws(() => validateConfig(config()), error => error.message === 'cardbush_url_required' && configurationError(error).includes('cardbush-bridge setup weixin'));
});
test('setup retries the address before asking for a token and preserves the old config until all fields are valid', async () => {
  const previous = config(), prompts = [], notices = [];
  const answers = ['http://127.0.0.1:4792/reply', endpoint + '/', '{}', 'Bearer ' + 'a'.repeat(64)];
  const result = await configure(previous, { ask: async prompt => { prompts.push(prompt); return answers.shift(); }, notify: value => notices.push(value) });
  assert.equal(prompts.length, 4); assert.ok(prompts[0].includes('接收消息地址') && prompts[1].includes('接收消息地址'));
  assert.ok(prompts[2].includes('接收令牌')); assert.equal(notices.length, 2);
  assert.equal(result.cardbush.url, endpoint); assert.equal(result.cardbush.token, 'a'.repeat(64));
  assert.deepEqual(previous.cardbush, { url: '', token: '' });
  const retained = await configure(result, { ask: async () => '', notify: () => assert.fail('valid saved values must be accepted') });
  assert.deepEqual(retained, result);
});
