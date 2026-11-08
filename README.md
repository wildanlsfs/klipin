# Klipin 🎬 (Chrome extension, MV3)

Judul → naskah → suara → scene → gambar otomatis di Google Flow → render MP4, semua dari side panel Chrome.
Gratis & open source (MIT). Tidak ada server: semua proses (potong jeda, sinkronisasi, render video) berjalan di browser kamu.

## Tutorial video (1,5 menit)
[![Tonton tutorial Klipin](docs/tutorial-thumb.jpg)](https://github.com/wildanlsfs/klipin/releases/download/v1.8.4/klipin-tutorial.mp4)

Klik gambar di atas untuk menonton / download video tutorial (MP4, 85 detik, versi 1.8): pasang dari Releases,
isi API key, lalu 6 langkah sampai video jadi dan siap diunggah ke YouTube.

## Pasang
1. Download `klipin-<versi>.zip` dari [Releases](https://github.com/wildanlsfs/klipin/releases/latest)
   (atau tombol hijau **Code → Download ZIP**, atau `git clone https://github.com/wildanlsfs/klipin.git`), lalu **ekstrak**
   ke tempat tetap, mis. `Documents/Klipin`. Jangan dihapus atau dipindah setelah dipasang.
2. Buka `chrome://extensions` → aktifkan **Developer mode** (kanan atas) → **Load unpacked** → pilih folder yang
   **langsung berisi `manifest.json`**.
   - Windows sering membuat folder ganda saat ekstrak (mis. `klipin-1.8.3\klipin\manifest.json`); pilih folder yang di dalam.
3. Klik ikon Klipin → side panel terbuka. Isi minimal satu API key di ⚙︎
   (Gemini gratis: https://aistudio.google.com/apikey). Model bawaan Gemini: `gemini-3.8-flash`.
4. **Update:** saat ada versi baru, bilah hijau muncul di panel. Klik **Download update**, timpa folder lama dengan isi ZIP
   yang baru, lalu klik **Muat ulang Klipin** (atau ↻ di `chrome://extensions`). Pengaturan, API key, dan proyek tidak hilang.

Butuh Chrome 116+ (desktop). Untuk langkah gambar perlu akun Google Flow (https://flow.google.com).

## 🤖 Pakai lewat AI agent (Claude, Cursor, …)
Klipin bisa dikendalikan AI agent lewat MCP. Kamu cukup bilang:
*"Pakai Klipin, buatkan video 3 menit tentang budidaya lele untuk pemula"*, lalu agent menulis naskah,
membuat scene, menyuruh Google Flow membuat gambar, me-render MP4, sampai menyiapkan judul, deskripsi, dan thumbnail.

**Pasang (sekali saja):**
- **Claude Desktop** (paling mudah, tidak perlu install apa-apa lagi):
  1. Download **`klipin.mcpb`** dari halaman [Releases](https://github.com/wildanlsfs/klipin/releases/latest).
  2. Klik dua kali file itu → Claude Desktop terbuka → klik **Install**.
- **Claude Code, Cursor, Windsurf**: butuh [Node.js](https://nodejs.org/id/download) (versi LTS). Buka folder `mcp` di folder Klipin,
  lalu klik dua kali **`Pasang-Klipin-MCP.command`** (Mac) atau **`Pasang-Klipin-MCP.bat`** (Windows). Skrip ini mendaftarkan
  Klipin ke semua aplikasi yang ditemukan. Tutup lalu buka lagi aplikasinya.
  - Mac menolak membuka file? Klik kanan → **Open** → **Open**.
  - Cara manual (aplikasi lain): `node /path/ke/klipin/mcp/server.mjs` sebagai server MCP stdio.

**Pakai:**
1. Buka Chrome, klik ikon Klipin. Tombol 🤖 di panel memberi titik hijau saat agent terhubung.
   (Kalau panel belum terbuka saat agent mulai bekerja, Klipin membukanya sendiri di tab dalam ±30 detik.)
2. Untuk gambar: buka sebuah project di [Google Flow](https://flow.google.com).
3. Suara: agent bisa membuat suara via API (kalau key TTS diisi), atau kamu buat gratis di Google AI Studio lalu
   beri tahu agent lokasi filenya (mis. *"audionya di Downloads/lele.wav"*). Cukup *"audionya di Downloads"*
   juga bisa: agent mengambil file audio terbaru yang di-download dalam 30 menit terakhir.
4. Hasil MP4 & thumbnail tersimpan di folder **Downloads/Klipin**.

Keamanan: server hanya mendengarkan di `127.0.0.1` dan hanya menerima permintaan dari extension Klipin.
API key tetap di extension dan tidak dikirim ke agent. Matikan kapan saja lewat 🤖 → centang "Izinkan AI agent".

## Privasi
- API key disimpan hanya di `chrome.storage.local` di komputermu dan hanya dikirim ke provider yang kamu pilih.
- Project (naskah, audio, gambar) disimpan di IndexedDB browser kamu. Tidak ada data yang dikirim ke server pembuat extension.

## Multi provider (⚙︎ di side panel, atau halaman Options: klik kanan ikon → Options)
- **Provider teks:** Gemini + sebanyak apa pun endpoint OpenAI-compatible. Preset: OpenAI, OpenRouter, Groq, DeepSeek,
  9Router, Ollama (lokal), Custom. Dropdown model terisi otomatis dari `/models` provider begitu key diisi (↻ untuk muat ulang, atau pilih "Ketik manual…").
- **Tugas → provider:** judul, naskah, prompt scene, dan transkrip masing-masing bisa memakai provider berbeda.
- **Cadangan otomatis:** kalau provider gagal (kuota, error, JSON rusak), pindah ke provider lain yang siap.
- **Transkrip:** Gemini, atau provider dengan *model transkrip* Whisper (OpenAI `whisper-1`, Groq `whisper-large-v3`).
- **Suara (TTS):** Gemini, provider dengan *model TTS* (OpenAI `gpt-4o-mini-tts` — ikut style instruction), atau ElevenLabs
  (daftar suara diambil dari akunmu). TTS tidak memakai cadangan otomatis supaya suara narator tidak berganti di tengah video.
- Ollama: jalankan dengan `OLLAMA_ORIGINS="chrome-extension://*"`.

## Aturan prompt & gaya visual (⚙︎ → ✍️ Aturan prompt / 🎨 Gaya visual)
- **Aturan naskah**, **aturan prompt gambar**, dan **aturan thumbnail** bisa dimatikan, diubah teksnya, atau ditambah aturan sendiri.
  Aturan naskah bawaan antara lain:
  - pembuka 3 detik dan inti dalam 10 detik; padat informasi; enak dibacakan TTS;
  - **pertanyaan komentar**: di Shorts diletakkan di akhir setelah jawaban (tidak menyela hitungan), di video panjang di sepertiga awal;
  - **jalan keluar, bukan hanya masalah**: kalau hitungan berujung tipis/rugi, naskah memberi cara konkret supaya untung;
  - **tanpa kata pamitan** ("Sekian…", "Terima kasih sudah menonton"); ajakan penutup; loop ke pembuka (Shorts);
    jembatan ke topik berikutnya (video panjang).
- **Aturan prompt gambar** bawaan termasuk tokoh berulang dengan ciri tetap (pihak yang merugikan digambar sebagai antagonis
  yang mudah dikenali) supaya gambar antar scene konsisten.
- **Gaya visual:** prompt gaya bawaan bisa diganti, dan kamu bisa menambah gaya sendiri (muncul di pilihan langkah 3 dan di `klipin_options`).
- Sebagian aturan bawaan hanya berlaku untuk Shorts (< 2 menit, mis. loop ke pembuka) atau video panjang
  (bagian jelas untuk bab, pancingan berkala).
- ↺ mengembalikan teks bawaan. Aturan bawaan yang tidak kamu ubah ikut diperbarui saat Klipin update.

## Alur
1. **Judul** – ketik ide / pilih dari 100 ide → *Kembangkan Judul* (atau pakai judul sendiri).
2. **Naskah** – pilih format, gaya narasi, durasi, bahasa → *Tulis Naskah*.
   Suara: *Buka Google AI Studio* (naskah otomatis tersalin), salin style instruction, pilih suara, Run, download,
   lalu tarik file audio ke kotak "Tarik file audio". Alternatif: *generate langsung via Gemini API*.
3. **Scene** – pilih gaya visual & rasio. Jeda/diam dipotong otomatis. *Buat scene dari naskah* (waktu tiap kalimat
   diselaraskan ke jeda nyata di audio; 3–12 detik per gambar, ±4 detik untuk Shorts supaya gambar berganti cepat) atau *Transkrip otomatis + buat scene* (kalau naskah berbeda dari yang dibacakan).
   *🔁 Sinkronkan ulang* menghitung ulang waktu gambar & subtitle tanpa mengubah gambar. Prompt gambar dibuat AI per batch.
4. **Gambar** – buka sebuah project di Google Flow (flow.google.com) → *Kirim Semua ke Flow*. Klipin otomatis mengatur Flow ke mode langsung
   (bukan Agen), **Gambar**, rasio proyek, dan **x1** gambar per prompt.
   Extension mengetik prompt, mengirim (dan mengulang kalau Flow masih sibuk), menunggu, lalu menarik gambar ke panel.
   Bawaannya **5 prompt sekaligus** (pilihan "Kirim sekaligus" 1–5); tiap gambar dicocokkan ke scene lewat teks prompt-nya
   (±10 menit untuk 46 gambar). Tab Flow dijadikan tab aktif selama proses karena Chrome memperlambat tab yang tersembunyi.
   Kalau Flow tetap membuat 2+ gambar per prompt, semuanya disimpan — klik **⇄** di gambar untuk memilih. Scene gagal → ↻ atau ⬆ upload manual.
5. **Render** – resolusi 1080/720, FPS 24/30, subtitle, dan **teks hook besar di 2 detik pertama** (angka/kontras inti dari kalimat
   pembuka; tiap angka diberi label, mis. "HARGA Rp25 RB | IKAN Rp5 RB"; kosongkan supaya diusulkan AI), dan **catatan angka di layar** (kartu kecil yang muncul
   saat narator menyebut angka penting, mis. "Modal Rp25 JT" atau "Rp100 RB → Rp60 RB"; diusulkan AI, bisa diedit `nomor scene: teks`) → *Render MP4* (pilih lokasi simpan). Encode H.264 + AAC via WebCodecs,
   ±115 fps di 1080p (video 3 menit ≈ 40–50 detik).
6. **YouTube** – *Buat Judul, Deskripsi & Thumbnail*: 5 pilihan judul (≤70 karakter), deskripsi siap tempel dengan hook,
   **bab/timestamp otomatis dari waktu scene**, hashtag, dan tag (≤500 karakter). Thumbnail (16:9 → 1280×720, Shorts 9:16 → 1080×1920):
   pilih **jenis thumbnail** (⭐ = cocok untuk format cerita proyek): Dua Hasil Bertolak Belakang, Ekspresi Kaget, Angka Besar,
   Objek Misterius, Momen Klimaks, Potret Tokoh, atau Nomor Satu Tersembunyi. *Buat konsep thumbnail* membuat satu konsep per jenis
   (ide, teks 2–4 kata, prompt gambar) dari naskah, format, gaya narasi, dan gaya visual proyek; *Buat gambar* membuat latarnya di Flow
   (1 kredit per gambar, beberapa konsep sekaligus). Bandingkan pratinjaunya, ubah teksnya, lalu *Pakai*. Aturan konsep bisa diatur di
   ⚙︎ Pengaturan → Aturan prompt → Thumbnail. Teks, posisi (termasuk *Dua sisi* "A | B"), warna, dan latar tetap bisa diatur manual
   → *Download Thumbnail (JPG)*.

## Mengatasi masalah
- **"models/gemini-2.5-flash is no longer available to new users"**: Google menutup model Gemini 2.5 untuk akun baru.
  Update ke 1.8.3+ (pindah model otomatis), atau ⚙︎ Pengaturan → Gemini → model `gemini-3.8-flash` → Simpan.
- **Tombol ⚙︎ tidak bisa ditekan** (versi 1.6.0–1.8.1): update ke 1.8.2+ lewat bilah hijau **Download update**.
- **"Manifest file is missing or unreadable"** saat Load unpacked: folder yang dipilih salah. Pilih folder yang langsung berisi
  `manifest.json` (lihat langkah Pasang).
- **Kuota Gemini habis / "limit: 0"**: model Pro tidak tersedia untuk API key gratis. Pakai model Flash, tunggu kuota pulih,
  atau tambah provider lain (Groq/OpenRouter) di ⚙︎ sebagai cadangan.
- **Panel tidak berubah setelah update**: pastikan folder yang ditimpa sama dengan yang terpasang di `chrome://extensions`, lalu ↻.
- **Google Flow tidak terhubung**: buka sebuah project di flow.google.com di tab Chrome yang sama, lalu kirim ulang.

## Struktur
- `sidepanel.html/css`, `js/app.js` – UI & alur
- `options.html`, `js/settings-ui.js` – UI pengaturan (dipakai side panel & Options)
- `js/llm.js` – multi provider, cadangan otomatis, daftar model, TTS (Gemini/OpenAI/ElevenLabs), transkrip (Gemini/Whisper)
- `js/audio.js` – decode, potong jeda, WAV
- `js/scenes.js` – pembagian scene, penyelarasan kalimat ↔ jeda audio, subtitle
- `js/render.js` – render MP4 (lib/mp4-muxer.mjs, MIT)
- `content/flow.js` – otomasi Google Flow
- `js/agent.js`, `mcp/` – jembatan & server MCP untuk AI agent (`mcp/server.mjs` tanpa dependensi)

## Catatan
- Proyek independen, tidak berafiliasi dengan Google. Otomasi Google Flow membaca tampilan halaman Flow,
  jadi bisa rusak kalau Google mengubah tampilannya — laporkan lewat *Issues*. Patuhi ketentuan layanan Google Flow
  dan provider AI yang kamu pakai.
- Pakai dengan bijak: biaya/kuota API ditanggung akun masing-masing.

## Lisensi
MIT — lihat `LICENSE`. `lib/mp4-muxer.mjs` © Vanilagy, MIT (`lib/mp4-muxer.LICENSE`).
