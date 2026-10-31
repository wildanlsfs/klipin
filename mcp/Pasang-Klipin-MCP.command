#!/bin/bash
# Klik dua kali file ini (Mac) untuk memasang Klipin ke AI agent (Claude Desktop, Claude Code, Cursor).
cd "$(dirname "$0")"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js belum terpasang. Halaman download akan dibuka:"
  echo "  pilih versi LTS, pasang seperti aplikasi biasa, lalu klik dua kali file ini lagi."
  open "https://nodejs.org/id/download"
  echo ""
  read -r -p "Tekan Enter untuk menutup…"
  exit 1
fi
node setup.mjs "$@"
read -r -p "Tekan Enter untuk menutup…"
