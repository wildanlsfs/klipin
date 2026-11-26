import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAudioPath, expandHome, makeServer, TOOLS, jobs, runTool, coerceArgs, rpc, mcpToken } from '../mcp/server.mjs';

test('expandHome only expands ~ or ~/ paths', () => {
  assert.equal(expandHome('~/Downloads'), path.join(os.homedir(), 'Downloads'));
  assert.equal(expandHome('~user/foo'), '~user/foo');
});

test('resolveAudioPath ignores broken symlinks and picks newest valid audio file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipin-audio-'));
  try {
    fs.symlinkSync('/nonexistent/target.wav', path.join(dir, 'broken.wav'));
    const good = path.join(dir, 'voice.wav');
    fs.writeFileSync(good, 'RIFF');
    assert.equal(resolveAudioPath(dir), good);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp/manifest.json tools match server TOOLS and versions match manifest.json', () => {
  const extManifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const mcpManifest = JSON.parse(fs.readFileSync(new URL('../mcp/manifest.json', import.meta.url), 'utf8'));
  assert.equal(extManifest.version, mcpManifest.version);
  assert.deepEqual(
    mcpManifest.tools.map((t) => t.name).sort(),
    TOOLS.map((t) => t.name).sort(),
  );
});

function rawRequest(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTTP bridge enforces Host and Extension Origin checks, streams /audio/<token>, and cleans up job args on finish', async () => {
  const srv = makeServer('test-secret', 0);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipin-srv-'));
  const wavFile = path.join(tmpDir, 'clip.wav');
  fs.writeFileSync(wavFile, 'RIFFTEST');
  try {
    // Reject DNS-rebinding Host (via raw http.request so Host header is sent verbatim)
    const badHost = await rawRequest(port, '/state', { Host: 'evil.com:1234', 'x-klipin-client': 'bg' });
    assert.equal(badHost.status, 403);

    // Allow background /state without Origin
    const st = await fetch(`${base}/state`, { headers: { 'x-klipin-client': 'background' } });
    assert.equal(st.status, 200);

    // Reject /poll with a non-extension Origin, and without the client header
    const webOrig = await fetch(`${base}/poll`, { headers: { Origin: 'https://evil.example', 'x-klipin-client': 'panel-1' } });
    assert.equal(webOrig.status, 403);
    const noClient = await fetch(`${base}/poll`, { headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
    assert.equal(noClient.status, 403);

    // Trigger klipin_load_audio, poll it from extension origin, stream /audio/<token>, and finish
    const extOrig = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const toolPromise = runTool('klipin_load_audio', { path: wavFile });
    const pollRes = await fetch(`${base}/poll`, { headers: { Origin: extOrig, 'x-klipin-client': 'panel-1' } });
    assert.equal(pollRes.status, 200);
    const { job } = await pollRes.json();
    assert.equal(job.tool, 'klipin_load_audio');
    assert.ok(job.args.token);
    assert.equal(job.args.base64, undefined);

    const audioRes = await fetch(`${base}/audio/${job.args.token}`, { headers: { Origin: extOrig, 'x-klipin-client': 'panel-1' } });
    assert.equal(audioRes.status, 200);
    assert.equal(await audioRes.text(), 'RIFFTEST');

    const res = await fetch(`${base}/result`, {
      method: 'POST',
      headers: { Origin: extOrig, 'x-klipin-client': 'panel-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.id, ok: true, text: 'loaded' }),
    });
    assert.equal(res.status, 200);

    const toolOut = await toolPromise;
    assert.equal(toolOut.content[0].text, 'loaded');
    assert.equal(jobs.get(job.id).args, null);
  } finally {
    srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('coerceArgs memperbaiki tipe yang salah dari model kecil', () => {
  assert.deepEqual(coerceArgs('klipin_edit_scene', { scene: '3' }).scene, 3);
  assert.deepEqual(coerceArgs('klipin_images', { scenes: '[1,2]' }).scenes, [1, 2]);
  assert.deepEqual(coerceArgs('klipin_images', { scenes: '1, 2' }).scenes, [1, 2]);
  assert.equal('idea' in coerceArgs('klipin_new_project', { idea: null }), false);
});

test('skema tool kompatibel luas: tanpa required kosong', () => {
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(!('required' in t.inputSchema) || t.inputSchema.required.length > 0, t.name);
  }
});

test('rpc: initialize, tools/list, notifikasi, method tak dikenal', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(init.result.serverInfo.name, 'klipin');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, TOOLS.length);
  assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'zzz' })).error.code, -32601);
});

test('endpoint HTTP /mcp: wajib bearer token, menolak Origin browser', async () => {
  const secret = 'rahasia-tes';
  const srv = makeServer(secret, 0);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const post = (headers, body) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const msg = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    assert.equal((await post({}, msg)).status, 401);
    assert.equal((await post({ authorization: 'Bearer salah' }, msg)).status, 401);
    assert.equal((await post({ authorization: `Bearer ${mcpToken(secret)}`, origin: 'https://evil.example' }, msg)).status, 403);
    const ok = await post({ authorization: `Bearer ${mcpToken(secret)}` }, msg);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.tools.length, TOOLS.length);
    assert.equal((await post({ authorization: `Bearer ${mcpToken(secret)}` }, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  } finally {
    srv.close();
  }
});

test('endpoint panel: tanpa Origin boleh bila ada header klien; Origin web biasa & tanpa header ditolak', async () => {
  const srv = makeServer('rahasia-tes', 0);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (p, headers) => fetch(`http://127.0.0.1:${port}${p}`, { headers });
  try {
    assert.equal((await get('/state', { 'x-klipin-client': 'uji' })).status, 200);
    assert.equal((await get('/audio/tidak-ada', { 'x-klipin-client': 'uji' })).status, 404); // lolos origin, token tak ada
    assert.equal((await get('/audio/tidak-ada', {})).status, 403);
    assert.equal((await get('/audio/tidak-ada', { 'x-klipin-client': 'uji', origin: 'https://evil.example' })).status, 403);
    assert.equal((await get('/poll', { 'x-klipin-client': 'uji', origin: 'https://evil.example' })).status, 403);
  } finally {
    srv.close();
  }
});
