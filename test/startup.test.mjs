import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { terminalAsk } from '../src/shared/terminal.mjs';

test('readline renders the App ID and secret prompts after its own line clear and hides the secret', async () => {
  const previousTerm = process.env.TERM; process.env.TERM = 'xterm';
  const input = new PassThrough(); input.isTTY = true; let rendered = '';
  const output = new Writable({ write(chunk, _encoding, done) { rendered += chunk; done(); } });
  const terminal = terminalAsk({ input, output });
  const visible = () => { const clear = rendered.lastIndexOf('\x1b[0J'); return stripVTControlCharacters(clear < 0 ? rendered : rendered.slice(clear + 4)); };
  try {
    const app = terminal.ask('飞书 App ID：'); assert.match(visible(), /飞书 App ID：/);
    input.write('cli_fixture\r'); assert.equal(await app, 'cli_fixture');
    const secret = terminal.ask('飞书 App Secret（输入不显示）：', true); assert.match(visible(), /飞书 App Secret/);
    input.write('do-not-echo-secret\r'); assert.equal(await secret, 'do-not-echo-secret');
    assert.doesNotMatch(rendered, /do-not-echo-secret/);
  } finally { terminal.close(); input.destroy(); output.destroy(); if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm; }
});

for (const command of ['start', 'connect']) test(`real Feishu ${command} is discoverable before account configuration`, { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-unified-start-'));
  let pending, approved = false, child, output = '';
  const protocol = 'cardbush.webhook.v1';
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/discovery')) { res.end(JSON.stringify({ protocol, capabilities: ['local_pairing'] })); return; }
    if (req.method === 'POST') { let raw = ''; for await (const chunk of req) raw += chunk; pending = JSON.parse(raw); }
    res.end(JSON.stringify({ protocol, requestId: pending?.requestId, status: approved ? 'connected' : 'pending',
      ...(approved ? { connection: { endpoint: base + '/api/webhooks/v1/fixture/messages', token: 'a'.repeat(64), title: 'Chosen session' } } : {}) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    child = spawn(process.execPath, ['bin/cardbush-bridges.mjs', command, 'feishu'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', CARDBUSH_BRIDGES_DATA: root, CARDBUSH_FEISHU_DATA: '', CARDBUSH_WEBHOOK_URL: base, FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' } });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const exit = once(child, 'exit');
    for (let i = 0; i < 100 && !pending && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 40));
    assert.equal(pending?.name, '飞书服务', output); assert.equal(child.exitCode, null);
    await new Promise(r => setTimeout(r, 80)); assert.match(output, /连接服务/);
    assert.doesNotMatch(output, /正在验证飞书/);
    approved = true; const [code] = await exit;
    assert.equal(code, command === 'connect' ? 0 : 1, output);
    if (command === 'start') assert.match(output, /首次启动请在终端填写凭据/);
    const saved = JSON.parse(await readFile(join(root, 'feishu/config.json'), 'utf8'));
    assert.equal(saved.cardbush.url, base + '/api/webhooks/v1/fixture/messages'); assert.equal(saved.feishu, undefined);
    assert.doesNotMatch(output, /a{64}/);
  } finally {
    if (child?.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    server.closeAllConnections(); await new Promise(r => server.close(r));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true });
  }
});
