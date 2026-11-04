import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

for (const command of ['login', 'login-start']) test(`${command} appears in Cardbush before displaying a QR code`, { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-cli-onboarding-'));
  const protocol = 'cardbush.webhook.v1'; let pending, approved = false, qrCalls = 0, child, output = '';
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/fixture/qr-requested') { qrCalls++; res.end('{}'); return; }
    if (req.url.endsWith('/discovery')) { res.end(JSON.stringify({ protocol, capabilities: ['local_pairing'] })); return; }
    if (req.method === 'POST') { let body = ''; for await (const part of req) body += part; pending = JSON.parse(body); }
    res.end(JSON.stringify({ protocol, requestId: pending?.requestId, status: approved ? 'connected' : 'pending',
      ...(approved ? { connection: { endpoint: base + '/api/webhooks/v1/fixture/messages', token: 'a'.repeat(64), title: 'Chosen conversation' } } : {}) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    child = spawn(process.execPath, ['--import', pathToFileURL(resolve('test/weixin/fixtures/cli-fetch.mjs')).href, 'bin/cardbush-bridges.mjs', command, 'weixin'], {
      cwd: process.cwd(), windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '',
        CARDBUSH_WEIXIN_DATA: root, CARDBUSH_WEBHOOK_URL: base }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const exited = once(child, 'exit');
    for (let i = 0; i < 120 && !pending && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(pending, output); assert.equal(pending.name, '微信服务');
    await new Promise(r => setTimeout(r, 150));
    assert.match(output, /连接服务/); assert.equal(qrCalls, 0, 'QR login cannot skip Cardbush connection approval');
    approved = true;
    assert.equal((await exited)[0], 0, output);
    assert.equal(qrCalls, 1); assert.match(output, /已连接 Cardbush 会话/); assert.match(output, /请用微信扫描二维码/);
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
    assert.equal(saved.cardbush.url, base + '/api/webhooks/v1/fixture/messages'); assert.equal(saved.pairing, undefined);
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true });
  }
});
