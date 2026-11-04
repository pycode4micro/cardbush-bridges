import test from 'node:test';
import assert from 'node:assert/strict';
import { connectLocalService } from '../src/shared/local-connection.mjs';

test('restart renews an expired pending pairing once without renewing a revoked authorized connection', async () => {
  const original = '11111111-1111-4111-8111-111111111111', requests = [], saved = [];
  const config = { port: 4793, callbackToken: 'b'.repeat(64), cardbush: { url: '', token: '' },
    pairing: { requestId: original, secret: 'c'.repeat(64), baseUrl: 'http://127.0.0.1:4791' } };
  const result = await connectLocalService(config, { name: 'Test service', save: async value => saved.push(value), wait: async () => {},
    fetcher: async (url, options) => {
      if (url.endsWith('/discovery')) return Response.json({ protocol: 'cardbush.webhook.v1', capabilities: ['local_pairing'] });
      const body = JSON.parse(options.body); requests.push(body);
      if (body.requestId === original) return Response.json({ error: { code: 'pairing_expired' } }, { status: 410 });
      return Response.json({ protocol: 'cardbush.webhook.v1', status: 'connected', requestId: body.requestId,
        connection: { endpoint: 'http://127.0.0.1:4791/api/webhooks/v1/fixture/messages', token: 'a'.repeat(64) } });
    } });
  assert.equal(requests.length, 2); assert.notEqual(requests[1].requestId, original);
  assert.equal(requests[1].replyUrl, requests[0].replyUrl); assert.equal(saved[0].pairing.requestId, requests[1].requestId);
  assert.equal(result.pairing, undefined);
  await assert.rejects(connectLocalService(result, { name: 'Test service', save: async () => assert.fail('must not reauthorize'),
    fetcher: async () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 }) }), /connection_revoked/);
});
