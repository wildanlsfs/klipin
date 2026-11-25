import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAudioPath, expandHome, makeServer, TOOLS, jobs, runTool } from '../mcp/server.mjs';

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

    // Reject /poll without extension Origin
    const noOrig = await fetch(`${base}/poll`, { headers: { 'x-klipin-client': 'panel-1' } });
    assert.equal(noOrig.status, 403);

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
