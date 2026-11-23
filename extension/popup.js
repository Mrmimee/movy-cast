'use strict';

const $ = id => document.getElementById(id);

let tabId = null;
let tabState = null;
let syncState = { subtitleOffset: 0, audioOffset: 0, mode: 'subtitle' };
let bridgeOnline = false;
let ffmpegAvailable = false;
let activeSession = null;
let transportState = 'STOPPED';
let isSeeking = false;
let statusTimer = null;

function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) {
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function showToast(msg) {
  const el = $('toast');
  if (!msg) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function bg(msg) {
  return chrome.runtime.sendMessage(msg);
}

function renderSyncUI() {
  const isAudio = syncState.mode === 'audio';
  $('modeSubBtn').classList.toggle('active', !isAudio);
  $('modeAudioBtn').classList.toggle('active', isAudio);
  $('autoSyncBtn').classList.toggle('hidden', isAudio);

  const val = isAudio ? (syncState.audioOffset || 0) : (syncState.subtitleOffset || 0);
  const formatted = `${val >= 0 ? '+' : ''}${Number(val).toFixed(1)}s`;
  $('offsetDisplay').textContent = formatted;
  $('syncSummaryVal').textContent = `${isAudio ? '音 ' : '字 '}${formatted}`;

  if (isAudio) {
    $('syncHint').textContent = ffmpegAvailable
      ? '声音比画面快时加延迟（网页与投屏均支持）。'
      : '网页端可延迟音频；电视端音频偏移需安装 FFmpeg。';
  } else {
    $('syncHint').textContent = '点「一键自动校准」可按原片时间轴或说话瞬间对齐。';
  }
}

function renderExtSubToggle() {
  const enabled = Boolean(tabState?.extSubEnabled);
  $('extSubToggle').checked = enabled;
  $('extSubLabel').textContent = enabled ? '已开' : '已关';
  $('subFoldBody').classList.toggle('hidden', !enabled);
}

function renderMediaHeader() {
  if (!tabState || !tabState.isMovy) {
    $('mediaTitle').textContent = '请先打开 movy.sx 视频页';
    $('streamBadge').textContent = '未在站点';
    $('streamBadge').classList.remove('ready');
    $('subBadge').classList.add('hidden');
    return;
  }

  const title = tabState.pageMeta?.title || 'Movy 视频';
  $('mediaTitle').textContent = title;
  if (!$('subQueryInput').dataset.userEdited && title && title !== 'Movy 视频' && title !== 'Movy Video') {
    const meta = tabState.pageMeta || {};
    let autoQuery = title;
    if (meta.mediaType === 'series' && meta.season > 0 && meta.episode > 0 && !/S\d+E\d+/i.test(autoQuery)) {
      autoQuery += ` S${String(meta.season).padStart(2, '0')}E${String(meta.episode).padStart(2, '0')}`;
    }
    $('subQueryInput').value = autoQuery;
  }

  const streams = tabState.streams || [];
  if (streams.length) {
    $('streamBadge').textContent = streams[0].type;
    $('streamBadge').classList.add('ready');
  } else {
    $('streamBadge').textContent = '待播放';
    $('streamBadge').classList.remove('ready');
  }

  const subs = tabState.subtitles || [];
  if (subs.length) {
    const hasZh = subs.some(s => s.isZh);
    $('subBadge').textContent = hasZh ? '中文字幕' : '外挂字幕';
    $('subBadge').classList.remove('hidden');
  } else {
    $('subBadge').classList.add('hidden');
  }
}

function renderDevices(devices) {
  const listEl = $('deviceList');
  if (!bridgeOnline) {
    listEl.innerHTML = '';
    return;
  }
  if (!devices || !devices.length) {
    listEl.innerHTML = '<div class="muted">未发现局域网电视，请确认与电脑在同一 Wi-Fi</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const dev of devices) {
    const btn = document.createElement('button');
    const isCasting = activeSession && activeSession.udn === dev.udn;
    btn.className = `device-item ${isCasting ? 'active' : ''}`;
    btn.innerHTML =
      `<span class="device-name"></span>` +
      `<span class="device-tag">${isCasting ? '投屏中' : '点击投屏'}</span>`;
    btn.querySelector('.device-name').textContent = dev.name;
    btn.addEventListener('click', () => handleCast(dev.udn));
    listEl.appendChild(btn);
  }
}

async function handleCast(udn) {
  showToast('正在推送到电视…');
  const res = await bg({ type: 'CAST_NOW', tabId, udn });
  if (!res?.ok) {
    showToast(res?.error || '投屏失败');
    return;
  }
  activeSession = res.data?.session || null;
  showToast('已开始投屏');
  await refreshBridgeState(false);
}

async function refreshBridgeState(forceDiscover = false) {
  try {
    const snap = await bg({
      type: 'BRIDGE_API',
      path: forceDiscover ? '/api/devices?refresh=1' : '/api/snapshot'
    });
    if (!snap?.ok) throw new Error('offline');
    bridgeOnline = true;
    if (!forceDiscover) {
      ffmpegAvailable = Boolean(snap.data?.ffmpegAvailable);
      activeSession = snap.data?.session || null;
    }
    $('bridgeDot').classList.add('online');
    $('offlineNotice').classList.add('hidden');
    $('devicesSection').classList.remove('hidden');

    renderDevices(snap.data?.devices || []);
    renderSyncUI();
    if (activeSession) pollPlaybackStatus();
  } catch {
    bridgeOnline = false;
    activeSession = null;
    $('bridgeDot').classList.remove('online');
    $('offlineNotice').classList.remove('hidden');
    $('devicesSection').classList.add('hidden');
    $('remoteSection').classList.add('hidden');
  }
}

async function pollPlaybackStatus() {
  if (!bridgeOnline) return;
  try {
    const st = await bg({ type: 'BRIDGE_API', path: '/api/status' });
    if (!st?.ok || !st.data?.active) {
      activeSession = null;
      $('remoteSection').classList.add('hidden');
      return;
    }

    const d = st.data;
    activeSession = d.session;
    transportState = d.state || 'PLAYING';
    $('remoteSection').classList.remove('hidden');
    $('castingLabel').textContent = `投屏中 · ${d.session?.deviceName || '电视'}`;
    $('playPauseBtn').textContent = transportState === 'PAUSED_PLAYBACK' ? '继续播放' : '暂停';

    if (!isSeeking && d.duration > 0) {
      $('seekBar').max = d.duration;
      $('seekBar').value = Math.min(d.position, d.duration);
      $('curTime').textContent = formatTime(d.position);
      $('durTime').textContent = formatTime(d.duration);
    }

    if (typeof d.volume === 'number') {
      $('volBar').value = d.volume;
      $('volVal').textContent = String(d.volume);
    }
  } catch {}
}

async function updateSync(next) {
  syncState = { ...syncState, ...next };
  renderSyncUI();
  await bg({ type: 'APPLY_SYNC', tabId, sync: syncState });
}

async function handleSubtitleSearch() {
  if (!bridgeOnline) {
    showToast('请先启动本地桥接服务');
    return;
  }
  const box = $('subResults');
  box.innerHTML = '<div class="muted">正在搜索中文字幕…</div>';

  const customQuery = $('subQueryInput').value.trim();
  const meta = tabState?.pageMeta || {};
  const payload = {
    imdbId: customQuery ? '' : (meta.imdbId || ''),
    title: customQuery || meta.title || '',
    year: customQuery ? '' : (meta.year || ''),
    mediaType: meta.mediaType || 'movie',
    season: meta.season || 0,
    episode: meta.episode || 0
  };

  if (!payload.title && !payload.imdbId) {
    box.innerHTML = '<div class="muted">请输入英文或中文片名后搜索</div>';
    return;
  }

  const res = await bg({
    type: 'BRIDGE_API',
    path: '/api/subtitles/search',
    method: 'POST',
    body: payload
  });

  const subs = res?.ok ? (res.data?.subtitles || []) : [];
  if (!subs.length) {
    box.innerHTML = '<div class="muted">未找到匹配的中文字幕，可尝试输入英文原名搜索</div>';
    return;
  }

  box.innerHTML = '';
  for (const s of subs) {
    const btn = document.createElement('button');
    btn.className = 'sub-item';
    btn.innerHTML = `<span class="sub-tag"></span><span class="device-name"></span>`;
    btn.querySelector('.sub-tag').textContent = s.tag || '中';
    btn.querySelector('.device-name').textContent = s.label;
    btn.addEventListener('click', async () => {
      showToast('正在加载字幕…');
      const r = await bg({
        type: 'LOAD_EXTERNAL_SUBTITLE',
        tabId,
        url: s.url,
        label: s.label
      });
      if (r?.ok) {
        showToast('中文字幕已加载（网页与投屏同步）');
        const refreshed = await bg({ type: 'GET_TAB_STATE', tabId });
        if (refreshed?.state) {
          tabState = refreshed.state;
          renderMediaHeader();
        }
      } else {
        showToast(r?.error || '字幕加载失败');
      }
    });
    box.appendChild(btn);
  }
}

// ---------- Wire Events ----------

$('refreshBtn').addEventListener('click', async () => {
  $('refreshBtn').textContent = '搜索中…';
  await refreshBridgeState(true);
  $('refreshBtn').textContent = '刷新';
});

$('manualToggle').addEventListener('click', () => {
  $('manualBox').classList.toggle('hidden');
});

$('manualAddBtn').addEventListener('click', async () => {
  const loc = $('manualInput').value.trim();
  if (!loc) return;
  const r = await bg({
    type: 'BRIDGE_API',
    path: '/api/devices/add',
    method: 'POST',
    body: { location: loc }
  });
  if (r?.ok) {
    $('manualInput').value = '';
    $('manualBox').classList.add('hidden');
    renderDevices(r.data?.devices || []);
    showToast('已添加电视设备');
  } else {
    showToast(r?.error || '无法解析该地址');
  }
});

$('playPauseBtn').addEventListener('click', async () => {
  const action = transportState === 'PAUSED_PLAYBACK' ? 'play' : 'pause';
  await bg({ type: 'BRIDGE_API', path: '/api/control', method: 'POST', body: { action } });
  await pollPlaybackStatus();
});

$('stopBtn').addEventListener('click', async () => {
  await bg({ type: 'BRIDGE_API', path: '/api/control', method: 'POST', body: { action: 'stop' } });
  activeSession = null;
  $('remoteSection').classList.add('hidden');
  await refreshBridgeState(false);
  showToast('已停止投屏');
});

$('seekBar').addEventListener('input', () => {
  isSeeking = true;
  $('curTime').textContent = formatTime($('seekBar').value);
});

$('seekBar').addEventListener('change', async () => {
  const sec = Number($('seekBar').value);
  await bg({ type: 'BRIDGE_API', path: '/api/control', method: 'POST', body: { action: 'seek', value: sec } });
  isSeeking = false;
});

$('volBar').addEventListener('input', () => {
  $('volVal').textContent = $('volBar').value;
});

$('volBar').addEventListener('change', async () => {
  await bg({
    type: 'BRIDGE_API',
    path: '/api/control',
    method: 'POST',
    body: { action: 'volume', value: Number($('volBar').value) }
  });
});

$('autoContinueChk').addEventListener('change', () => {
  bg({ type: 'SET_AUTO_CONTINUE', value: $('autoContinueChk').checked });
});

function adjustOffset(delta) {
  if (syncState.mode === 'audio') {
    const next = delta === 0 ? 0 : Math.max(0, Math.min(5, Number(((syncState.audioOffset || 0) + delta).toFixed(1))));
    updateSync({ audioOffset: next });
  } else {
    const next = delta === 0 ? 0 : Number(((syncState.subtitleOffset || 0) + delta).toFixed(1));
    updateSync({ subtitleOffset: next });
  }
}

$('modeSubBtn').addEventListener('click', () => updateSync({ mode: 'subtitle' }));
$('modeAudioBtn').addEventListener('click', () => updateSync({ mode: 'audio' }));
$('offsetMinusBig').addEventListener('click', () => adjustOffset(-0.5));
$('offsetMinus').addEventListener('click', () => adjustOffset(-0.1));
$('offsetPlus').addEventListener('click', () => adjustOffset(0.1));
$('offsetPlusBig').addEventListener('click', () => adjustOffset(0.5));
$('offsetReset').addEventListener('click', () => adjustOffset(0));

$('autoSyncBtn').addEventListener('click', async () => {
  const btn = $('autoSyncBtn');
  btn.textContent = '正在校准…';
  btn.disabled = true;
  const r = await bg({ type: 'AUTO_CALIBRATE_SYNC', tabId });
  btn.textContent = '一键自动校准字幕';
  btn.disabled = false;
  if (r?.ok && r.sync) {
    syncState = r.sync;
    renderSyncUI();
    const sign = r.offsetSec >= 0 ? '+' : '';
    showToast(
      r.method === 'reference'
        ? `已按原片时间轴自动对齐（${sign}${r.offsetSec.toFixed(1)}s）`
        : `已对齐当前说话时刻（${sign}${r.offsetSec.toFixed(1)}s）`
    );
  } else {
    showToast(r?.error || '自动校准失败');
  }
});

let subAutoSearched = false;

$('extSubToggleWrap').addEventListener('click', e => e.stopPropagation());
$('extSubToggle').addEventListener('change', async () => {
  const enabled = $('extSubToggle').checked;
  if (tabState) tabState.extSubEnabled = enabled;
  renderExtSubToggle();
  await bg({ type: 'SET_EXT_SUB_ENABLED', tabId, enabled });
  if (enabled) {
    $('subFold').open = true;
    if (!subAutoSearched) {
      subAutoSearched = true;
      handleSubtitleSearch();
    }
    showToast('已开启插件中文字幕');
  } else {
    showToast('已关闭插件字幕，恢复原生字幕');
  }
});

$('subSearchBtn').addEventListener('click', () => {
  subAutoSearched = true;
  handleSubtitleSearch();
});
$('subQueryInput').addEventListener('input', () => {
  $('subQueryInput').dataset.userEdited = '1';
});
$('subQueryInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    subAutoSearched = true;
    handleSubtitleSearch();
  }
});
$('subFold').addEventListener('toggle', () => {
  if ($('subFold').open && tabState?.extSubEnabled && !subAutoSearched) {
    subAutoSearched = true;
    handleSubtitleSearch();
  }
});

// ---------- Boot ----------

(async function init() {
  const resp = await bg({ type: 'GET_TAB_STATE' });
  tabId = resp?.tabId ?? null;
  tabState = resp?.state || null;
  syncState = resp?.sync || { subtitleOffset: 0, audioOffset: 0, mode: 'subtitle' };
  $('autoContinueChk').checked = Boolean(resp?.autoContinueCast);

  // Pull fresh movie/episode title directly from the active movy.sx page
  if (tabId !== null && tabState?.isMovy) {
    try {
      const fresh = await chrome.tabs.sendMessage(tabId, { type: 'GET_FRESH_META' });
      if (fresh?.meta) {
        tabState.pageMeta = { ...(tabState.pageMeta || {}), ...fresh.meta };
      }
    } catch {}
  }

  renderMediaHeader();
  renderSyncUI();
  renderExtSubToggle();
  await refreshBridgeState(false);

  statusTimer = setInterval(pollPlaybackStatus, 2500);
  window.addEventListener('unload', () => clearInterval(statusTimer));
})();
