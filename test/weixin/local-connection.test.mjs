import test from 'node:test';
import assert from 'node:assert/strict';
import { connectLocalService } from '../../src/shared/local-connection.mjs';
const endpoint = 'http://127.0.0.1:4791/api/webhooks/v1/generic/messages';
const fresh = () => ({ cardbush: { url: '', token: '' }, callbackToken: 'b'.repeat(64), port: 4792 });
test('generic service discovery exchanges callback and credentials without manual fields and reuses its saved grant', async () => {
  const saves = [], calls = [], notices = []; let requestId;
  const config = await connectLocalService(fresh(), { name: 'Any local bot', save: async c => saves.push(c), wait: async () => {}, onStatus: status => notices.push(status),
    fetcher: async (url, options) => {
      calls.push({ url, ...options }); const protocol = 'cardbush.webhook.v1';
      if (url.endsWith('/discovery')) return Response.json({ protocol, capabilities: ['local_pairing'] });
      if (options.method === 'POST') { const body = JSON.parse(options.body); requestId = body.requestId;
        assert.equal(body.replyUrl, 'http://127.0.0.1:4792/reply'); assert.equal(body.replyHeaders.Authorization, 'Bearer ' + fresh().callbackToken);
        assert.match(options.headers.Authorization, /^Bearer [a-f0-9]{64}$/); return Response.json({ protocol, requestId, status: 'pending' }); }
      return Response.json({ protocol, requestId, status: 'connected', connection: { endpoint, token: 'c'.repeat(64), title: 'Chosen conversation' } });
    } });
  assert.equal(config.cardbush.url, endpoint); assert.equal(config.cardbush.token, 'c'.repeat(64)); assert.equal(saves.length, 2);
  assert.deepEqual(notices, ['waiting_for_authorization', 'connected']); assert.equal(config.pairing, undefined);
  let probes = 0;
  const resumed = await connectLocalService(config, { save: async () => assert.fail('no new grant on restart'), fetcher: async (url, options) => {
    probes++; assert.equal(url, endpoint); assert.equal(options.headers.Authorization, 'Bearer ' + config.cardbush.token);
    return Response.json({ protocol: 'cardbush.webhook.v1', type: 'connection.info', title: 'Chosen conversation' });
  } });
  assert.equal(probes, 1); assert.deepEqual(resumed, config);
});
test('pairing rejection and connection revocation do not trigger implicit reauthorization', async () => {
  const protocol = 'cardbush.webhook.v1'; let requestId;
  await assert.rejects(connectLocalService(fresh(), { name: 'Any bot', save: async () => {}, wait: async () => {}, fetcher: async (url, options) => {
    if (url.endsWith('/discovery')) return Response.json({ protocol, capabilities: ['local_pairing'] });
    requestId ??= JSON.parse(options.body).requestId; return Response.json({ protocol, requestId, status: 'rejected' });
  } }), /connection_rejected/);
  await assert.rejects(connectLocalService({ ...fresh(), cardbush: { url: endpoint, token: 'c'.repeat(64) } }, {
    save: async () => assert.fail('revocation must not create a replacement grant'), fetcher: async () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 }),
  }), /connection_revoked/);
  await assert.rejects(connectLocalService(fresh(), { name: 'Any bot', save: async () => {},
    fetcher: async () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 }),
  }), /unsupported_cardbush/);
});
test('offline restarts keep an authorized binding, but unexpected grants and cancellation are not accepted', async () => {
  const saved = { ...fresh(), cardbush: { url: endpoint, token: 'c'.repeat(64) } };
  assert.deepEqual(await connectLocalService(saved, { fetcher: async () => { throw TypeError('fetch failed'); } }), saved);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(connectLocalService(saved, { signal: cancel.signal, fetcher: async () => assert.fail('cancelled before connecting') }), { name: 'AbortError' });
  for (const foreign of ['http://127.0.0.1:6112/api/webhooks/v1/generic/messages', 'https://example.com/api/webhooks/v1/generic/messages', 'invalid']) {
    const saves = [];
    await assert.rejects(connectLocalService(fresh(), { name: 'Any bot', save: async value => saves.push(value), fetcher: async (url, options) => {
      const protocol = 'cardbush.webhook.v1';
      if (url.endsWith('/discovery')) return Response.json({ protocol, capabilities: ['local_pairing'] });
      return Response.json({ protocol, requestId: JSON.parse(options.body).requestId, status: 'connected', connection: { endpoint: foreign, token: 'c'.repeat(64) } });
    } }), /invalid_pairing_response/);
    assert.equal(saves.length, 1); assert.equal(saves[0].cardbush.url, '');
  }
});
