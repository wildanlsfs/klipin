# Klipin di server Proxmox (tanpa monitor)

Panduan menjalankan Klipin di Chrome yang berjalan terus di VM Proxmox, tanpa layar fisik, supaya video bisa dibuat otomatis oleh AI agent (MCP) tanpa membuat Mac/PC kamu sibuk.

> **Status:** panduan ini belum diuji langsung di Proxmox. Langkah-langkahnya disusun dari cara kerja Klipin dan Chrome. Kalau ada langkah yang beda di server kamu, catat dan perbaiki file ini.

## 1. Pilih pendekatan: jangan pakai headless murni

Klipin butuh hal-hal yang tidak ada di Chrome headless murni:

| Kebutuhan Klipin | Headless murni (`--headless`) | Chrome biasa di layar virtual (Xvfb) |
| --- | --- | --- |
| Extension MV3 dan side panel | Tidak stabil, side panel tidak ada | Jalan |
| Login Google untuk Flow (sekali, manual) | Sulit, tidak bisa klik | Bisa lewat VNC |
| Tab Flow harus tab aktif (Chrome memperlambat tab tersembunyi) | Rawan | Aman |
| Render MP4 di browser | Jalan tapi lambat | Jalan |

**Jadi:** jalankan Google Chrome *berlayar* di atas layar virtual **Xvfb**, dan lihat/atur lewat **VNC** kalau perlu. Ini yang disebut "headless" di panduan ini: server tanpa monitor, bukan flag `--headless`.

Klipin membuka dirinya sendiri di sebuah tab kalau side panel belum terbuka saat agent mulai bekerja (±30 detik), jadi side panel tidak perlu dibuka manual.

## 2. Siapkan VM di Proxmox

Pakai **VM**, bukan LXC. Chrome di LXC sering gagal karena sandbox dan `/dev/shm`.

| Item | Ukuran minimal | Disarankan |
| --- | --- | --- |
| OS | Debian 12 atau Ubuntu 24.04 | sama |
| CPU | 2 vCPU | 4 vCPU (render video) |
| RAM | 6 GB | 8 GB |
| Disk | 30 GB | 60 GB (hasil MP4 menumpuk) |
| CPU type | `host` | `host` |

Di Proxmox: Create VM, CPU type `host`, disk VirtIO, network `vmbr0`. Pasang OS tanpa desktop (server saja). Nyalakan juga *QEMU Guest Agent*.

Pastikan VM punya jam yang benar (`timedatectl`) dan zona waktu sesuai jadwal tayang kamu, mis. `sudo timedatectl set-timezone Asia/Makassar`.

## 3. Pasang paket dasar

```bash
sudo apt update
sudo apt install -y xvfb x11vnc openbox wget unzip curl fonts-noto fonts-noto-color-emoji \
  libnss3 libgbm1 libasound2
```

- `xvfb`: layar virtual. `openbox`: window manager ringan (Chrome butuh satu supaya fokus tab benar).
- `fonts-noto*`: supaya teks dan emoji di video tidak kotak-kotak.

Pasang Google Chrome stabil (Chrome 116 atau lebih baru, sesuai syarat Klipin):

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
google-chrome --version
```

Pasang Node.js LTS (untuk server MCP):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Buat user khusus supaya tidak jalan sebagai root:

```bash
sudo adduser --disabled-password --gecos "" klipin
```

## 4. Layar virtual dan VNC (systemd)

File `/etc/systemd/system/xvfb.service`:

```ini
[Unit]
Description=Xvfb layar virtual
After=network.target

[Service]
User=klipin
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp
Restart=always

[Install]
WantedBy=multi-user.target
```

File `/etc/systemd/system/openbox.service`:

```ini
[Unit]
Description=Openbox
After=xvfb.service
Requires=xvfb.service

[Service]
User=klipin
Environment=DISPLAY=:99
ExecStart=/usr/bin/openbox
Restart=always

[Install]
WantedBy=multi-user.target
```

File `/etc/systemd/system/x11vnc.service` (VNC hanya di `localhost`, diakses lewat SSH tunnel):

```ini
[Unit]
Description=x11vnc
After=xvfb.service
Requires=xvfb.service

[Service]
User=klipin
ExecStart=/usr/bin/x11vnc -display :99 -localhost -forever -shared -rfbport 5900 -passwd GANTI_PASSWORD_VNC
Restart=always

[Install]
WantedBy=multi-user.target
```

Ganti `GANTI_PASSWORD_VNC` dengan kata sandi kamu sendiri. Lalu:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xvfb openbox x11vnc
```

Dari komputer kamu, buka tunnel lalu sambungkan klien VNC (mis. layar bersama macOS: `vnc://localhost:5900`):

```bash
ssh -L 5900:localhost:5900 klipin@IP_VM
```

**Jangan buka port 5900 ke jaringan.** Siapa pun yang masuk VNC mengendalikan Chrome yang sudah login Google kamu.

## 5. Jalankan Chrome

File `/etc/systemd/system/chrome.service`:

```ini
[Unit]
Description=Chrome untuk Klipin
After=openbox.service
Requires=xvfb.service

[Service]
User=klipin
Environment=DISPLAY=:99
ExecStart=/usr/bin/google-chrome-stable \
  --user-data-dir=/home/klipin/chrome-profile \
  --no-first-run --no-default-browser-check \
  --disable-dev-shm-usage --window-size=1920,1080 --start-maximized \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Catatan:

- **Jangan** tambahkan `--no-sandbox` kecuali Chrome menolak jalan. Kalau terpaksa, ingat risikonya: Chrome ini membuka situs luar.
- `--user-data-dir` membuat login Google, data project Klipin, dan API key tersimpan antar restart. **Jangan salin folder ini ke tempat lain**: API key ada di `chrome.storage.local` di dalamnya.
- Tiga flag `--disable-*` mengurangi pelambatan tab yang tidak terlihat. Klipin tetap menjadikan tab Flow sebagai tab aktif saat membuat gambar.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chrome
```

## 6. Pasang Klipin (sekali, lewat VNC)

Chrome resmi versi baru (137+) tidak lagi mengizinkan `--load-extension`, jadi pasangnya manual sekali. Setelah itu tersimpan di profil.

1. Dari Mac, kirim ZIP rilis ke VM, atau download langsung di VM:
   ```bash
   sudo -u klipin bash -c 'mkdir -p ~/klipin && cd ~/klipin && \
     curl -L -o klipin.zip https://github.com/wildanlsfs/klipin/releases/latest/download/klipin-1.8.4.zip && unzip -o klipin.zip'
   ```
   Ganti nomor versi dengan yang terbaru di [Releases](https://github.com/wildanlsfs/klipin/releases/latest). Hasilnya ada di `~/klipin/klipin/`. Jalur ini yang dipasang di Chrome, jangan dihapus atau dipindah.
2. Sambung VNC. Di Chrome buka `chrome://extensions`, nyalakan **Developer mode**, klik **Load unpacked**, pilih `/home/klipin/klipin/klipin`.
3. Klik ikon Klipin, lalu ⚙︎ dan isi API key (Gemini untuk teks dan suara). Model bawaan: `gemini-3.8-flash`.
4. Buka <https://flow.google.com>, **login Google lewat VNC** (manual, jangan lewat skrip), lalu buka satu project Flow dan biarkan tab itu terbuka.
5. Uji manual satu video pendek dari panel sebelum menyerahkan ke agent.

Update: ganti isi `~/klipin/klipin/` dengan ZIP baru, lalu klik ↻ di `chrome://extensions`.

## 7. Hubungkan AI agent (MCP)

Klipin punya server MCP (`mcp/server.mjs`) yang menjembatani agent dan panel. Server ini hanya mendengar di loopback (port `47816`) di dalam VM, jadi agent harus berjalan **di VM yang sama**.

```bash
sudo npm install -g @anthropic-ai/claude-code
sudo -u klipin claude          # login sekali, ikuti petunjuk di layar
```

Daftarkan server MCP Klipin:

```bash
sudo -u klipin claude mcp add klipin -- node /home/klipin/klipin/klipin/mcp/server.mjs
```

Cek: tombol 🤖 di panel Klipin berpindah ke titik hijau saat agent terhubung. Tes cepat:

```bash
sudo -u klipin claude -p "Pakai Klipin: tampilkan status project saat ini" \
  --allowedTools "mcp__klipin"
```

Jangan mengimpor atau menjalankan `server.mjs` dua kali sekaligus. Satu proses saja yang memegang port 47816.

### Upload ke YouTube

Klipin hanya menyiapkan MP4, judul, deskripsi, dan thumbnail. Pengunggahan ke YouTube Studio di setup otomatis kamu sekarang memakai Claude in Chrome (`--chrome`). Di VM, pasang extension Claude in Chrome di profil Chrome yang sama dan login di sana lewat VNC, atau unggah dari tempat lain.

## 8. Jadwal otomatis (opsional)

Contoh timer systemd yang menjalankan skrip produksi, satu proses sekaligus dengan kunci `mkdir`:

```ini
# /etc/systemd/system/klipin-harian.service
[Service]
User=klipin
Environment=DISPLAY=:99
WorkingDirectory=/home/klipin/Klipin-Otomatis
ExecStart=/bin/bash run.sh

# /etc/systemd/system/klipin-harian.timer
[Timer]
OnCalendar=*-*-* 05:30:00
OnCalendar=*-*-* 10:30:00
OnCalendar=*-*-* 17:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now klipin-harian.timer
```

`run.sh` dari Mac memakai `caffeinate`, yang tidak ada di Linux. Hapus awalan `/usr/bin/caffeinate -i` dan ganti jalur `claude` sesuai hasil `which claude`.

## 9. Pantau dan rawat

- Lihat Chrome sedang apa: sambung VNC. Atau tangkap layar: `sudo -u klipin DISPLAY=:99 import -window root /tmp/layar.png` (butuh `imagemagick`).
- Log: `journalctl -u chrome -f`, log agent di folder `log/`.
- Snapshot VM di Proxmox **setelah** Chrome login dan Klipin siap, supaya bisa dikembalikan kalau profil rusak.
- Hasil MP4 menumpuk: hapus berkala yang sudah diunggah.
- Jangan reload panel Klipin saat satu proses sedang berjalan.

## 10. Masalah umum

| Gejala | Penyebab dan solusi |
| --- | --- |
| Chrome langsung mati, log `sandbox` atau `shm` | Pastikan VM (bukan LXC), `--disable-dev-shm-usage` aktif, user bukan root. `--no-sandbox` hanya jalan darurat |
| Tombol 🤖 tidak hijau | Server MCP belum jalan atau jalan dua kali. Cek `ss -ltnp \| grep 47816`, hentikan yang dobel |
| "Google Flow tidak terhubung" | Tab Flow belum terbuka di Chrome yang sama atau sesi Google keluar. Login ulang lewat VNC |
| Gambar Flow sangat lambat | Tab tidak jadi tab aktif atau CPU kecil. Tambah vCPU dan pastikan hanya satu jendela Chrome |
| Render MP4 lama atau macet | Tanpa GPU, render memakai CPU. Naikkan ke 4 vCPU, RAM 8 GB |
| Teks video kotak-kotak | Pasang `fonts-noto` dan `fonts-noto-color-emoji`, lalu restart Chrome |
| Google minta verifikasi saat login dari IP server | Login dari VNC sambil sesi lain terbuka di perangkat biasa; jangan memakai VPN yang sering berganti |
| Extension hilang setelah update Chrome | Folder Klipin dipindah atau dihapus. Kembalikan ke jalur lama lalu ↻ |

## 11. Keamanan

- API key hanya di `chrome.storage.local` di profil VM. Jangan simpan di file skrip atau repo.
- VNC dan port 47816 jangan dibuka ke luar VM. Akses lewat SSH tunnel.
- Pakai satu akun Google khusus untuk Flow di server jika memungkinkan.
- Otomasi Google Flow membaca tampilan halaman; patuhi ketentuan layanan Google Flow.
