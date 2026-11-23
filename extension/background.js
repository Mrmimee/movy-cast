'use strict';

const BRIDGE_BASE = 'http://127.0.0.1:18923';
const NATIVE_HOST_NAME = 'com.movy.cast';

// tabId -> { isMovy, pageUrl, mediaKey, streams: [], subtitles: [], selectedStreamUrl, selectedSubtitleUrl, pageMeta }
const tabStates = new Map();
// requestId -> { referer, origin }
const reqHeaderCache = new Map();

let nativePort = null;
let nativeStartPromise = null;

function disconnectNativeIfNoMovyTabs() {
  const hasMovyTab = Array.from(tabStates.values()).some(s => s.isMovy);
  if (!hasMovyTab && nativePort) {
    try {
      nativePort.disconnect();
    } catch {}
    nativePort = null;
  }
}

async function isBridgeAlive() {
  try {
    const res = await fetch(`${BRIDGE_BASE}/api/health`, { signal: AbortSignal.timeout(450) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBridgeRunning() {
  if (await isBridgeAlive()) return true;
  if (nativeStartPromise) return nativeStartPromise;

  nativeStartPromise = new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      nativeStartPromise = null;
      resolve(ok);
    };

    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      nativePort = port;

      const timer = setTimeout(async () => {
        finish(await isBridgeAlive());
      }, 2800);

      port.onMessage.addListener(msg => {
        if (msg && msg.ok && (msg.event === 'ready' || msg.event === 'pong')) {
          clearTimeout(timer);
          finish(true);
        }
      });

      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (nativePort === port) nativePort = null;
        clearTimeout(timer);
        finish(false);
      });

      port.postMessage({ type: 'ping' });
    } catch {
      finish(false);
    }
  });

  return nativeStartPromise;
}

function isMovyUrl(url) {
  return typeof url === 'string' && /^https?:\/\/(www\.)?movy\.sx(\/|$)/i.test(url);
}

function getMediaKeyFromUrl(url) {
  try {
    const u = new URL(url);
    const season = u.searchParams.get('season') || u.searchParams.get('s') || '';
    const episode = u.searchParams.get('episode') || u.searchParams.get('e') || '';
    return `${u.pathname}${season ? `:s${season}` : ''}${episode ? `:e${episode}` : ''}`;
  } catch {
    return url || 'default';
  }
}

function ensureTabState(tabId, pageUrl = '') {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      isMovy: isMovyUrl(pageUrl),
      pageUrl,
      mediaKey: getMediaKeyFromUrl(pageUrl),
      streams: [],
      subtitles: [],
      selectedStreamUrl: '',
      selectedSubtitleUrl: '',
      extSubEnabled: false,
      externalSub: null, // { url, label }
      nativeTakeoverUrl: '',
      pageMeta: {}
    });
  }
  return tabStates.get(tabId);
}

function isChineseSubtitleHint(str) {
  return /(zh[-_]?cn|chs|simplified|zh[-_]?hans|zh[-_]?tw|cht|zh|chi|zho|chinese|简体|繁体|中文|双语)/i.test(str || '');
}

function isSimplifiedChineseHint(str) {
  return /(zh[-_]?cn|chs|simplified|zh[-_]?hans|简体|gb)/i.test(str || '');
}

function guessStreamLabel(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return 'HLS';
  if (/\.mp4(\?|$)/i.test(url)) return 'MP4';
  return 'VIDEO';
}

function isMediaUrl(url, contentType = '') {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (/^http:\/\/127\.0\.0\.1:18923/i.test(url)) return false;
  // Ignore obvious segments / previews / trackers
  if (/\.(ts|m4s|m4a|aac|mp3|jpg|jpeg|png|webp|gif|svg|css|js|woff2?|json)(\?|$)/i.test(url)) return false;
  if (/\.m3u8(\?|$)/i.test(url)) return true;
  if (/\.mp4(\?|$)/i.test(url) && !/(preview|thumb|sprite|banner|ad[s_-])/i.test(url)) return true;
  if (/application\/(vnd\.apple\.mpegurl|x-mpegurl)/i.test(contentType)) return true;
  return false;
}

function isSubtitleUrl(url, contentType = '') {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (/^http:\/\/127\.0\.0\.1:18923/i.test(url)) return false;
  if (/\.(vtt|srt)(\?|$)/i.test(url)) return true;
  if (/text\/(vtt|srt)/i.test(contentType)) return true;
  return false;
}

function addStream(tabId, url, headers) {
  const st = tabStates.get(tabId);
  if (!st || !st.isMovy) return;

  const existing = st.streams.find(s => s.url === url);
  if (existing) {
    existing.lastSeen = Date.now();
    if (headers && Object.keys(headers).length) existing.headers = { ...existing.headers, ...headers };
    return;
  }

  const isMaster = /master|index|playlist/i.test(url) && /\.m3u8/i.test(url);
  const item = {
    url,
    type: guessStreamLabel(url),
    headers: headers || {},
    isMaster,
    lastSeen: Date.now()
  };

  st.streams.unshift(item);
  if (st.streams.length > 8) st.streams.length = 8;

  // Prefer master HLS or newest stream
  const best = st.streams.find(s => s.isMaster) || st.streams[0];
  const prevSelected = st.selectedStreamUrl;
  st.selectedStreamUrl = best.url;

  // Update badge
  chrome.action.setBadgeText({ tabId, text: 'TV' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#18181b' }).catch(() => {});

  // Notify episode-change / new-stream continuation if actively casting
  if (prevSelected && prevSelected !== best.url) {
    handleNewStreamDuringCast(tabId, best).catch(() => {});
  }
}

function addSubtitle(tabId, url, headers, extraLabel = '') {
  const st = tabStates.get(tabId);
  if (!st || !st.isMovy) return;

  const existing = st.subtitles.find(s => s.url === url);
  if (existing) {
    existing.lastSeen = Date.now();
    return;
  }

  let label = extraLabel;
  if (!label) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      label = decodeURIComponent(parts[parts.length - 1] || 'Subtitle');
    } catch {
      label = 'Subtitle';
    }
  }

  const isSimplified = isSimplifiedChineseHint(label + ' ' + url);
  const isZh = isChineseSubtitleHint(label + ' ' + url);

  st.subtitles.unshift({
    url,
    label,
    headers: headers || {},
    isZh,
    isSimplified,
    lastSeen: Date.now()
  });

  if (st.subtitles.length > 12) st.subtitles.length = 12;

  // Sort: simplified Chinese first, then other Chinese, then latest
  st.subtitles.sort((a, b) => {
    const sa = (a.isSimplified ? 2 : a.isZh ? 1 : 0);
    const sb = (b.isSimplified ? 2 : b.isZh ? 1 : 0);
    if (sb !== sa) return sb - sa;
    return b.lastSeen - a.lastSeen;
  });

  // Auto-select best Chinese subtitle if none selected or a simplified one arrives
  if (!st.selectedSubtitleUrl || isSimplified) {
    st.selectedSubtitleUrl = st.subtitles[0].url;
  }
}

async function bridgeFetch(path, options = {}) {
  const reqInit = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  };
  let res;
  try {
    res = await fetch(`${BRIDGE_BASE}${path}`, reqInit);
  } catch {
    // Only spin up native host on actual connection failure (zero overhead when already running)
    const started = await ensureBridgeRunning();
    if (!started) throw new Error('Bridge offline');
    res = await fetch(`${BRIDGE_BASE}${path}`, reqInit);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Bridge HTTP ${res.status}`);
  }
  return data;
}

async function handleNewStreamDuringCast(tabId, newStream) {
  try {
    const health = await bridgeFetch('/api/health');
    const session = health.session;
    if (!session || !session.udn) return;
    if (session.mediaUrl === newStream.url) return;

    const stored = await chrome.storage.local.get(['autoContinueCast']);
    const st = tabStates.get(tabId);
    const title = st?.pageMeta?.title || 'Movy Video';

    if (stored.autoContinueCast) {
      await castForTab(tabId, { udn: session.udn, mediaUrl: newStream.url, startTime: 0 });
      chrome.tabs.sendMessage(tabId, {
        type: 'EPISODE_TOAST',
        mode: 'auto',
        deviceName: session.deviceName,
        title
      }).catch(() => {});
    } else {
      chrome.tabs.sendMessage(tabId, {
        type: 'EPISODE_TOAST',
        mode: 'prompt',
        udn: session.udn,
        deviceName: session.deviceName,
        mediaUrl: newStream.url,
        title
      }).catch(() => {});
    }
  } catch {
    // Bridge offline, ignore
  }
}

async function getSavedSync(mediaKey) {
  const store = await chrome.storage.local.get(['syncMap']);
  const map = store.syncMap || {};
  return map[mediaKey] || { subtitleOffset: 0, audioOffset: 0, mode: 'subtitle' };
}

async function saveSync(mediaKey, sync) {
  const store = await chrome.storage.local.get(['syncMap']);
  const map = store.syncMap || {};
  map[mediaKey] = {
    subtitleOffset: Number(sync.subtitleOffset) || 0,
    audioOffset: Number(sync.audioOffset) || 0,
    mode: sync.mode === 'audio' ? 'audio' : 'subtitle',
    updatedAt: Date.now()
  };
  // Keep storage clean (max 100 entries)
  const keys = Object.keys(map);
  if (keys.length > 100) {
    keys
      .sort((a, b) => (map[a].updatedAt || 0) - (map[b].updatedAt || 0))
      .slice(0, keys.length - 100)
      .forEach(k => delete map[k]);
  }
  await chrome.storage.local.set({ syncMap: map });
}

async function castForTab(tabId, { udn, mediaUrl, subtitleUrl, startTime }) {
  const st = tabStates.get(tabId);
  if (!st) throw new Error('当前页面未检测到视频');
  const stream = st.streams.find(s => s.url === (mediaUrl || st.selectedStreamUrl)) || st.streams[0];
  if (!stream) throw new Error('尚未捕获到视频流，请先点击播放视频');

  let subUrl = '';
  if (subtitleUrl !== undefined) {
    subUrl = subtitleUrl;
  } else if (st.extSubEnabled && st.externalSub?.url) {
    subUrl = st.externalSub.url;
  } else {
    // Use captured native subtitle if any (excluding disabled external sub)
    const nativeSub = st.subtitles.find(s => s.url !== st.externalSub?.url);
    subUrl = nativeSub ? nativeSub.url : '';
  }
  const sync = await getSavedSync(st.mediaKey);

  // Ask active video frame for current playback time if startTime not specified
  let resolvedStart = typeof startTime === 'number' ? startTime : 0;
  if (startTime === undefined) {
    try {
      const timeResp = await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_TIME' });
      if (timeResp && typeof timeResp.currentTime === 'number') {
        resolvedStart = timeResp.currentTime;
      }
    } catch {}
  }

  // Pause web video when casting starts
  chrome.tabs.sendMessage(tabId, { type: 'PAUSE_VIDEO' }).catch(() => {});

  const result = await bridgeFetch('/api/cast', {
    method: 'POST',
    body: JSON.stringify({
      udn,
      mediaUrl: stream.url,
      subtitleUrl: subUrl || '',
      title: st.pageMeta?.title || 'Movy Video',
      headers: stream.headers || {},
      subtitleOffset: sync.subtitleOffset || 0,
      audioOffset: sync.mode === 'audio' ? (sync.audioOffset || 0) : 0,
      startTime: resolvedStart
    })
  });

  await chrome.storage.local.set({ lastDeviceUdn: udn });
  return result;
}

// ---------- Tab & WebRequest Listeners ----------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const movy = isMovyUrl(changeInfo.url);
    if (movy) {
      ensureBridgeRunning().catch(() => {});
      const prev = tabStates.get(tabId);
      const newKey = getMediaKeyFromUrl(changeInfo.url);
      if (!prev || prev.mediaKey !== newKey) {
        tabStates.set(tabId, {
          isMovy: true,
          pageUrl: changeInfo.url,
          mediaKey: newKey,
          streams: [],
          subtitles: [],
          selectedStreamUrl: '',
          selectedSubtitleUrl: '',
          extSubEnabled: false,
          externalSub: null,
          nativeTakeoverUrl: '',
          pageMeta: {}
        });
        chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      } else {
        prev.pageUrl = changeInfo.url;
      }
    } else if (tabStates.has(tabId)) {
      tabStates.delete(tabId);
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      disconnectNativeIfNoMovyTabs();
    }
  } else if (tab?.url && isMovyUrl(tab.url) && !tabStates.has(tabId)) {
    ensureTabState(tabId, tab.url);
    ensureBridgeRunning().catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  tabStates.delete(tabId);
  disconnectNativeIfNoMovyTabs();
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  details => {
    if (details.tabId < 0) return;
    const st = tabStates.get(details.tabId);
    if (!st || !st.isMovy) return;

    const headers = {};
    for (const h of details.requestHeaders || []) {
      const n = h.name.toLowerCase();
      if (n === 'referer' || n === 'origin' || n === 'user-agent') {
        headers[n] = h.value;
      }
    }
    reqHeaderCache.set(details.requestId, headers);
    setTimeout(() => reqHeaderCache.delete(details.requestId), 15000);

    if (isMediaUrl(details.url)) {
      addStream(details.tabId, details.url, headers);
    } else if (isSubtitleUrl(details.url)) {
      addSubtitle(details.tabId, details.url, headers);
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0) return;
    const st = tabStates.get(details.tabId);
    if (!st || !st.isMovy) return;
    if (details.statusCode < 200 || details.statusCode >= 400) return;

    const ctHeader = (details.responseHeaders || []).find(h => h.name.toLowerCase() === 'content-type');
    const ct = ctHeader ? ctHeader.value : '';
    const headers = reqHeaderCache.get(details.requestId) || {};

    if (isMediaUrl(details.url, ct)) {
      addStream(details.tabId, details.url, headers);
    } else if (isSubtitleUrl(details.url, ct)) {
      addSubtitle(details.tabId, details.url, headers);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ---------- Message Router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const senderTabId = sender.tab?.id;

    if (msg.type === 'IS_MOVY_TAB') {
      const url = sender.tab?.url || '';
      const movy = isMovyUrl(url);
      if (movy && senderTabId >= 0) ensureTabState(senderTabId, url);
      return sendResponse({ isMovy: movy, mediaKey: getMediaKeyFromUrl(url) });
    }

    if (msg.type === 'PAGE_META' && senderTabId >= 0) {
      const st = ensureTabState(senderTabId, sender.tab?.url || '');
      st.pageMeta = { ...st.pageMeta, ...(msg.meta || {}) };
      if (msg.mediaKey && msg.mediaKey !== st.mediaKey) {
        st.mediaKey = msg.mediaKey;
      }
      const sync = await getSavedSync(st.mediaKey);
      return sendResponse({ ok: true, sync });
    }

    if (msg.type === 'GET_TAB_STATE') {
      let tabId = msg.tabId;
      if (tabId === undefined) {
        if (senderTabId >= 0) {
          tabId = senderTabId;
        } else {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = activeTab?.id;
          if (activeTab?.url && isMovyUrl(activeTab.url)) {
            ensureTabState(tabId, activeTab.url);
          }
        }
      }
      const st = tabStates.get(tabId) || {
        isMovy: false,
        streams: [],
        subtitles: [],
        selectedStreamUrl: '',
        selectedSubtitleUrl: '',
        pageMeta: {},
        mediaKey: 'default'
      };
      const sync = await getSavedSync(st.mediaKey);
      const prefs = await chrome.storage.local.get(['autoContinueCast', 'lastDeviceUdn']);
      return sendResponse({
        tabId,
        state: st,
        sync,
        autoContinueCast: Boolean(prefs.autoContinueCast),
        lastDeviceUdn: prefs.lastDeviceUdn || ''
      });
    }

    if (msg.type === 'SET_AUTO_CONTINUE') {
      await chrome.storage.local.set({ autoContinueCast: Boolean(msg.value) });
      return sendResponse({ ok: true });
    }

    if (msg.type === 'APPLY_SYNC') {
      const tabId = msg.tabId ?? senderTabId;
      const st = tabStates.get(tabId);
      const mediaKey = st?.mediaKey || msg.mediaKey || 'default';
      await saveSync(mediaKey, msg.sync);
      let audioResult = { ok: true };
      if (tabId >= 0) {
        try {
          const resp = await chrome.tabs.sendMessage(tabId, { type: 'SYNC_UPDATED', sync: msg.sync });
          if (resp && resp.ok === false) audioResult = resp;
        } catch {}

        // Take over movy.sx native .vp-cue subtitle once when offset != 0 (no repeat downloads)
        if (st && !st.extSubEnabled) {
          const offset = Number(msg.sync?.subtitleOffset) || 0;
          if (Math.abs(offset) >= 0.05) {
            const nativeSub = st.subtitles.find(s => s.url !== st.externalSub?.url);
            if (nativeSub && st.nativeTakeoverUrl !== nativeSub.url) {
              try {
                const vttResp = await bridgeFetch('/api/subtitles/vtt', {
                  method: 'POST',
                  body: JSON.stringify({ url: nativeSub.url, headers: nativeSub.headers || {}, offset: 0 })
                });
                st.nativeTakeoverUrl = nativeSub.url;
                await chrome.tabs.sendMessage(tabId, {
                  type: 'INJECT_VTT_SUBTITLE',
                  vtt: vttResp.vtt,
                  label: nativeSub.label || '原生字幕',
                  sourceUrl: nativeSub.url
                }).catch(() => {});
              } catch {}
            }
          } else if (st.nativeTakeoverUrl) {
            st.nativeTakeoverUrl = '';
            chrome.tabs.sendMessage(tabId, { type: 'CLEAR_VTT_SUBTITLE' }).catch(() => {});
          }
        }
      }
      return sendResponse({ ok: true, audioResult });
    }

    if (msg.type === 'BRIDGE_API') {
      const data = await bridgeFetch(msg.path, {
        method: msg.method || 'GET',
        body: msg.body ? JSON.stringify(msg.body) : undefined
      });
      return sendResponse({ ok: true, data });
    }

    if (msg.type === 'CAST_NOW') {
      const tabId = msg.tabId ?? senderTabId;
      const result = await castForTab(tabId, {
        udn: msg.udn,
        mediaUrl: msg.mediaUrl,
        subtitleUrl: msg.subtitleUrl,
        startTime: msg.startTime
      });
      return sendResponse({ ok: true, data: result });
    }

    if (msg.type === 'LOAD_EXTERNAL_SUBTITLE') {
      const tabId = msg.tabId ?? senderTabId;
      const st = tabStates.get(tabId);
      if (st) {
        addSubtitle(tabId, msg.url, {}, msg.label || '中文外挂字幕');
        st.selectedSubtitleUrl = msg.url;
        st.extSubEnabled = true;
        st.nativeTakeoverUrl = '';
        st.externalSub = { url: msg.url, label: msg.label || '中文外挂字幕' };
      }
      const vttResp = await bridgeFetch('/api/subtitles/vtt', {
        method: 'POST',
        body: JSON.stringify({ url: msg.url, offset: 0 })
      });
      if (tabId >= 0) {
        await chrome.tabs.sendMessage(tabId, {
          type: 'INJECT_VTT_SUBTITLE',
          vtt: vttResp.vtt,
          label: msg.label || '中文',
          sourceUrl: msg.url
        }).catch(() => {});
      }
      return sendResponse({ ok: true });
    }

    if (msg.type === 'SET_EXT_SUB_ENABLED') {
      const tabId = msg.tabId ?? senderTabId;
      const enabled = Boolean(msg.enabled);
      const st = tabStates.get(tabId);
      if (st) {
        st.extSubEnabled = enabled;
        st.nativeTakeoverUrl = '';
      }

      if (tabId >= 0) {
        if (!enabled) {
          chrome.tabs.sendMessage(tabId, { type: 'CLEAR_VTT_SUBTITLE' }).catch(() => {});
        } else if (st?.externalSub?.url) {
          const vttResp = await bridgeFetch('/api/subtitles/vtt', {
            method: 'POST',
            body: JSON.stringify({ url: st.externalSub.url, offset: 0 })
          });
          await chrome.tabs.sendMessage(tabId, {
            type: 'INJECT_VTT_SUBTITLE',
            vtt: vttResp.vtt,
            label: st.externalSub.label || '中文',
            sourceUrl: st.externalSub.url
          }).catch(() => {});
        }
      }
      return sendResponse({ ok: true, enabled });
    }

    if (msg.type === 'AUTO_CALIBRATE_SYNC') {
      const tabId = msg.tabId ?? senderTabId;
      const st = tabStates.get(tabId);
      if (!st) return sendResponse({ ok: false, error: '当前页面未检测到视频' });

      const currentSync = await getSavedSync(st.mediaKey);
      const nativeSub = st.subtitles.find(s => s.url !== st.externalSub?.url);

      // Strategy 1: Cross-correlate external Chinese subtitle against movy native subtitle
      if (st.extSubEnabled && st.externalSub?.url && nativeSub) {
        try {
          const calc = await bridgeFetch('/api/subtitles/auto-sync', {
            method: 'POST',
            body: JSON.stringify({
              refUrl: nativeSub.url,
              refHeaders: nativeSub.headers || {},
              targetUrl: st.externalSub.url
            })
          });
          if (calc.ok && calc.confidence >= 0.25) {
            const nextSync = { ...currentSync, mode: 'subtitle', subtitleOffset: calc.offsetSec };
            await saveSync(st.mediaKey, nextSync);
            chrome.tabs.sendMessage(tabId, { type: 'SYNC_UPDATED', sync: nextSync }).catch(() => {});
            return sendResponse({
              ok: true,
              method: 'reference',
              offsetSec: calc.offsetSec,
              confidence: calc.confidence,
              sync: nextSync
            });
          }
        } catch {}
      }

      // Strategy 2: Take over native subtitle if needed, then snap nearest cue to current video time
      if (!st.extSubEnabled && nativeSub && st.nativeTakeoverUrl !== nativeSub.url) {
        try {
          const vttResp = await bridgeFetch('/api/subtitles/vtt', {
            method: 'POST',
            body: JSON.stringify({ url: nativeSub.url, headers: nativeSub.headers || {}, offset: 0 })
          });
          st.nativeTakeoverUrl = nativeSub.url;
          await chrome.tabs.sendMessage(tabId, {
            type: 'INJECT_VTT_SUBTITLE',
            vtt: vttResp.vtt,
            label: nativeSub.label || '原生字幕',
            sourceUrl: nativeSub.url
          }).catch(() => {});
        } catch {}
      }

      try {
        const snap = await chrome.tabs.sendMessage(tabId, { type: 'SNAP_SUBTITLE_TO_NOW' });
        if (snap && snap.ok && typeof snap.offsetSec === 'number') {
          const nextSync = { ...currentSync, mode: 'subtitle', subtitleOffset: snap.offsetSec };
          await saveSync(st.mediaKey, nextSync);
          chrome.tabs.sendMessage(tabId, { type: 'SYNC_UPDATED', sync: nextSync }).catch(() => {});
          return sendResponse({
            ok: true,
            method: 'snap',
            offsetSec: snap.offsetSec,
            cueText: snap.cueText || '',
            sync: nextSync
          });
        }
        return sendResponse({ ok: false, error: snap?.error || '未找到可校准的字幕，请先开启字幕或搜索中文字幕' });
      } catch {
        return sendResponse({ ok: false, error: '无法连接播放器，请刷新视频页后重试' });
      }
    }

    sendResponse({ ok: false, error: 'Unknown message' });
  })().catch(err => {
    sendResponse({ ok: false, error: err.message || String(err) });
  });
  return true;
});
