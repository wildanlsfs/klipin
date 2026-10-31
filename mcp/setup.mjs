#!/usr/bin/env node
// Pemasang Klipin MCP: mendaftarkan server Klipin ke AI agent yang terpasang di komputer ini
// (Claude Desktop, Claude Code, Cursor, Windsurf). Jalankan:  node setup.mjs     (hapus: node setup.mjs --hapus)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const remove = process.argv.includes('--hapus') || process.argv.includes('--uninstall');
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const NODE = process.execPath; // path lengkap: aplikasi GUI sering tidak mengenal PATH terminal
const home = os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

const entry = { command: NODE, args: [SERVER] };
const say = (...a) => console.log(...a);

// Klien yang memakai file JSON berisi { "mcpServers": { … } }
const JSON_CLIENTS = [
  {
    name: 'Claude Desktop',
    file: process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : process.platform === 'win32' ? path.join(appData, 'Claude', 'claude_desktop_config.json')
      : path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
  },
  { name: 'Cursor', file: path.join(home, '.cursor', 'mcp.json') },
  { name: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
];

function updateJson({ name, file }) {
  if (!fs.existsSync(path.dirname(file))) return null; // aplikasinya tidak terpasang
  let cfg = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      cfg = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return `⚠️  ${name}: file pengaturan rusak (${file}) — tidak diubah.`;
    }
    fs.writeFileSync(`${file}.sebelum-klipin.bak`, raw);
  }
  cfg.mcpServers ||= {};
  if (remove) {
    if (!cfg.mcpServers.klipin) return null;
    delete cfg.mcpServers.klipin;
  } else {
    cfg.mcpServers.klipin = entry;
  }
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return `✅ ${name}: ${remove ? 'Klipin dihapus' : 'Klipin terpasang'}`;
}

function claudeCode() {
  let has = true;
  try { execFileSync('claude', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }); } catch { has = false; }
  if (!has) return null;
  const run = (args) => execFileSync('claude', args, { stdio: 'pipe', shell: process.platform === 'win32' });
  try { run(['mcp', 'remove', '--scope', 'user', 'klipin']); } catch {}
  if (remove) return '✅ Claude Code: Klipin dihapus';
  try {
    run(['mcp', 'add', '--scope', 'user', 'klipin', '--', NODE, SERVER]);
    return '✅ Claude Code: Klipin terpasang';
  } catch (e) {
    return `⚠️  Claude Code: gagal (${String(e.stderr || e.message).trim().split('\n')[0]})`;
  }
}

say('');
say(remove ? '🎬 Menghapus Klipin dari AI agent…' : '🎬 Memasang Klipin ke AI agent di komputer ini…');
say('');
const results = [...JSON_CLIENTS.map(updateJson), claudeCode()].filter(Boolean);

if (!results.length) {
  say('Tidak ada aplikasi AI agent yang ditemukan (Claude Desktop, Claude Code, Cursor, Windsurf).');
  say('Pasang salah satunya dulu, misalnya Claude Desktop: https://claude.ai/download');
  say('Untuk aplikasi lain, tambahkan server MCP ini secara manual:');
  say(JSON.stringify({ mcpServers: { klipin: entry } }, null, 2));
  process.exitCode = 1;
} else {
  results.forEach((r) => say(r));
  say('');
  if (!remove) {
    say('Langkah terakhir:');
    say('  1. Tutup lalu buka lagi aplikasi AI agent-mu (Claude Desktop / Cursor) supaya Klipin terbaca.');
    say('  2. Buka Chrome, klik ikon Klipin, isi API key di ⚙︎ kalau belum.');
    say('  3. Minta agent-mu: "Pakai Klipin, buatkan video 3 menit tentang …"');
  }
}
say('');
