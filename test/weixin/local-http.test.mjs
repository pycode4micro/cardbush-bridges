import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { localServiceFetch } from '../../src/shared/local-http.mjs';

test('direct local requests retain authentication and cancellation without following redirects', async () => {
  let leaked = false, received;
  const server = createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/must-not-follow' }).end(); return; }
    if (req.url === '/must-not-follow') leaked = true;
    if (req.url === '/wait') return;
    let text = ''; for await (const part of req) text += part;
    received = { token: req.headers.authorization, text };
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'unauthorized' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await localServiceFetch(base, { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: '中文 message' });
    assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'unauthorized');
    assert.deepEqual(received, { token: 'Bearer fixture', text: '中文 message' });
    await assert.rejects(localServiceFetch(base + '/redirect', { headers: { Authorization: 'Bearer fixture' } }), /unexpected_redirect/);
    assert.equal(leaked, false);
    await assert.rejects(localServiceFetch(base + '/wait', { signal: AbortSignal.timeout(30) }), { name: 'AbortError' });
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
