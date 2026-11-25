// Handler tool untuk Klipin MCP server (mcp/server.mjs).
import { FORMATS, NARRATION_STYLES, DURATIONS, WPM, RATIOS, VOICES, AI_STUDIO_TTS_URL, FLOW_URL, THUMB_TYPES } from './data.js';
import * as llm from './llm.js';
import * as audioLib from './audio.js';
import { fmtTime } from './scenes.js';
import { errMsg } from './dom.js';
import { ensureFlowProject, runFlowBatch, generateConceptImages, generateThumbBgInFlow } from './flow-client.js';
import { synthesizeViaAiStudio } from './aistudio-client.js';
import { THUMB_COLORS, currentBg, thumbBlob, thumbPreviewBase64, thumbType } from './thumbnail.js';
import { runFullPipeline, safeName } from './pipeline.js';

const pickId = (list, id, what) => {
  if (id == null || id === '') return null;
  const hit = list.find((x) => String(x.id) === String(id));
  if (!hit) throw new Error(`${what} "${id}" tidak dikenal. Pilihan: ${list.map((x) => x.id).join(', ')}`);
  return hit.id;
};

export function createAgentTools(ctx) {
  function statusText() {
    const S = ctx.getState();
    const settings = ctx.getSettings();
    const a = ctx.currentAudio();
    const imgs = S.scenes.filter((x) => x.image).length;
    const ready = llm.providers(settings).filter((p) => p.ready).map((p) => p.name);
    const tts = llm.ttsEngines(settings).filter((e) => e.ready).map((e) => e.id);
    const words = S.script.trim() ? S.script.trim().split(/\s+/).length : 0;
    return [
      `Judul: ${S.title || '—'}${S.rawTitle && S.rawTitle !== S.title ? ` (ide: ${S.rawTitle})` : ''}`,
      `Bahasa: ${S.lang} · format: ${S.format} · gaya narasi: ${S.narrStyle} · durasi target: ${S.minutes} menit`,
      `Naskah: ${words ? `${words} kata` : 'belum ada'}`,
      `Audio: ${a ? `${fmtTime(audioLib.duration(a))}${ctx.getAudioTrim() ? ' (jeda sudah dipotong)' : ''}` : 'belum ada'}`,
      `Gaya visual: ${S.visualStyle} · rasio ${S.ratio} · ±${S.sceneSec} detik/scene`,
      `Scene: ${S.scenes.length} · prompt ${S.scenes.filter((x) => x.prompt).length} · gambar ${imgs}/${S.scenes.length}`,
      `Paket Publish: ${S.yt?.desc ? 'sudah' : 'belum'}`,
      `AI siap: ${ready.join(', ') || 'BELUM ADA — pengguna perlu mengisi API key di ⚙︎ Klipin'} · TTS API: ${tts.join(', ') || 'tidak ada (bisa pakai klipin_aistudio_voice)'}`,
    ].join('\n');
  }

  return {
    async status() {
      const flow = await ctx.connectFlow();
      return { text: `${statusText()}\nGoogle Flow: ${flow.ok ? 'terhubung' : flow.reason}` };
    },

    async options() {
      const S = ctx.getState();
      const settings = ctx.getSettings();
      const fmt = ctx.fmtStyle();
      const ttsLines = llm.ttsEngines(settings).map((e) => `${e.id}${e.ready ? '' : ' (belum dikonfigurasi)'}`);
      return {
        text: [
          `format: ${FORMATS.map((f) => `${f.id} (${f.label})`).join(', ')}`,
          `narration_style: ${NARRATION_STYLES.map((n) => `${n.id} (${n.label})`).join(', ')}`,
          `visual_style: ${llm.visualStyles(settings).map((v) => `${v.id} (${v.label})`).join(', ')}`,
          `ratio: ${RATIOS.map((r) => r.id).join(', ')}`,
          `minutes: ${DURATIONS.join(', ')}`,
          `thumbnail types (klipin_thumb_concepts; ⭐ = cocok untuk format proyek ini): ${THUMB_TYPES.map((t) => `${t.id}${ctx.recommendedTypes().includes(t.id) ? '⭐' : ''} (${t.label})`).join(', ')}`,
          `TTS engine: ${ttsLines.join(', ')}, aistudio (gratis otomatis via tab Google AI Studio)`,
          `Model AI per tugas (⚙︎ Pengaturan; fallback ${settings.fallback ? 'aktif' : 'mati'}): ${Object.entries(llm.TASKS).map(([k, label]) => {
            const id = settings.tasks?.[k] || 'gemini';
            const c = (settings.compat || []).find((x) => x.id === id);
            const model = id === 'gemini' ? settings.gemini?.model : c?.model;
            return `${label} → ${c?.name || id} (${model || 'model belum diisi'})`;
          }).join('; ')}; model suara Gemini: ${settings.gemini?.ttsModel}`,
          `Suara Gemini: ${VOICES.map((v) => `${v.name} (${v.gender === 'L' ? 'pria' : 'wanita'}, ${v.desc})`).join('; ')} (atau nama/ID suara baru)`,
          `Suara OpenAI: ${llm.OPENAI_VOICES.map((v) => v.id).join(', ')} (atau nama/ID suara custom)`,
          `Aturan naskah aktif (⚙︎ Pengaturan; durasi proyek ini ${S.minutes} menit):\n${llm.scriptRules(settings, S.minutes, S.loop, fmt.skipRules).map((r) => `- ${r.text.trim()}`).join('\n')}`,
        ].join('\n'),
      };
    },

    async new_project({ idea, lang }) {
      await ctx.resetProject();
      const S = ctx.getState();
      if (lang) S.lang = lang === 'en' ? 'en' : 'id';
      if (idea) S.rawTitle = S.title = String(idea).trim();
      ctx.initUI();
      ctx.go(1);
      return { text: `Proyek baru dibuat.${idea ? ` Ide: ${idea}` : ''}` };
    },

    async titles({ idea, lang }) {
      const S = ctx.getState();
      const settings = ctx.getSettings();
      ctx.go(1);
      if (lang) S.lang = lang === 'en' ? 'en' : 'id';
      if (idea) S.rawTitle = String(idea).trim();
      const raw = S.rawTitle.trim() || S.title;
      if (!raw) throw new Error('Beri `idea` (ide/judul mentah).');
      S.titleOptions = await llm.expandTitle(settings, raw, S.lang);
      S.title = S.titleOptions[0] || raw;
      ctx.initUI();
      ctx.save();
      return { text: `Pilihan judul (yang pertama dipilih):\n${S.titleOptions.map((t, k) => `${k + 1}. ${t}`).join('\n')}` };
    },

    async set_title({ title }) {
      const S = ctx.getState();
      S.title = String(title || '').trim();
      if (!S.title) throw new Error('Judul kosong.');
      if (!S.rawTitle) S.rawTitle = S.title;
      ctx.initUI();
      ctx.save();
      return { text: `Judul: ${S.title}` };
    },

    async write_script({ format, narration_style, minutes, lang, loop, script }, progress) {
      const S = ctx.getState();
      const settings = ctx.getSettings();
      ctx.go(2);
      S.format = pickId(FORMATS, format, 'format') || S.format;
      const ns = pickId(NARRATION_STYLES, narration_style, 'narration_style');
      if (ns && ns !== S.narrStyle) { S.narrStyle = ns; S.styleInstrEdited = false; }
      if (minutes) S.minutes = Number(minutes);
      if (typeof loop === 'boolean') { S.loop = loop; ctx.refreshStyleInstr(); }
      if (lang) S.lang = lang === 'en' ? 'en' : 'id';
      if (script) {
        S.script = String(script).trim();
      } else {
        const title = S.title || S.rawTitle;
        if (!title) throw new Error('Judul masih kosong — panggil klipin_titles atau klipin_set_title dulu.');
        progress('menulis naskah…');
        S.script = await llm.writeScript(settings, {
          title, format: ctx.fmtStyle(), style: ctx.narrStyle(), minutes: S.minutes, lang: S.lang,
          wpm: WPM[S.lang] || 150, loop: S.loop, onProgress: progress,
        });
      }
      ctx.initUI();
      ctx.save();
      const words = S.script.split(/\s+/).length;
      return { text: `Naskah (${words} kata, ±${(words / (WPM[S.lang] || 150)).toFixed(1)} menit):\n\n${S.script}\n\nStyle instruction suara: ${S.styleInstr}` };
    },

    async voice({ engine, voice }, progress) {
      const S = ctx.getState();
      const settings = ctx.getSettings();
      ctx.go(2);
      if (!S.script.trim()) throw new Error('Naskah masih kosong — panggil klipin_write_script dulu.');
      if (engine) S.ttsEngine = pickId(llm.ttsEngines(settings), engine, 'engine');
      const eng = ctx.ttsEngine();
      if (!eng.ready) throw new Error(`${eng.name} belum dikonfigurasi (API key di ⚙︎ Klipin). Alternatif gratis otomatis: panggil klipin_aistudio_voice atau buka ${AI_STUDIO_TTS_URL}.`);
      if (voice) S.ttsVoices[eng.kind] = String(voice);
      ctx.renderTtsEngines();
      const out = await llm.synthesize(settings, {
        engine: eng.id, text: S.script, styleInstruction: S.styleInstr, voice: S.ttsVoices[eng.kind],
        onProgress: (i, n) => { ctx.setProgress('#ttsProgress', i / n); progress(`suara bagian ${i}/${n}`); },
      }).finally(() => ctx.setProgress('#ttsProgress', null));
      await ctx.setAudio(out);
      ctx.doTrim({ quiet: true, normalize: true });
      ctx.save();
      return { text: `Suara selesai (${eng.name}, ${S.ttsVoices[eng.kind]}): ${fmtTime(audioLib.duration(ctx.currentAudio()))}.` };
    },

    async aistudio_voice({ voice }, progress) {
      const S = ctx.getState();
      ctx.go(2);
      if (!S.script.trim()) throw new Error('Naskah masih kosong — panggil klipin_write_script dulu.');
      if (voice) S.ttsVoices.gemini = String(voice);
      ctx.initUI();
      const out = await synthesizeViaAiStudio({
        script: S.script,
        styleInstr: S.styleInstr,
        voice: S.ttsVoices.gemini,
        onProgress: (i, n, msg) => {
          ctx.setProgress('#ttsProgress', n ? i / n : null);
          progress(msg || `AI Studio ${i}/${n}`);
        },
      }).finally(() => ctx.setProgress('#ttsProgress', null));
      await ctx.setAudio(out);
      ctx.doTrim({ quiet: true, normalize: true });
      ctx.save();
      return { text: `Suara AI Studio selesai (${S.ttsVoices.gemini}): ${fmtTime(audioLib.duration(ctx.currentAudio()))}.` };
    },

    async load_audio({ name, token, base64 }) {
      ctx.go(2);
      let file;
      if (token) {
        const res = await fetch(`${ctx.agentUrl}/audio/${encodeURIComponent(token)}`, {
          headers: { 'x-klipin-client': ctx.getAgentClientId() },
        });
        if (!res.ok) throw new Error(`Gagal mengambil stream audio dari MCP (${res.status}).`);
        const blob = await res.blob();
        file = new File([blob], name || 'audio.wav');
      } else if (base64) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        file = new File([bytes], name || 'audio');
      } else {
        throw new Error('Data audio tidak dikirim.');
      }
      const a = await audioLib.decodeFile(file);
      await ctx.setAudio(a);
      ctx.doTrim({ quiet: true, normalize: true });
      ctx.save();
      return { text: `Audio "${name}" dimuat & dirapikan: ${fmtTime(audioLib.duration(ctx.currentAudio()))}.` };
    },

    async scenes({ visual_style, ratio, scene_seconds, source }, progress) {
      const S = ctx.getState();
      const settings = ctx.getSettings();
      ctx.go(3);
      S.visualStyle = pickId(llm.visualStyles(settings), visual_style, 'visual_style') || S.visualStyle;
      if (ratio) S.ratio = pickId(RATIOS, ratio, 'ratio');
      if (scene_seconds) S.sceneSec = Math.max(3, Math.min(20, Number(scene_seconds)));
      ctx.initUI();
      if (source === 'transcript') await ctx.scenesFromTranscriptNow(progress);
      else await ctx.scenesFromScriptNow(progress);
      ctx.setProgress('#sceneProgress', null);
      const list = S.scenes.map((x) => `${x.i}. [${fmtTime(x.start)}–${fmtTime(x.end)}] ${x.text.slice(0, 90)}${x.text.length > 90 ? '…' : ''}\n   prompt: ${x.prompt}`);
      return { text: `${S.scenes.length} scene (gaya ${S.visualStyle}, rasio ${S.ratio}):\n${list.join('\n')}` };
    },

    async edit_scene({ scene, prompt }) {
      const S = ctx.getState();
      const sc = S.scenes.find((x) => x.i === Number(scene));
      if (!sc) throw new Error(`Scene ${scene} tidak ada (1–${S.scenes.length}).`);
      sc.prompt = String(prompt).trim();
      ctx.renderStoryboard();
      ctx.save();
      return { text: `Prompt scene ${sc.i} diganti. Panggil klipin_images dengan scenes: [${sc.i}] untuk membuat ulang gambarnya.` };
    },

    async images({ scenes, only_missing }, progress) {
      const S = ctx.getState();
      const settings = ctx.getSettings();
      ctx.go(3);
      const nums = Array.isArray(scenes) && scenes.length ? new Set(scenes.map(Number)) : null;
      const targets = S.scenes.filter((x) => (nums ? nums.has(x.i) : only_missing === false || !x.image));
      if (!S.scenes.length) throw new Error('Belum ada scene — panggil klipin_scenes dulu.');
      if (!targets.length) return { text: 'Semua scene sudah punya gambar.' };

      const c = await ensureFlowProject({ autoCreate: true, onStatus: progress });
      if (!c.ok) throw new Error(`Google Flow: ${c.reason}. Buka ${FLOW_URL} & login jika perlu.`);

      const r = await runFlowBatch({
        targets,
        totalScenes: S.scenes.length,
        ratio: S.ratio,
        parallel: ctx.getFlowParallel(),
        settings,
        visualStyle: ctx.visualStyle(),
        autoCreate: true,
        onSceneUpdate: (sc) => { ctx.updateStoryboardCard(sc); ctx.save(); },
        onBatchProgress: (done, tot) => ctx.setProgress('#flowProgress', done / Math.max(1, tot)),
        onProgress: progress,
      }).finally(() => ctx.setProgress('#flowProgress', null));
      const failed = S.scenes.filter((x) => x.status === 'error').map((x) => `${x.i} (${x.error})`);
      return { text: `Gambar: ${r?.ok ?? 0} berhasil, ${r?.fail ?? 0} gagal. Total ${S.scenes.filter((x) => x.image).length}/${S.scenes.length} scene punya gambar.${failed.length ? `\nGagal: ${failed.join(', ')}` : ''}` };
    },

    async render({ resolution, fps, subtitles, hook_text, callouts }, progress) {
      const S = ctx.getState();
      ctx.go(4);
      if (callouts != null) S.callouts.on = callouts !== false && String(callouts).toLowerCase() !== 'off';
      if (hook_text != null) {
        const t = String(hook_text).trim();
        S.hook.on = t.toLowerCase() !== 'off';
        if (S.hook.on && t) { S.hook.text = t; S.hook.auto = ''; }
      }
      if (resolution) S.res = Number(resolution) === 720 ? 720 : 1080;
      if (fps) S.fps = Number(fps) === 24 ? 24 : 30;
      if (subtitles != null) S.subtitles = !!subtitles;
      ctx.initUI();
      ctx.renderSummary();
      const out = await ctx.renderVideo(null, progress);
      progress('menyimpan file…');
      const file = await ctx.downloadBlob(out.blob, `${safeName(S.title || S.rawTitle)}.mp4`);
      S.lastVideo = file;
      ctx.save();
      ctx.showRenderedVideo(out.blob, `✅ Video jadi (${fmtTime(out.duration)}) — ${file}`);
      return { text: `Video selesai dalam ${out.elapsed.toFixed(0)} detik: ${fmtTime(out.duration)}, ${out.width}×${out.height}.\nTeks hook 2 detik pertama: ${S.hook.on && S.hook.text ? `"${S.hook.text}"` : 'tidak ada'}\nAngka penting di layar: ${S.callouts.on && S.callouts.list.length ? S.callouts.list.map((c) => `scene ${c.i} "${c.text}"`).join(', ') : 'tidak ada'}\nTersimpan di: ${file}` };
    },

    async youtube(_args, progress) {
      ctx.go(5);
      progress('menyusun judul, deskripsi, tag…');
      const yt = await ctx.makeYoutubePack();
      return {
        text: `JUDUL (pilih satu):\n${yt.titles.map((t, k) => `${k + 1}. ${t}`).join('\n')}\n\nDESKRIPSI:\n${yt.desc}\n\nTAG:\n${yt.tags}\n\nTEKS THUMBNAIL: ${yt.thumbTexts.join(' | ')}\nPROMPT LATAR THUMBNAIL: ${yt.thumbPrompt}`,
      };
    },

    async thumb_concepts({ types }, progress) {
      ctx.go(5);
      const yt = ctx.ensureYt();
      const list = (Array.isArray(types) ? types : String(types || '').split(/[\s,]+/)).filter((id) => thumbType(id));
      if (list.length) yt.thumbTypes = list.slice(0, 4);
      progress('menyusun konsep thumbnail…');
      const concepts = await ctx.makeThumbConcepts(ctx.selectedTypes());
      return {
        text: `Konsep thumbnail (format ${ctx.fmtStyle().label}, gaya narasi ${ctx.narrStyle().label}). Pakai dengan klipin_thumbnail concept=N:\n${concepts.map((c, k) => `${k + 1}. [${c.type}] teks "${c.text}" · warna ${c.color}\n   ide: ${c.idea}\n   prompt: ${c.prompt}`).join('\n')}`,
      };
    },

    async thumbnail({ text, background, position, color, concept }, progress) {
      const S = ctx.getState();
      ctx.go(5);
      const yt = ctx.ensureYt();
      if (concept) {
        const k = Number(concept) - 1;
        if (!yt.concepts[k]) throw new Error(`Konsep ${concept} tidak ada — panggil klipin_thumb_concepts dulu.`);
        if (!yt.concepts[k].image || background === 'flow') {
          progress(`membuat gambar konsep ${concept} di Google Flow…`);
          await generateConceptImages({
            concepts: yt.concepts,
            ks: [k],
            ratio: S.ratio,
            autoCreate: true,
            onDoneOne: () => { ctx.renderYt(); ctx.save(); },
          });
        }
        if (text) yt.concepts[k].text = String(text);
        ctx.applyConcept(k);
        background = background === 'flow' ? '' : background;
      }
      if (text) yt.thumb.text = String(text);
      if (!yt.thumb.text) yt.thumb.text = yt.thumbTexts[0] || (S.title || '').split(/\s+/).slice(0, 4).join(' ');
      if (position) yt.thumb.pos = ['left', 'right', 'bottom', 'split'].includes(position) ? position : yt.thumb.pos;
      if (color) yt.thumb.color = THUMB_COLORS[color] ? color : yt.thumb.color;
      const m = /^scene:(\d+)$/.exec(String(background || ''));
      if (m) {
        if (!S.scenes.find((x) => x.i === Number(m[1]) && x.image)) throw new Error(`Scene ${m[1]} belum punya gambar.`);
        yt.thumb.bg = `s${m[1]}`;
      } else if (background === 'flow') {
        if (!yt.thumbPrompt) throw new Error('Belum ada prompt latar — panggil klipin_youtube dulu.');
        progress('membuat latar di Google Flow…');
        const imgs = await generateThumbBgInFlow({ prompt: yt.thumbPrompt, ratio: S.ratio, autoCreate: true });
        for (const src of imgs.reverse()) {
          yt.bgs.unshift(src);
          yt.bgs = yt.bgs.slice(0, 6);
          yt.thumb.bg = 'g0';
        }
      }
      ctx.renderYt();
      const blob = await thumbBlob(S);
      const file = await ctx.downloadBlob(blob, `${safeName(yt.title || S.title)} - thumbnail.jpg`);
      S.lastThumb = file;
      const b64 = await thumbPreviewBase64(S);
      ctx.save();
      return {
        text: `Thumbnail tersimpan di: ${file}\nTeks: "${yt.thumb.text}" · posisi ${yt.thumb.pos} · warna ${yt.thumb.color} · latar ${currentBg(S)?.label || 'kosong'}`,
        image: { data: b64, mimeType: 'image/jpeg' },
      };
    },

    async youtube_attach({ file, kind = 'video' }) {
      const S = ctx.getState();
      const targetPath = file || (kind === 'image' ? S.lastThumb : S.lastVideo);
      if (!targetPath) throw new Error(kind === 'image' ? 'Belum ada thumbnail — panggil klipin_thumbnail dulu.' : 'Belum ada video — panggil klipin_render dulu.');
      const tabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
      if (!tabs.length) throw new Error('Tab YouTube Studio tidak ditemukan. Buka studio.youtube.com dulu.');
      const hint = (t) => (kind === 'image' ? /\/video\/[^/]+\/edit/.test(t.url || '') : /[?&]d=ud\b/.test(t.url || '')) ? 1 : 0;
      tabs.sort((a, b) => hint(b) - hint(a) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
      let lastErr = '';
      for (const tab of tabs) {
        const r = await chrome.runtime.sendMessage({ type: 'TUYUL_SET_FILE', tabId: tab.id, files: [targetPath], kind }).catch((e) => ({ ok: false, error: errMsg(e) }));
        if (!r) throw new Error('Background Klipin masih versi lama — klik ↻ pada Klipin di chrome://extensions, lalu buka ulang panel Klipin.');
        if (r.ok) return { text: `File dimasukkan ke YouTube Studio: ${targetPath}` };
        lastErr = r.error || 'Gagal memasukkan file.';
      }
      throw new Error(`${lastErr} [dicoba ${tabs.length} tab Studio: ${tabs.map((t) => (t.url || '').replace(/^https:\/\/studio\.youtube\.com/, '').slice(0, 60)).join(' | ')}]`);
    },

    async run_pipeline(args, progress) {
      const res = await runFullPipeline(ctx, {
        ...args,
        onStage: (st) => progress(`[${st.index}/${st.total}] ${st.text}`),
      });
      return {
        text: [
          `✅ Pipeline selesai: "${res.title}" (${res.duration})`,
          `Video: ${res.videoPath}`,
          res.thumbPath ? `Thumbnail: ${res.thumbPath}` : null,
          res.metaPath ? `Metadata: ${res.metaPath}` : null,
          res.warnings?.length ? `Catatan:\n- ${res.warnings.join('\n- ')}` : null,
        ].filter(Boolean).join('\n'),
      };
    },
  };
}
