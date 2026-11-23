'use strict';

(async function initPlayerUI() {
  let check;
  try {
    check = await chrome.runtime.sendMessage({ type: 'IS_MOVY_TAB' });
  } catch {
    return;
  }
  if (!check || !check.isMovy) return;

  // Balanced 2.35-unit stroke Cast SVG matching movy.sx fullscreen icon weight & pure white brightness
  const CAST_SVG_HTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/>' +
    '<path d="M2 12.2A7.8 7.8 0 0 1 9.8 20"/>' +
    '<path d="M2 16.1A3.9 3.9 0 0 1 5.9 20"/>' +
    '<circle cx="2.5" cy="19.5" r="1.15" fill="currentColor" stroke="none"/>' +
    '</svg>';

  const PANEL_SHADOW_CSS = `
    :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .panel {
      width: 308px;
      max-height: min(520px, calc(100vh - 108px));
      overflow-y: auto;
      background: rgba(20, 20, 20, 0.92);
      color: #f4f4f5;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      box-shadow: 0 18px 42px -12px rgba(0, 0, 0, 0.8), inset 0 1px rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      font-size: 12.5px;
      line-height: 1.45;
      user-select: none;
    }
    .panel::-webkit-scrollbar { width: 4px; }
    .panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
    .hdr { display: flex; align-items: center; justify-content: space-between; padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .hdr-left { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #52525b; flex-shrink: 0; }
    .dot.on { background: #22c55e; }
    .title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(255,255,255,0.1); color: #d4d4d8; flex-shrink: 0; }
    .pill.ready { background: #fafafa; color: #09090b; font-weight: 600; }
    .close { background: none; border: none; color: #a1a1aa; font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; margin-left: 8px; }
    .close:hover { color: #fff; }
    .body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .sec-head { display: flex; align-items: center; justify-content: space-between; color: #a1a1aa; font-size: 11.5px; }
    .links { display: flex; align-items: center; gap: 10px; }
    .link { background: none; border: none; color: #e4e4e7; font-size: 11.5px; cursor: pointer; opacity: 0.82; padding: 0; }
    .link:hover { opacity: 1; text-decoration: underline; }
    .list { display: flex; flex-direction: column; gap: 5px; }
    .dev { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); background: rgba(32,32,34,0.88); color: #f4f4f5; cursor: pointer; text-align: left; font-size: 12.5px; }
    .dev:hover { background: rgba(48,48,52,0.96); border-color: rgba(255,255,255,0.18); }
    .dev.active { border-color: rgba(255,255,255,0.38); background: rgba(52,52,56,0.96); }
    .trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .tag-muted { font-size: 11px; color: #a1a1aa; flex-shrink: 0; }
    .divider { height: 1px; background: rgba(255,255,255,0.08); }
    .row { display: flex; align-items: center; gap: 6px; }
    .btn { flex: 1; padding: 5px 4px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.09); background: rgba(34,34,36,0.9); color: #f4f4f5; font-size: 11.5px; cursor: pointer; }
    .btn:hover { background: rgba(52,52,56,0.96); }
    .btn.danger { color: #fca5a5; }
    .btn-sm { padding: 5px 10px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.1); color: #fafafa; font-size: 12px; cursor: pointer; flex-shrink: 0; }
    .btn-sm:hover { background: rgba(255,255,255,0.18); }
    .btn-primary { width: 100%; padding: 7px 10px; border-radius: 8px; border: none; background: #fafafa; color: #09090b; font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn-primary:hover { opacity: 0.9; }
    .btn-primary:disabled { opacity: 0.55; cursor: default; }
    .offset { min-width: 46px; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 12px; }
    input[type="text"] { flex: 1; min-width: 0; padding: 6px 8px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.07); color: #fafafa; font-size: 12px; outline: none; user-select: text; }
    input[type="text"]:focus { border-color: rgba(255,255,255,0.34); }
    input[type="range"] { width: 100%; accent-color: #fafafa; cursor: pointer; }
    .time-row { display: flex; justify-content: space-between; font-size: 11px; color: #a1a1aa; font-variant-numeric: tabular-nums; }
    .vol-val { min-width: 24px; text-align: right; font-size: 11px; color: #a1a1aa; font-variant-numeric: tabular-nums; }
    .chk { display: inline-flex; align-items: center; gap: 4px; color: #d4d4d8; cursor: pointer; }
    .chk input { accent-color: #fafafa; }
    .muted { color: #71717a; font-size: 11.5px; }
    .notice { padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); color: #d4d4d8; font-size: 11.5px; }
    .notice code { background: rgba(255,255,255,0.12); padding: 1px 4px; border-radius: 4px; font-size: 11px; }
    .sub-list { display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow-y: auto; }
    .sub-item { width: 100%; display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.08); background: rgba(32,32,34,0.85); color: #e4e4e7; cursor: pointer; text-align: left; font-size: 11.5px; }
    .sub-item:hover { background: rgba(48,48,52,0.96); }
    .sub-item.active { border-color: rgba(255,255,255,0.4); background: rgba(54,54,58,0.96); }
    .sub-tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,0.16); color: #fff; flex-shrink: 0; }
    .status { text-align: center; font-size: 11.5px; color: #d4d4d8; padding: 5px 8px; border-radius: 7px; background: rgba(255,255,255,0.06); }
    .switch { position: relative; display: inline-block; width: 32px; height: 18px; cursor: pointer; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; background: rgba(255,255,255,0.18); border-radius: 999px; transition: background 0.16s ease; }
    .slider::before { content: ""; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; border-radius: 50%; background: #fff; transition: transform 0.16s ease; }
    .switch input:checked + .slider { background: #22c55e; }
    .switch input:checked + .slider::before { transform: translateX(14px); }
  `;

  const SUB_SHADOW_CSS = `
    :host { all: initial; }
    .wrap {
      position: absolute;
      left: 5%;
      right: 5%;
      bottom: 11%;
      pointer-events: none;
      text-align: center;
      display: flex;
      justify-content: center;
      align-items: flex-end;
    }
    .cue {
      display: none;
      max-width: 90%;
      padding: 0.08em 0.38em;
      border-radius: 4px;
      background-color: transparent;
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
      font-weight: 500;
      line-height: 1.38;
      white-space: pre-wrap;
      text-shadow: 0 1px 3px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.85), 1px 1px 2px rgba(0,0,0,0.9);
      -webkit-font-smoothing: antialiased;
    }
  `;

  // Runtime state
  const cueOriginals = new WeakMap();
  const audioNodes = new WeakMap();

  let currentSync = { subtitleOffset: 0, audioOffset: 0, mode: 'subtitle' };
  let customCues = [];
  let subHost = null;
  let subCueEl = null;
  let subRafId = 0;

  let castBtn = null;
  let anchoredFsBtn = null;
  let panelHost = null;
  let panelShadow = null;
  let pollTimer = null;
  let autoCloseTimer = null;
  let isSeeking = false;
  let manualAddOpen = false;
  let cachedSubResults = [];
  let subQueryDraft = '';
  let lastHref = location.href;

  // ---------- Helpers ----------

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return hh > 0
      ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  function findPrimaryVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;
    videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
    return videos[0];
  }

  function findPlayerRoot(video) {
    if (!video) return null;
    const vpRoot = video.closest('.vp-root');
    if (vpRoot) return vpRoot;
    const vRect = video.getBoundingClientRect();
    let best = video.parentElement;
    let cur = video.parentElement;
    for (let depth = 0; depth < 7 && cur && cur !== document.body && cur !== document.documentElement; depth++) {
      const r = cur.getBoundingClientRect();
      if (r.width >= vRect.width * 0.9 && r.height >= vRect.height * 0.9 && r.width <= vRect.width + 80 && r.height <= vRect.height + 120) {
        best = cur;
      }
      cur = cur.parentElement;
    }
    return best;
  }

  // ---------- Native Track Sync & Web Audio Delay ----------

  function applyCueOffsetToTrack(track, offsetSec) {
    if (!track || !track.cues) return;
    for (let i = 0; i < track.cues.length; i++) {
      const cue = track.cues[i];
      if (!cueOriginals.has(cue)) cueOriginals.set(cue, { start: cue.startTime, end: cue.endTime });
      const orig = cueOriginals.get(cue);
      const nextStart = Math.max(0, orig.start + offsetSec);
      const nextEnd = Math.max(nextStart + 0.05, orig.end + offsetSec);
      try {
        cue.startTime = nextStart;
        cue.endTime = nextEnd;
      } catch {}
    }
  }

  function applyNativeTrackOffset(video, offsetSec) {
    if (!video || !video.textTracks) return;
    for (let i = 0; i < video.textTracks.length; i++) {
      if (video.textTracks[i].mode !== 'disabled') applyCueOffsetToTrack(video.textTracks[i], offsetSec);
    }
  }

  function autoSelectSimplifiedChineseTrack(video) {
    if (!video || !video.textTracks || customCues.length > 0) return;
    const tracks = Array.from(video.textTracks);
    if (!tracks.length) return;
    if (tracks.some(t => t.mode === 'showing' && /(zh|chi|zho|chinese|简体|中文)/i.test(`${t.language} ${t.label}`))) return;
    const simplified = tracks.find(t => /(zh[-_]?cn|zh[-_]?hans|chs|simplified|简体)/i.test(`${t.language} ${t.label}`));
    if (simplified) {
      tracks.forEach(t => { if (t !== simplified && t.mode === 'showing') t.mode = 'hidden'; });
      simplified.mode = 'showing';
    }
  }

  function applyAudioDelay(video, delaySec) {
    if (!video) return { ok: true };
    const clamped = Math.max(0, Math.min(5, Number(delaySec) || 0));
    if (clamped === 0 && !audioNodes.has(video)) return { ok: true };
    try {
      let bundle = audioNodes.get(video);
      if (!bundle) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return { ok: false, reason: '浏览器不支持音频延迟' };
        const ctx = new AudioCtx();
        const source = ctx.createMediaElementSource(video);
        const delayNode = ctx.createDelay(5.0);
        source.connect(delayNode);
        delayNode.connect(ctx.destination);
        bundle = { ctx, delayNode };
        audioNodes.set(video, bundle);
      }
      if (bundle.ctx.state === 'suspended') bundle.ctx.resume().catch(() => {});
      bundle.delayNode.delayTime.setValueAtTime(clamped, bundle.ctx.currentTime);
      return { ok: true };
    } catch {
      return { ok: false, reason: '片源跨域限制网页音频延迟，请切右上角 Quality 线路或投屏' };
    }
  }

  function hookVideo(video) {
    if (!video || video.dataset.movyCastHooked === '1') return;
    video.dataset.movyCastHooked = '1';
    const reapply = () => {
      autoSelectSimplifiedChineseTrack(video);
      if (currentSync.subtitleOffset) applyNativeTrackOffset(video, currentSync.subtitleOffset);
      renderCustomCueNow();
    };
    if (video.textTracks) {
      video.textTracks.addEventListener('addtrack', e => {
        if (!e.track) return;
        setTimeout(() => autoSelectSimplifiedChineseTrack(video), 200);
        e.track.addEventListener('cuechange', () => {
          if (currentSync.subtitleOffset) applyCueOffsetToTrack(e.track, currentSync.subtitleOffset);
        });
      });
    }
    video.addEventListener('loadedmetadata', reapply);
    video.addEventListener('play', () => { reapply(); startSubLoop(); });
    video.addEventListener('seeked', renderCustomCueNow);
    video.addEventListener('timeupdate', renderCustomCueNow);
  }

  // ---------- Shadow DOM Cinema Subtitle Layer (Immersive-Translate style isolation) ----------

  function parseVttTime(ts) {
    const parts = ts.trim().replace(',', '.').split(':');
    if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + parseFloat(parts[2]);
    if (parts.length === 2) return Number(parts[0]) * 60 + parseFloat(parts[1]);
    return 0;
  }

  function parseVtt(vttText) {
    const blocks = String(vttText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n{2,}/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length || /^WEBVTT|^NOTE|^STYLE/i.test(lines[0])) continue;
      const tIdx = lines.findIndex(l => l.includes('-->'));
      if (tIdx === -1) continue;
      const m = lines[tIdx].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
      if (!m) continue;
      const start = parseVttTime(m[1]);
      const end = parseVttTime(m[2]);
      const text = lines.slice(tIdx + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (text && end > start) cues.push({ start, end, text });
    }
    return cues;
  }

  function syncSubtitleVisualStyle(playerRoot) {
    if (!subCueEl || !playerRoot) return;
    const nativeCue = playerRoot.querySelector('.vp-cue');
    if (nativeCue) {
      const cs = window.getComputedStyle(nativeCue);
      if (cs.fontFamily) subCueEl.style.fontFamily = cs.fontFamily;
      if (cs.fontSize && parseFloat(cs.fontSize) >= 14) subCueEl.style.fontSize = cs.fontSize;
      if (cs.color) subCueEl.style.color = cs.color;
      if (cs.textShadow && cs.textShadow !== 'none') subCueEl.style.textShadow = cs.textShadow;
      if (cs.backgroundColor) subCueEl.style.backgroundColor = cs.backgroundColor;
      if (cs.fontWeight) subCueEl.style.fontWeight = cs.fontWeight;
      return;
    }
    const rect = playerRoot.getBoundingClientRect();
    const px = Math.max(16, Math.min(34, Math.round(rect.width * 0.026)));
    subCueEl.style.fontSize = `${px}px`;
  }

  function ensureSubHost(video) {
    const playerRoot = findPlayerRoot(video);
    if (!playerRoot) return;
    if (subHost && subHost.isConnected && subHost.parentElement === playerRoot) {
      syncSubtitleVisualStyle(playerRoot);
      return;
    }
    removeSubHost();
    if (window.getComputedStyle(playerRoot).position === 'static') playerRoot.style.position = 'relative';

    subHost = document.createElement('div');
    subHost.id = 'movy-cast-sub-host';
    subHost.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2147483630;';
    const shadow = subHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${SUB_SHADOW_CSS}</style><div class="wrap"><span class="cue"></span></div>`;
    subCueEl = shadow.querySelector('.cue');

    playerRoot.appendChild(subHost);
    playerRoot.setAttribute('data-movy-cast-sub', '1');
    syncSubtitleVisualStyle(playerRoot);
  }

  function removeSubHost() {
    if (subRafId) { cancelAnimationFrame(subRafId); subRafId = 0; }
    if (subHost) {
      const parent = subHost.parentElement;
      subHost.remove();
      if (parent) parent.removeAttribute('data-movy-cast-sub');
    }
    subHost = null;
    subCueEl = null;
  }

  function renderCustomCueNow() {
    if (!customCues.length || !subCueEl) return;
    const video = findPrimaryVideo();
    if (!video) return;
    const t = video.currentTime - (Number(currentSync.subtitleOffset) || 0);
    const active = [];
    for (let i = 0; i < customCues.length; i++) {
      const c = customCues[i];
      if (t >= c.start && t <= c.end) active.push(c.text);
      else if (c.start > t + 1) break;
    }
    const joined = active.join('\n');
    if (subCueEl.textContent !== joined) {
      subCueEl.textContent = joined;
      subCueEl.style.display = joined ? 'inline-block' : 'none';
    }
  }

  function startSubLoop() {
    if (subRafId || !customCues.length) return;
    const tick = () => {
      subRafId = 0;
      const video = findPrimaryVideo();
      if (!video || !customCues.length) return;
      renderCustomCueNow();
      if (!video.paused && !video.ended) subRafId = requestAnimationFrame(tick);
    };
    subRafId = requestAnimationFrame(tick);
  }

  function loadCustomVttSubtitle(vttText) {
    const video = findPrimaryVideo();
    if (!video) return false;
    customCues = parseVtt(vttText);
    if (!customCues.length) return false;
    if (video.textTracks) {
      for (let i = 0; i < video.textTracks.length; i++) {
        if (video.textTracks[i].mode === 'showing') video.textTracks[i].mode = 'hidden';
      }
    }
    ensureSubHost(video);
    renderCustomCueNow();
    startSubLoop();
    return true;
  }

  function clearCustomSubtitle() {
    customCues = [];
    removeSubHost();
  }

  // ---------- Native-Cloned Player Button (Immersive-Translate style host reuse) ----------

  function findFullscreenButton(video) {
    const playerRoot = findPlayerRoot(video) || document.body;
    const exact = playerRoot.querySelector('#ButtonFullscreen');
    if (exact && exact.getBoundingClientRect().width >= 14) return exact;

    const sel = '.art-control-fullscreen,[aria-label*="fullscreen" i],[title*="fullscreen" i],[aria-label*="full screen" i],[title*="full screen" i],[aria-label*="全屏"],[title*="全屏"],[data-plyr="fullscreen"],.vjs-fullscreen-control,[data-testid*="fullscreen" i],[class*="fullscreen" i]';
    const hits = Array.from(playerRoot.querySelectorAll(sel)).filter(el => {
      if (el.dataset.movyCastBtn === '1') return false;
      const r = el.getBoundingClientRect();
      return r.width >= 16 && r.height >= 16 && r.width <= 84 && r.height <= 84;
    });
    if (hits.length) {
      hits.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return (rb.right + rb.bottom) - (ra.right + ra.bottom);
      });
      return hits[0];
    }

    // Fallback for players with obfuscated class names (e.g., cinejoy.pk embedded players)
    const vRect = video.getBoundingClientRect();
    if (vRect.width < 220 || vRect.height < 140) return null;
    const geom = Array.from(playerRoot.querySelectorAll('button, [role="button"]')).filter(el => {
      if (el.dataset.movyCastBtn === '1' || !el.querySelector('svg')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 18 || r.height < 18 || r.width > 64 || r.height > 64) return false;
      return r.bottom >= vRect.bottom - 95 && r.top <= vRect.bottom + 12 && r.right >= vRect.right - 120;
    });
    if (!geom.length) return null;
    geom.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    return geom[0];
  }

  function detectRealIconColor(fsBtn, fsSvg) {
    // Inspect actual painted SVG shape first (often #ffffff even when parent button has dimmed text color)
    const shape = fsSvg ? fsSvg.querySelector('path, rect, line, polyline, polygon, circle') : null;
    if (shape) {
      const sc = window.getComputedStyle(shape);
      for (const candidate of [sc.stroke, sc.fill]) {
        if (candidate && candidate !== 'none' && candidate !== 'rgb(0, 0, 0)' && candidate !== 'rgba(0, 0, 0, 0)') {
          return candidate;
        }
      }
    }
    const c = window.getComputedStyle(fsSvg || fsBtn).color;
    return c && c !== 'rgb(0, 0, 0)' ? c : '#ffffff';
  }

  function syncButtonWithFullscreen(btn, fsBtn) {
    if (!btn || !fsBtn) return;
    const fsSvg = fsBtn.querySelector('svg');
    const castSvg = btn.querySelector('svg');
    if (!castSvg) return;

    // Copy layout classes without inheriting dimmed opacity utility classes
    if (fsBtn.className && typeof fsBtn.className === 'string') {
      const hostClasses = fsBtn.className
        .split(/\s+/)
        .filter(c => c && !/^(opacity-|text-white\/|text-zinc-|text-neutral-|text-gray-)/.test(c));
      btn.className = [...new Set([...hostClasses, 'movy-cast-btn'])].join(' ');
    }

    const fsRect = fsBtn.getBoundingClientRect();
    if (fsSvg) {
      const sr = fsSvg.getBoundingClientRect();
      if (sr.width >= 16 && sr.width <= 44 && sr.height >= 16 && sr.height <= 44) {
        castSvg.style.width = `${Math.round(sr.width)}px`;
        castSvg.style.height = `${Math.round(sr.height)}px`;
      }
    } else if (fsRect.width >= 18 && fsRect.width <= 44) {
      castSvg.style.width = `${Math.round(fsRect.width)}px`;
      castSvg.style.height = `${Math.round(fsRect.height)}px`;
    }

    btn.style.color = detectRealIconColor(fsBtn, fsSvg);
    btn.style.opacity = '1';
  }

  function ensureCastButton(video) {
    const fsBtn = findFullscreenButton(video);
    if (!fsBtn || !fsBtn.parentElement) return;

    if (castBtn && castBtn.isConnected && castBtn.nextElementSibling === fsBtn) {
      anchoredFsBtn = fsBtn;
      syncButtonWithFullscreen(castBtn, fsBtn);
      return;
    }

    document.querySelectorAll('[data-movy-cast-btn="1"]').forEach(el => el.remove());

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.movyCastBtn = '1';
    btn.title = '投屏与字幕 (Movy Cast)';
    btn.setAttribute('aria-label', '投屏与字幕');
    btn.innerHTML = CAST_SVG_HTML;

    btn.addEventListener('pointerdown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(video);
    });

    fsBtn.parentElement.insertBefore(btn, fsBtn);
    castBtn = btn;
    anchoredFsBtn = fsBtn;
    syncButtonWithFullscreen(btn, fsBtn);
  }

  // ---------- Shadow DOM Popover Panel (Lives Inside Player Root, Auto-Closes Like YouTube) ----------

  function onOutsidePointerDown(e) {
    if (!panelHost) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (path.includes(panelHost)) return;
    if (castBtn && path.includes(castBtn)) return;
    closePanel();
  }

  function onDocKeyDown(e) {
    if (e.key === 'Escape' && panelHost) {
      e.stopPropagation();
      closePanel();
    }
  }

  function closePanel() {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
    clearInterval(pollTimer);
    pollTimer = null;
    isSeeking = false;
    if (panelHost) {
      panelHost.remove();
      panelHost = null;
      panelShadow = null;
    }
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
  }

  function scheduleAutoClose(ms = 1100) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(closePanel, ms);
  }

  async function togglePanel(video) {
    if (panelHost) {
      closePanel();
      return;
    }
    const playerRoot = findPlayerRoot(video) || document.fullscreenElement || document.body;
    if (window.getComputedStyle(playerRoot).position === 'static') playerRoot.style.position = 'relative';

    panelHost = document.createElement('div');
    panelHost.id = 'movy-cast-panel-host';
    panelHost.style.cssText = 'position:absolute;right:16px;bottom:58px;z-index:2147483646;';
    panelShadow = panelHost.attachShadow({ mode: 'open' });

    // Prevent clicks/typing inside panel from triggering player hotkeys (space, F, M, arrows)
    ['pointerdown', 'click', 'keydown', 'keyup', 'keypress'].forEach(evt => {
      panelHost.addEventListener(evt, e => e.stopPropagation());
    });

    panelShadow.innerHTML = `<style>${PANEL_SHADOW_CSS}</style><div class="panel"><div class="body"><div class="muted">加载中…</div></div></div>`;
    playerRoot.appendChild(panelHost);

    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);

    await renderPanel();
    pollTimer = setInterval(pollRemoteStatus, 2500);
  }

  async function pollRemoteStatus() {
    if (!panelShadow) return;
    try {
      const st = await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/status' });
      if (!st?.ok || !st.data?.active) return;
      const d = st.data;
      const seekBar = panelShadow.querySelector('#seek');
      const curEl = panelShadow.querySelector('#cur');
      const durEl = panelShadow.querySelector('#dur');
      const ppBtn = panelShadow.querySelector('#pp');
      const volBar = panelShadow.querySelector('#vol');
      const volVal = panelShadow.querySelector('#volv');

      if (ppBtn) {
        const paused = d.state === 'PAUSED_PLAYBACK';
        ppBtn.dataset.ctrl = paused ? 'play' : 'pause';
        ppBtn.textContent = paused ? '继续' : '暂停';
      }
      if (!isSeeking && seekBar && d.duration > 0) {
        seekBar.max = d.duration;
        seekBar.value = Math.min(d.position, d.duration);
        if (curEl) curEl.textContent = formatTime(d.position);
        if (durEl) durEl.textContent = formatTime(d.duration);
      }
      if (volBar && typeof d.volume === 'number') {
        volBar.value = d.volume;
        if (volVal) volVal.textContent = String(d.volume);
      }
    } catch {}
  }

  function buildDefaultQuery(meta) {
    if (!meta?.title || meta.title === 'Movy Video') return '';
    let q = meta.title;
    if (meta.mediaType === 'series' && meta.season > 0 && meta.episode > 0 && !/S\d+E\d+/i.test(q)) {
      q += ` S${String(meta.season).padStart(2, '0')}E${String(meta.episode).padStart(2, '0')}`;
    }
    return q;
  }

  async function renderPanel(statusMsg = '', autoSearchSubs = false) {
    if (!panelShadow) return;
    const resp = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE' }).catch(() => null);
    if (!resp) return;

    const state = resp.state || {};
    const meta = state.pageMeta || {};
    const title = meta.title && meta.title !== 'Movy Video' ? meta.title : 'Movy 视频';
    const sync = resp.sync || { subtitleOffset: 0, audioOffset: 0, mode: 'subtitle' };
    currentSync = sync;
    const extSubEnabled = Boolean(state.extSubEnabled);
    const autoContinue = Boolean(resp.autoContinueCast);
    const hasStream = (state.streams || []).length > 0;
    const queryValue = subQueryDraft || buildDefaultQuery(meta);

    let bridgeOnline = false;
    let ffmpegAvailable = false;
    let devices = [];
    let session = null;
    let playback = { position: 0, duration: 0, state: 'PLAYING', volume: 50 };

    try {
      const h = await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/health' });
      if (h?.ok) {
        bridgeOnline = true;
        ffmpegAvailable = Boolean(h.data?.ffmpegAvailable);
        session = h.data?.session || null;
        const d = await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/devices' });
        if (d?.ok) devices = d.data?.devices || [];
        if (session) {
          const st = await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/status' });
          if (st?.ok && st.data?.active) playback = st.data;
        }
      }
    } catch {}

    const isAudio = sync.mode === 'audio';
    const offsetVal = isAudio ? (sync.audioOffset || 0) : (sync.subtitleOffset || 0);
    const offsetStr = `${offsetVal >= 0 ? '+' : ''}${Number(offsetVal).toFixed(1)}s`;

    let body = '';

    if (!bridgeOnline) {
      body += `<div class="notice">本地投屏桥接未就绪，请运行一次 <code>bridge/install-autostart.bat</code> 并刷新页面。</div>`;
    } else {
      body += `<div class="sec-head"><span>局域网电视</span><div class="links"><button class="link" data-act="manual">手动</button><button class="link" data-act="refresh">刷新</button></div></div>`;
      if (manualAddOpen) {
        body += `<div class="row"><input id="manualIp" type="text" placeholder="http://192.168.x.x:端口/..." /><button class="btn-sm" data-act="add-manual">添加</button></div>`;
      }
      if (!devices.length) {
        body += `<div class="muted">未发现电视，请确认与电脑在同一 Wi-Fi</div>`;
      } else {
        body += `<div class="list">` + devices.map(dev => {
          const casting = session && session.udn === dev.udn;
          return `<button class="dev ${casting ? 'active' : ''}" data-act="cast" data-udn="${escapeHtml(dev.udn)}"><span class="trunc">${escapeHtml(dev.name)}</span><span class="tag-muted">${casting ? '投屏中' : '投屏'}</span></button>`;
        }).join('') + `</div>`;
      }

      if (session) {
        const paused = playback.state === 'PAUSED_PLAYBACK';
        body += `<div class="divider"></div>`;
        body += `<div class="sec-head"><span>遥控 · ${escapeHtml(session.deviceName || '电视')}</span><label class="chk"><input id="autoCont" type="checkbox" ${autoContinue ? 'checked' : ''} /><span>换集续投</span></label></div>`;
        body += `<input id="seek" type="range" min="0" max="${Math.max(100, playback.duration || 100)}" value="${Math.min(playback.position || 0, playback.duration || 100)}" />`;
        body += `<div class="time-row"><span id="cur">${formatTime(playback.position)}</span><span id="dur">${formatTime(playback.duration)}</span></div>`;
        body += `<div class="row"><button id="pp" class="btn" data-act="ctrl" data-ctrl="${paused ? 'play' : 'pause'}">${paused ? '继续' : '暂停'}</button><button class="btn danger" data-act="ctrl" data-ctrl="stop">停止投屏</button></div>`;
        body += `<div class="row"><span class="muted">音量</span><input id="vol" type="range" min="0" max="100" value="${typeof playback.volume === 'number' ? playback.volume : 50}" /><span id="volv" class="vol-val">${typeof playback.volume === 'number' ? playback.volume : 50}</span></div>`;
      }
    }

    body += `<div class="divider"></div>`;
    body += `<div class="sec-head"><span>${isAudio ? '音频延迟' : '字幕同步'}</span><button class="link" data-act="mode">切到${isAudio ? '字幕' : '音频'}</button></div>`;
    if (!isAudio) {
      body += `<button class="btn-primary" data-act="auto-sync">一键自动校准字幕</button>`;
    } else if (!ffmpegAvailable) {
      body += `<div class="muted">网页音频延迟受跨域限制时请切 Quality 线路；投屏端装 FFmpeg 自动支持。</div>`;
    }
    body += `<div class="row">` +
      `<button class="btn" data-act="off" data-d="-0.5">-0.5</button>` +
      `<button class="btn" data-act="off" data-d="-0.1">-0.1</button>` +
      `<span class="offset">${offsetStr}</span>` +
      `<button class="btn" data-act="off" data-d="0.1">+0.1</button>` +
      `<button class="btn" data-act="off" data-d="0.5">+0.5</button>` +
      `<button class="btn" data-act="off" data-d="0">归零</button>` +
      `</div>`;

    body += `<div class="divider"></div>`;
    body += `<div class="sec-head"><span>插件中文字幕</span><label class="switch" title="开启或关闭插件外挂字幕"><input id="extSub" type="checkbox" ${extSubEnabled ? 'checked' : ''} /><span class="slider"></span></label></div>`;

    if (extSubEnabled) {
      body += `<div class="row"><input id="subQ" type="text" value="${escapeHtml(queryValue)}" placeholder="自动填入当前片名" /><button class="btn-sm" data-act="search-sub">搜索</button></div>`;
      body += `<div class="sub-list" id="subList">`;
      if (cachedSubResults.length) {
        body += renderSubItems(cachedSubResults, state.externalSub?.url || '');
      } else {
        body += `<div class="muted">点「搜索」查找简体中文字幕</div>`;
      }
      body += `</div>`;
    } else {
      body += `<div class="muted">已关闭（当前使用网页原生字幕）</div>`;
    }

    if (statusMsg) body += `<div class="status">${escapeHtml(statusMsg)}</div>`;

    panelShadow.innerHTML =
      `<style>${PANEL_SHADOW_CSS}</style>` +
      `<div class="panel">` +
      `<div class="hdr"><div class="hdr-left"><span class="dot ${bridgeOnline ? 'on' : ''}"></span><span class="title">${escapeHtml(title)}</span><span class="pill ${hasStream ? 'ready' : ''}">${hasStream ? state.streams[0].type : '待播放'}</span></div><button class="close" aria-label="关闭">×</button></div>` +
      `<div class="body">${body}</div>` +
      `</div>`;

    bindPanelEvents({ bridgeOnline, sync, meta, state });

    if (autoSearchSubs && extSubEnabled && bridgeOnline) {
      runSubSearch(meta, state);
    }
  }

  function renderSubItems(subs, activeUrl) {
    return subs.slice(0, 12).map(s =>
      `<button class="sub-item ${s.url === activeUrl ? 'active' : ''}" data-url="${escapeHtml(s.url)}" data-label="${escapeHtml(s.label)}">` +
      `<span class="sub-tag">${escapeHtml(s.tag)}</span><span class="trunc">${escapeHtml(s.label)}</span></button>`
    ).join('');
  }

  async function runSubSearch(meta, state) {
    const box = panelShadow?.querySelector('#subList');
    const qEl = panelShadow?.querySelector('#subQ');
    if (!box) return;
    const customQ = qEl ? qEl.value.trim() : '';
    subQueryDraft = customQ;
    box.innerHTML = `<div class="muted">正在搜索「${escapeHtml(customQ || meta.title || '')}」中文字幕…</div>`;

    const payload = customQ
      ? { title: customQ, mediaType: meta.mediaType || 'movie', season: 0, episode: 0 }
      : { ...meta };
    const r = await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/subtitles/search', method: 'POST', body: payload });
    const subs = r?.ok ? (r.data?.subtitles || []) : [];
    cachedSubResults = subs;
    if (!subs.length) {
      box.innerHTML = '<div class="muted">未找到中文字幕，可修改英文片名重试</div>';
      return;
    }
    box.innerHTML = renderSubItems(subs, state.externalSub?.url || '');
    bindSubClicks(box);
  }

  function bindSubClicks(box) {
    box.querySelectorAll('.sub-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        const res = await chrome.runtime.sendMessage({
          type: 'LOAD_EXTERNAL_SUBTITLE',
          url: btn.dataset.url,
          label: btn.dataset.label
        });
        renderPanel(res?.ok ? '已加载中文字幕（不齐可点上方一键校准）' : (res?.error || '字幕加载失败'));
      });
    });
  }

  function bindPanelEvents({ bridgeOnline, sync, meta, state }) {
    const root = panelShadow;
    root.querySelector('.close')?.addEventListener('click', closePanel);

    root.querySelector('[data-act="refresh"]')?.addEventListener('click', async e => {
      e.target.textContent = '搜索中…';
      await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/devices?refresh=1' }).catch(() => {});
      renderPanel();
    });

    root.querySelector('[data-act="manual"]')?.addEventListener('click', () => {
      manualAddOpen = !manualAddOpen;
      renderPanel();
    });

    root.querySelector('[data-act="add-manual"]')?.addEventListener('click', async () => {
      const loc = root.querySelector('#manualIp')?.value.trim();
      if (!loc) return;
      const r = await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/devices/add', method: 'POST', body: { location: loc } });
      if (r?.ok) { manualAddOpen = false; renderPanel('已添加电视设备'); }
      else renderPanel(r?.error || '无法解析该地址');
    });

    root.querySelectorAll('[data-act="cast"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r = await chrome.runtime.sendMessage({ type: 'CAST_NOW', udn: btn.dataset.udn });
        await renderPanel(r?.ok ? '已推送到电视' : (r?.error || '投屏失败'));
        if (r?.ok) scheduleAutoClose(1000);
      });
    });

    root.querySelectorAll('[data-act="ctrl"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.ctrl;
        await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/control', method: 'POST', body: { action } }).catch(() => {});
        await renderPanel(action === 'stop' ? '已停止投屏' : '');
        if (action === 'stop') scheduleAutoClose(900);
      });
    });

    const seek = root.querySelector('#seek');
    if (seek) {
      seek.addEventListener('input', () => {
        isSeeking = true;
        const c = root.querySelector('#cur');
        if (c) c.textContent = formatTime(seek.value);
      });
      seek.addEventListener('change', async () => {
        await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/control', method: 'POST', body: { action: 'seek', value: Number(seek.value) } }).catch(() => {});
        isSeeking = false;
      });
    }

    const vol = root.querySelector('#vol');
    if (vol) {
      vol.addEventListener('input', () => {
        const vv = root.querySelector('#volv');
        if (vv) vv.textContent = vol.value;
      });
      vol.addEventListener('change', async () => {
        await chrome.runtime.sendMessage({ type: 'BRIDGE_API', path: '/api/control', method: 'POST', body: { action: 'volume', value: Number(vol.value) } }).catch(() => {});
      });
    }

    root.querySelector('#autoCont')?.addEventListener('change', e => {
      chrome.runtime.sendMessage({ type: 'SET_AUTO_CONTINUE', value: e.target.checked }).catch(() => {});
    });

    root.querySelector('[data-act="mode"]')?.addEventListener('click', async () => {
      const next = { ...sync, mode: sync.mode === 'audio' ? 'subtitle' : 'audio' };
      await chrome.runtime.sendMessage({ type: 'APPLY_SYNC', sync: next });
      renderPanel();
    });

    root.querySelector('[data-act="auto-sync"]')?.addEventListener('click', async e => {
      const btn = e.target;
      btn.textContent = '正在校准…';
      btn.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: 'AUTO_CALIBRATE_SYNC' });
      if (r?.ok) {
        const sign = r.offsetSec >= 0 ? '+' : '';
        const tip = r.method === 'reference'
          ? `已按原片时间轴自动对齐（${sign}${r.offsetSec.toFixed(1)}s）`
          : `已对齐当前说话时刻（${sign}${r.offsetSec.toFixed(1)}s）`;
        renderPanel(tip);
      } else {
        renderPanel(r?.error || '自动校准失败');
      }
    });

    root.querySelectorAll('[data-act="off"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const d = Number(btn.dataset.d);
        const next = { ...sync };
        if (sync.mode === 'audio') {
          next.audioOffset = d === 0 ? 0 : Math.max(0, Math.min(5, Number(((sync.audioOffset || 0) + d).toFixed(1))));
        } else {
          next.subtitleOffset = d === 0 ? 0 : Number(((sync.subtitleOffset || 0) + d).toFixed(1));
        }
        const r = await chrome.runtime.sendMessage({ type: 'APPLY_SYNC', sync: next });
        const audioErr = sync.mode === 'audio' && r?.audioResult?.ok === false ? r.audioResult.reason : '';
        renderPanel(audioErr);
      });
    });

    root.querySelector('#extSub')?.addEventListener('change', async e => {
      const enabled = e.target.checked;
      await chrome.runtime.sendMessage({ type: 'SET_EXT_SUB_ENABLED', enabled });
      if (!enabled) {
        renderPanel('已关闭插件字幕，恢复原生字幕');
      } else {
        const shouldSearch = !cachedSubResults.length && !state.externalSub?.url;
        renderPanel(state.externalSub?.url ? '已恢复外挂中文字幕' : '', shouldSearch);
      }
    });

    const subQ = root.querySelector('#subQ');
    if (subQ) {
      subQ.addEventListener('input', () => { subQueryDraft = subQ.value; });
      subQ.addEventListener('keydown', e => {
        if (e.key === 'Enter' && bridgeOnline) runSubSearch(meta, state);
      });
    }

    root.querySelector('[data-act="search-sub"]')?.addEventListener('click', () => {
      if (!bridgeOnline) return renderPanel('请先完成自动启动注册');
      runSubSearch(meta, state);
    });

    const subList = root.querySelector('#subList');
    if (subList) bindSubClicks(subList);
  }

  // ---------- Lifecycle Observer ----------

  function scanForVideo() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      cachedSubResults = [];
      subQueryDraft = '';
      closePanel();
    }
    const video = findPrimaryVideo();
    if (!video) return;
    hookVideo(video);
    ensureCastButton(video);
    if (customCues.length) {
      ensureSubHost(video);
      syncSubtitleVisualStyle(findPlayerRoot(video));
    }
  }

  const observer = new MutationObserver(() => scanForVideo());
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => {
    if (castBtn && anchoredFsBtn) syncButtonWithFullscreen(castBtn, anchoredFsBtn);
    const v = findPrimaryVideo();
    if (v && customCues.length) syncSubtitleVisualStyle(findPlayerRoot(v));
  });
  document.addEventListener('fullscreenchange', () => {
    closePanel();
    setTimeout(scanForVideo, 150);
  });
  setInterval(scanForVideo, 1500);
  scanForVideo();

  try {
    const stateResp = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE' });
    if (stateResp?.sync) {
      currentSync = stateResp.sync;
      const v = findPrimaryVideo();
      if (v) {
        if (currentSync.subtitleOffset) applyNativeTrackOffset(v, currentSync.subtitleOffset);
        if (currentSync.mode === 'audio' && currentSync.audioOffset > 0) applyAudioDelay(v, currentSync.audioOffset);
      }
    }
  } catch {}

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const video = findPrimaryVideo();

    if (msg.type === 'SYNC_UPDATED' && msg.sync) {
      currentSync = msg.sync;
      let audioRes = { ok: true };
      if (video) {
        applyNativeTrackOffset(video, Number(currentSync.subtitleOffset) || 0);
        audioRes = applyAudioDelay(video, currentSync.mode === 'audio' ? Number(currentSync.audioOffset) || 0 : 0);
        renderCustomCueNow();
      }
      sendResponse(audioRes);
      return;
    }

    if (msg.type === 'INJECT_VTT_SUBTITLE' && msg.vtt) {
      sendResponse({ ok: loadCustomVttSubtitle(msg.vtt) });
      return;
    }

    if (msg.type === 'CLEAR_VTT_SUBTITLE') {
      clearCustomSubtitle();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'SNAP_SUBTITLE_TO_NOW') {
      if (!video || !customCues.length) {
        sendResponse({ ok: false, error: '当前未检测到可校准的字幕，请先开启字幕或搜索中文字幕' });
        return;
      }
      const now = video.currentTime;
      const lookupTime = now - (Number(currentSync.subtitleOffset) || 0);
      let nearest = null;
      let bestDist = Infinity;
      for (let i = 0; i < customCues.length; i++) {
        const dist = Math.abs(customCues[i].start - lookupTime);
        if (dist < bestDist) { bestDist = dist; nearest = customCues[i]; }
      }
      if (!nearest || bestDist > 45) {
        sendResponse({ ok: false, error: '当前位置附近没有台词，请在人物开口说话时点击一键校准' });
        return;
      }
      sendResponse({ ok: true, offsetSec: Number((now - nearest.start).toFixed(1)), cueText: nearest.text.slice(0, 24) });
      return;
    }

    if (msg.type === 'GET_VIDEO_TIME') {
      if (video && !Number.isNaN(video.currentTime)) sendResponse({ currentTime: Math.floor(video.currentTime) });
      return;
    }

    if (msg.type === 'PAUSE_VIDEO' && video && !video.paused) {
      try { video.pause(); } catch {}
    }
  });
})();
