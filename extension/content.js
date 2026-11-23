'use strict';

(function initMovyMetaAndToast() {
  let toastEl = null;
  let lastReportedSignature = '';

  function cleanMovieTitle(raw) {
    let t = String(raw || '').trim();
    if (!t) return '';
    t = t
      .replace(/\s*[-|–—]\s*Movy.*$/i, '')
      .replace(/^Watch\s+/i, '')
      .replace(/\s+(?:Online|Free|HD|Full Movie|TV Show|Movies & TV Shows).*$/i, '')
      .trim();
    if (/^movy$/i.test(t) || /watch free movies/i.test(t)) return '';
    return t;
  }

  function extractPageMeta() {
    const href = location.href;
    const path = location.pathname;
    const isSeries = /\/tv\//i.test(path);
    const mediaType = isSeries ? 'series' : 'movie';

    const h1 = document.querySelector('h1');
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
    const title =
      cleanMovieTitle(h1?.textContent) ||
      cleanMovieTitle(ogTitle) ||
      cleanMovieTitle(document.title) ||
      '';

    let year = '';
    const yearMatch = (document.body?.innerText || '').slice(0, 1800).match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) year = yearMatch[1];

    let season = 0;
    let episode = 0;
    const u = new URL(href);
    const qsSeason = Number(u.searchParams.get('season') || u.searchParams.get('s') || 0);
    const qsEp = Number(u.searchParams.get('episode') || u.searchParams.get('e') || 0);
    if (qsSeason > 0) season = qsSeason;
    if (qsEp > 0) episode = qsEp;

    if (isSeries && (!season || !episode)) {
      const pathSe = path.match(/\/tv\/\d+\/(\d+)\/(\d+)/i);
      if (pathSe) {
        season = Number(pathSe[1]);
        episode = Number(pathSe[2]);
      } else {
        const textSe = (document.title + ' ' + (h1?.textContent || '')).match(/S(\d+)\s*E(\d+)/i);
        if (textSe) {
          season = Number(textSe[1]);
          episode = Number(textSe[2]);
        }
      }
    }

    let imdbId = '';
    const imdbLink = document.querySelector('a[href*="imdb.com/title/tt"]');
    if (imdbLink) {
      const m = imdbLink.href.match(/tt\d{7,9}/);
      if (m) imdbId = m[0];
    }

    const mediaKey = `${path}${season ? `:s${season}` : ''}${episode ? `:e${episode}` : ''}`;
    return {
      mediaKey,
      meta: { title: title || 'Movy Video', mediaType, year, season, episode, imdbId }
    };
  }

  function reportPageMeta(force = false) {
    const { mediaKey, meta } = extractPageMeta();
    const sig = `${location.href}|${meta.title}|${meta.season}|${meta.episode}`;
    if (!force && sig === lastReportedSignature) return;
    lastReportedSignature = sig;
    chrome.runtime.sendMessage({ type: 'PAGE_META', mediaKey, meta }).catch(() => {});
  }

  setInterval(() => reportPageMeta(false), 1000);
  setTimeout(() => reportPageMeta(true), 600);

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showEpisodeToast(msg) {
    if (toastEl) toastEl.remove();
    toastEl = document.createElement('div');
    toastEl.className = 'movy-cast-toast';

    const mount = document.fullscreenElement || document.body;
    if (msg.mode === 'auto') {
      toastEl.innerHTML = `<span>已自动续投至 ${escapeHtml(msg.deviceName || '电视')}</span>`;
      mount.appendChild(toastEl);
      setTimeout(() => toastEl?.remove(), 3500);
      return;
    }

    toastEl.innerHTML =
      `<span>检测到新剧集</span>` +
      `<button class="mc-toast-go">续投至 ${escapeHtml(msg.deviceName || '电视')}</button>` +
      `<button class="mc-toast-close">忽略</button>`;
    mount.appendChild(toastEl);

    toastEl.querySelector('.mc-toast-go').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'CAST_NOW', udn: msg.udn, mediaUrl: msg.mediaUrl, startTime: 0 });
      toastEl?.remove();
    });
    toastEl.querySelector('.mc-toast-close').addEventListener('click', () => toastEl?.remove());
    setTimeout(() => toastEl?.remove(), 12000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EPISODE_TOAST') {
      showEpisodeToast(msg);
    } else if (msg.type === 'GET_FRESH_META') {
      sendResponse(extractPageMeta());
    }
  });
})();
