// Orkestrasi pipeline otomatis penuh (Brief -> Naskah -> Suara -> Storyboard -> Gambar -> Render -> Publish)
// serta antrean batch multi-proyek yang disimpan di IndexedDB.
import { FORMATS, NARRATION_STYLES, VIDEO_PRESETS, WPM } from './data.js';
import * as llm from './llm.js';
import * as audioLib from './audio.js';
import { fmtTime } from './scenes.js';
import { kvGet, kvSet } from './store.js';
import { runFlowBatch, generateConceptImages } from './flow-client.js';
import { synthesizeViaAiStudio } from './aistudio-client.js';
import { thumbBlob } from './thumbnail.js';

export function safeName(s) {
  return (s || 'video').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
}

export function applyPresetToState(S, presetId) {
  const p = VIDEO_PRESETS.find((x) => x.id === presetId);
  if (!p) return null;
  S.preset = p.id;
  S.ratio = p.ratio;
  S.minutes = p.minutes;
  S.sceneSec = p.sceneSec;
  S.res = p.res;
  S.fps = p.fps;
  if (typeof p.loop === 'boolean') S.loop = p.loop;
  return p;
}

export function buildMetadataText(S) {
  const yt = S.yt || {};
  return [
    `JUDUL:\n${yt.title || S.title || ''}`,
    `DESKRIPSI:\n${yt.desc || ''}`,
    `TAG:\n${yt.tags || ''}`,
    `HOOK 2 DETIK:\n${S.hook?.text || ''}`,
    `CATATAN:\nFormat ${S.format} | Gaya ${S.narrStyle} | Visual ${S.visualStyle} | Rasio ${S.ratio}`,
  ].join('\n\n---\n\n');
}

export function buildMetadataJson(S, warnings = []) {
  return JSON.stringify({
    title: S.yt?.title || S.title,
    rawTitle: S.rawTitle,
    preset: S.preset || (S.ratio === '9:16' ? 'shorts' : 'youtube'),
    format: S.format,
    narrationStyle: S.narrStyle,
    visualStyle: S.visualStyle,
    ratio: S.ratio,
    minutes: S.minutes,
    loop: !!S.loop,
    lang: S.lang,
    hookText: S.hook?.text || '',
    callouts: S.callouts?.list || [],
    description: S.yt?.desc || '',
    tags: S.yt?.tags || '',
    scenes: (S.scenes || []).map((s) => ({ i: s.i, start: s.start, end: s.end, text: s.text })),
    warnings,
    createdAt: new Date().toISOString(),
  }, null, 2);
}

export const PIPELINE_STAGES = [
  { id: 'creative', label: 'Arahan' },
  { id: 'title', label: 'Judul' },
  { id: 'script', label: 'Naskah' },
  { id: 'voice', label: 'Suara' },
  { id: 'storyboard', label: 'Storyboard' },
  { id: 'images', label: 'Gambar' },
  { id: 'render', label: 'Render' },
  { id: 'publish', label: 'Publish' },
];

/**
 * Jalankan pipeline penuh dengan checkpoint & resume (tahap yang sudah lengkap dilewati otomatis).
 */
export async function runFullPipeline(ctx, opts = {}) {
  const {
    topic, preset, format, narration_style, visual_style, minutes, lang, loop,
    voice_source = 'auto', publish_pack = true, auto_creative = true, forceNew = false, signal, onStage,
  } = opts;

  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException('Otomasi dihentikan', 'AbortError');
  };

  if (forceNew) await ctx.resetProject();
  const S = ctx.getState();
  const settings = ctx.getSettings();

  if (preset) applyPresetToState(S, preset);
  if (lang) S.lang = lang === 'en' ? 'en' : 'id';
  if (format && FORMATS.some((f) => f.id === format)) S.format = format;
  if (narration_style && NARRATION_STYLES.some((n) => n.id === narration_style)) {
    S.narrStyle = narration_style;
    S.styleInstrEdited = false;
  }
  if (visual_style) {
    const allVs = llm.visualStyles(settings);
    if (allVs.some((v) => v.id === visual_style)) S.visualStyle = visual_style;
  }
  if (minutes) S.minutes = Number(minutes);
  if (typeof loop === 'boolean') S.loop = loop;

  if (topic && String(topic).trim()) {
    const t = String(topic).trim();
    if (!forceNew && S.rawTitle && S.rawTitle !== t) {
      await ctx.resetProject();
      if (preset) applyPresetToState(S, preset);
      if (lang) S.lang = lang === 'en' ? 'en' : 'id';
      if (format && FORMATS.some((f) => f.id === format)) S.format = format;
      if (narration_style && NARRATION_STYLES.some((n) => n.id === narration_style)) S.narrStyle = narration_style;
      if (visual_style) S.visualStyle = visual_style;
      if (minutes) S.minutes = Number(minutes);
      if (typeof loop === 'boolean') S.loop = loop;
    }
    ctx.getState().rawTitle = t;
  }

  const st = ctx.getState();
  ctx.initUI();
  ctx.save();

  const activeStages = publish_pack ? PIPELINE_STAGES : PIPELINE_STAGES.filter((s) => s.id !== 'publish');
  const stageStatus = Object.fromEntries(activeStages.map((s) => [s.id, 'pending']));
  const totalStages = activeStages.length;
  const warnings = [];

  const emitStage = (id, status, text, pct) => {
    for (const s of activeStages) {
      if (s.id !== id && stageStatus[s.id] === 'running') stageStatus[s.id] = 'done';
    }
    if (id && id in stageStatus) stageStatus[id] = status;
    const idx = Math.max(1, activeStages.findIndex((s) => s.id === id) + 1);
    const label = activeStages.find((s) => s.id === id)?.label || 'Proses';
    onStage?.({
      stage: id,
      index: idx,
      total: totalStages,
      title: label,
      text,
      pct,
      stages: activeStages.map((s) => ({ ...s, status: stageStatus[s.id] })),
    });
  };

  try {
    // 0. Arahan kreatif otomatis dari topik (kalau belum dikunci manual & tidak dipaksa di opts)
    checkAbort();
    const explicitCreative = Boolean(format || narration_style || visual_style);
    const rawTopic = (st.rawTitle || st.title || '').trim();
    if (auto_creative && !st.creativeEdited && !explicitCreative && !st.script.trim() && rawTopic) {
      emitStage('creative', 'running', 'Memilih format, gaya narasi & gaya visual terbaik…', 0.03);
      try {
        const pick = await llm.suggestCreativeBrief(settings, {
          topic: rawTopic, preset: st.preset || preset || 'shorts', minutes: st.minutes, lang: st.lang,
        });
        st.format = pick.format;
        if (pick.narrStyle !== st.narrStyle) { st.narrStyle = pick.narrStyle; st.styleInstrEdited = false; }
        st.visualStyle = pick.visualStyle;
        if (typeof loop !== 'boolean') st.loop = pick.loop;
        st.ttsVoices.gemini = pick.voice;
        st.creativeReason = pick.reason;
        ctx.initUI();
        ctx.save();
        stageStatus.creative = 'done';
      } catch (e) {
        warnings.push(`Arahan kreatif otomatis dilewati (${e.message}).`);
        stageStatus.creative = 'skipped';
      }
    } else {
      stageStatus.creative = 'done';
    }

    // 1. Judul
    checkAbort();
    if (!st.title) {
      const raw = st.rawTitle.trim();
      if (!raw) throw new Error('Isi topik/ide video dulu.');
      emitStage('title', 'running', 'Mengembangkan judul menarik…', 0.08);
      ctx.go(1);
      st.titleOptions = await llm.expandTitle(settings, raw, st.lang);
      st.title = st.titleOptions[0] || raw;
      ctx.initUI();
      ctx.save();
    }
    stageStatus.title = 'done';

    // 2. Naskah
    checkAbort();
    if (!st.script.trim()) {
      emitStage('script', 'running', 'Menulis naskah voiceover…', 0.14);
      ctx.go(2);
      const fmt = FORMATS.find((f) => f.id === st.format) || FORMATS[0];
      const ns = NARRATION_STYLES.find((n) => n.id === st.narrStyle) || NARRATION_STYLES[0];
      st.script = await llm.writeScript(settings, {
        title: st.title, format: fmt, style: ns, minutes: st.minutes, lang: st.lang,
        wpm: WPM[st.lang] || 150, loop: st.loop,
        onProgress: (msg) => emitStage('script', 'running', msg, 0.2),
      });
      ctx.initUI();
      ctx.save();
    }
    stageStatus.script = 'done';

    // 3. Suara (API atau AI Studio Auto + auto-trim + normalisasi loudness)
    checkAbort();
    if (!ctx.getAudioRaw()) {
      emitStage('voice', 'running', 'Menyiapkan voiceover…', 0.28);
      ctx.go(2);
      const engines = llm.ttsEngines(settings);
      const preferred = engines.find((e) => e.id === st.ttsEngine && e.ready) || engines.find((e) => e.ready);
      const useAiStudio = voice_source === 'aistudio' || (voice_source === 'auto' && !preferred);

      let outAudio;
      if (useAiStudio) {
        outAudio = await synthesizeViaAiStudio({
          script: st.script,
          styleInstr: st.styleInstr,
          voice: st.ttsVoices.gemini,
          signal,
          onProgress: (i, n, msg) => emitStage('voice', 'running', msg || `AI Studio ${i}/${n}`, 0.28 + (i / Math.max(1, n)) * 0.12),
        });
      } else {
        if (!preferred) throw new Error('Belum ada TTS API yang dikonfigurasi.');
        outAudio = await llm.synthesize(settings, {
          engine: preferred.id,
          text: st.script,
          styleInstruction: st.styleInstr,
          voice: st.ttsVoices[preferred.kind],
          onProgress: (i, n) => emitStage('voice', 'running', `Membuat suara via ${preferred.name} (${i}/${n})…`, 0.28 + (i / Math.max(1, n)) * 0.12),
        });
      }
      await ctx.setAudio(outAudio);
      ctx.doTrim({ quiet: true, normalize: true });
    } else if (!ctx.getAudioTrim()) {
      ctx.doTrim({ quiet: true, normalize: true });
    }
    stageStatus.voice = 'done';

    const activeAudio = ctx.currentAudio();
    if (activeAudio && st.minutes < 2) {
      const dur = audioLib.duration(activeAudio);
      if (dur > 59) {
        warnings.push(`Durasi audio ${dur.toFixed(1)} detik (> 59 detik) — YouTube bisa menganggapnya video reguler, bukan Shorts.`);
      }
    }

    // 4. Storyboard (scene + character bible + prompt gambar)
    checkAbort();
    if (!st.scenes.length || st.scenes.some((s) => !s.prompt)) {
      emitStage('storyboard', 'running', 'Menyusun storyboard & prompt gambar…', 0.44);
      ctx.go(3);
      await ctx.scenesFromScriptNow((msg) => emitStage('storyboard', 'running', msg, 0.48));
    }
    stageStatus.storyboard = 'done';

    // 5. Gambar di Google Flow (auto-create project bila perlu)
    checkAbort();
    const missing = st.scenes.filter((s) => !s.image);
    if (missing.length) {
      emitStage('images', 'running', `Membuat ${missing.length} gambar di Google Flow…`, 0.52);
      ctx.go(3);
      const allVs = llm.visualStyles(settings);
      const vs = allVs.find((v) => v.id === st.visualStyle) || allVs[0];
      let lastPct = 0.52;
      const r = await runFlowBatch({
        targets: missing,
        totalScenes: st.scenes.length,
        ratio: st.ratio,
        parallel: ctx.getFlowParallel(),
        settings,
        visualStyle: vs,
        autoCreate: true,
        shouldStop: () => !!signal?.aborted,
        onSceneUpdate: (sc) => { ctx.updateStoryboardCard(sc); ctx.save(); },
        onBatchProgress: (done, tot) => {
          lastPct = 0.52 + (done / Math.max(1, tot)) * 0.25;
          emitStage('images', 'running', `Gambar Flow selesai ${done}/${tot}…`, lastPct);
        },
        onProgress: (msg) => emitStage('images', 'running', `Membuat ${msg} di Google Flow…`, lastPct),
        onStatus: (msg) => emitStage('images', 'running', msg, lastPct),
      });
      if (r.fail > 0) warnings.push(`${r.fail} gambar gagal dibuat di Flow (pakai gambar terdekat saat render).`);
    }
    stageStatus.images = 'done';

    // 6. Render MP4 otomatis (plus auto-suggest hook & callouts)
    checkAbort();
    emitStage('render', 'running', 'Menyiapkan hook & me-render MP4…', 0.78);
    ctx.go(4);
    const out = await ctx.renderVideo(null, (txt) => emitStage('render', 'running', txt, 0.85));
    const baseName = safeName(st.title || st.rawTitle);
    const folder = baseName;
    const videoPath = await ctx.downloadBlob(out.blob, `${folder}/${baseName}.mp4`);
    st.lastVideo = videoPath;
    ctx.save();
    stageStatus.render = 'done';

    let thumbPath = '';
    let metaPath = '';
    if (publish_pack) {
      checkAbort();
      emitStage('publish', 'running', 'Menyusun paket publish & thumbnail…', 0.92);
      ctx.go(5);
      await ctx.makeYoutubePack();
      const concepts = await ctx.makeThumbConcepts();
      if (concepts.length && !concepts[0].image) {
        try {
          await generateConceptImages({
            concepts,
            ks: [0],
            ratio: st.ratio,
            autoCreate: true,
            onDoneOne: () => { ctx.renderYt(); ctx.save(); },
          });
          ctx.applyConcept(0);
        } catch (e) {
          warnings.push(`Gambar konsep thumbnail di Flow gagal (${e.message}); memakai latar default.`);
        }
      }
      const blob = await thumbBlob(st);
      thumbPath = await ctx.downloadBlob(blob, `${folder}/${baseName} - thumbnail.jpg`);
      st.lastThumb = thumbPath;
      metaPath = await ctx.downloadBlob(new Blob([buildMetadataText(st)], { type: 'text/plain;charset=utf-8' }), `${folder}/${baseName} - metadata.txt`);
      await ctx.downloadBlob(new Blob([buildMetadataJson(st, warnings)], { type: 'application/json;charset=utf-8' }), `${folder}/${baseName} - metadata.json`);
      ctx.save();
      stageStatus.publish = 'done';
    }

    emitStage(activeStages.at(-1).id, 'done', 'Semua tahap selesai ✓', 1);
    return {
      title: st.title,
      duration: fmtTime(out.duration),
      videoPath,
      thumbPath,
      metaPath,
      warnings,
    };
  } catch (e) {
    const running = activeStages.find((s) => stageStatus[s.id] === 'running');
    if (running) {
      stageStatus[running.id] = 'error';
      emitStage(running.id, 'error', e.message || String(e), 0);
    }
    throw e;
  }
}

// ---------------------------------------------------------------- Batch Queue

export async function loadQueue() {
  return (await kvGet('queue').catch(() => null)) || [];
}

export async function saveQueue(list) {
  await kvSet('queue', list).catch(() => {});
}

export async function runQueue(ctx, { signal, onUpdate, onStage } = {}) {
  const list = await loadQueue();
  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) break;
    const item = list[i];
    if (item.status === 'done') continue;
    item.status = 'running';
    item.error = '';
    await saveQueue(list);
    onUpdate?.(list);
    try {
      const res = await runFullPipeline(ctx, {
        topic: item.topic,
        preset: item.preset,
        voice_source: item.voiceSource || 'auto',
        publish_pack: true,
        forceNew: true,
        signal,
        onStage: (st) => onStage?.({ ...st, queueIndex: i + 1, queueTotal: list.length, topic: item.topic }),
      });
      item.status = 'done';
      item.output = res.videoPath;
    } catch (e) {
      if (e.name === 'AbortError') {
        item.status = 'pending';
        await saveQueue(list);
        onUpdate?.(list);
        break;
      }
      item.status = 'error';
      item.error = e.message || String(e);
    }
    await saveQueue(list);
    onUpdate?.(list);
  }
  return list;
}
