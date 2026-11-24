#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');

const PORT = Number(process.env.MOVY_CAST_PORT || 18923);
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

// Persistent Keep-Alive connection pools for fast upstream segment fetching
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000, rejectUnauthorized: false });

// Active state
const devices = new Map(); // udn -> device info
const proxyTokens = new Map(); // token -> { url, headers, type, subtitleOffset, audioOffset, playlistSeq, seqIndex, createdAt }
const urlTokenCache = new Map(); // dedupKey -> token (prevents token bloat on repeated m3u8 reloads)
const segmentCache = new Map(); // token -> { promise, buffer, contentType, status, size, at }
const activeFfmpegs = new Set(); // track child processes for instant cleanup on stop/seek
let segmentCacheBytes = 0;
const MAX_SEG_CACHE_ITEMS = 5;
const MAX_SEG_CACHE_BYTES = 32 * 1024 * 1024; // 32 MB ring cap
const MAX_SINGLE_SEG_BYTES = 12 * 1024 * 1024; // skip prefetching huge non-HLS MP4s
let currentSession = null; // { udn, title, mediaUrl, subtitleUrl, subtitleOffset, audioOffset, remuxMode, remuxStartOffset, headers }
let lastActivityAt = Date.now();

function resolveFfmpegBin() {
  const candidates = ['ffmpeg'];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const wgBase = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    candidates.push(path.join(wgBase, 'Links', 'ffmpeg.exe'));
    const pkgsDir = path.join(wgBase, 'Packages');
    try {
      for (const pkg of fs.readdirSync(pkgsDir)) {
        if (!/ffmpeg/i.test(pkg)) continue;
        const pkgPath = path.join(pkgsDir, pkg);
        for (const sub of fs.readdirSync(pkgPath)) {
          const binPath = path.join(pkgPath, sub, 'bin', 'ffmpeg.exe');
          if (fs.existsSync(binPath)) candidates.push(binPath);
        }
      }
    } catch {}
  }
  for (const bin of candidates) {
    try {
      if (bin !== 'ffmpeg' && !fs.existsSync(bin)) continue;
      const res = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 2500 });
      if (res.status === 0) return bin;
    } catch {}
  }
  return '';
}

function killAllFfmpegs() {
  for (const ff of activeFfmpegs) {
    try { ff.kill('SIGKILL'); } catch {}
  }
  activeFfmpegs.clear();
}

let ffmpegBin = resolveFfmpegBin();
let ffmpegAvailable = Boolean(ffmpegBin);

// ---------- Utility Helpers ----------

function getLocalIPv4Addresses() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        list.push({ name, address: info.address, netmask: info.netmask });
      }
    }
  }
  return list;
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) | (Number(oct) & 255)) >>> 0, 0);
}

function pickLocalIpForTarget(targetIp) {
  const addrs = getLocalIPv4Addresses();
  if (!addrs.length) return '127.0.0.1';
  if (targetIp) {
    const tInt = ipToInt(targetIp);
    for (const item of addrs) {
      const mask = ipToInt(item.netmask);
      if ((ipToInt(item.address) & mask) === (tInt & mask)) {
        return item.address;
      }
    }
  }
  // Prefer typical LAN subnets (192.168.x.x / 10.x.x.x)
  const preferred = addrs.find(a => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a.address));
  return (preferred || addrs[0]).address;
}

function xmlEscape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractXmlTag(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? xmlUnescape(m[1].trim()) : '';
}

function formatHms(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function parseHms(hms) {
  if (!hms || typeof hms !== 'string') return 0;
  const parts = hms.split(':').map(p => parseFloat(p));
  if (parts.length === 3 && parts.every(n => !Number.isNaN(n))) {
    return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  return 0;
}

function createToken(data) {
  const dedupKey = `${data.type}|${data.url}|${data.subtitleOffset || 0}|${data.audioOffset || 0}`;
  const existingTok = urlTokenCache.get(dedupKey);
  if (existingTok && proxyTokens.has(existingTok)) {
    const prev = proxyTokens.get(existingTok);
    prev.createdAt = Date.now();
    if (data.playlistSeq) {
      prev.playlistSeq = data.playlistSeq;
      prev.seqIndex = data.seqIndex;
    }
    return existingTok;
  }

  const token = crypto.randomBytes(10).toString('hex');
  proxyTokens.set(token, { ...data, createdAt: Date.now() });
  urlTokenCache.set(dedupKey, token);

  // Prune old tokens (> 6 hours)
  if (proxyTokens.size > 4000) {
    const cutoff = Date.now() - 6 * 3600 * 1000;
    for (const [k, v] of proxyTokens.entries()) {
      if (v.createdAt < cutoff) proxyTokens.delete(k);
    }
    for (const [dk, tk] of urlTokenCache.entries()) {
      if (!proxyTokens.has(tk)) urlTokenCache.delete(dk);
    }
  }
  return token;
}

// ---------- System Proxy Detection (Public Streams Only, LAN Always Direct) ----------

let cachedSysProxy = { checkedAt: 0, proxy: null };
let cachedProxyHttpsAgent = { key: '', agent: null };

function isLanHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    /^192\.168\./.test(h) ||
    /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    /\.local$/.test(h)
  );
}

function parseProxySpec(raw) {
  if (!raw) return null;
  let str = String(raw).trim();
  // Windows ProxyServer may look like "http=127.0.0.1:7890;https=127.0.0.1:7890"
  if (str.includes('=')) {
    const map = {};
    for (const part of str.split(';')) {
      const [k, v] = part.split('=');
      if (k && v) map[k.trim().toLowerCase()] = v.trim();
    }
    str = map.https || map.http || '';
  }
  if (!str) return null;
  if (!/^https?:\/\//i.test(str)) str = `http://${str}`;
  try {
    const u = new URL(str);
    if (!u.hostname || !u.port) return null;
    return { host: u.hostname, port: Number(u.port) };
  } catch {
    return null;
  }
}

function getSystemProxy() {
  const now = Date.now();
  if (now - cachedSysProxy.checkedAt < 15000) return cachedSysProxy.proxy;

  let proxy = parseProxySpec(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy);
  if (!proxy && process.platform === 'win32') {
    try {
      const reg = spawnSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 1500 }
      );
      const out = reg.stdout || '';
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
      if (enabled) {
        const m = out.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
        if (m) proxy = parseProxySpec(m[1].trim());
      }
    } catch {}
  }

  cachedSysProxy = { checkedAt: now, proxy };
  return proxy;
}

class ProxyHttpsAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000, rejectUnauthorized: false });
    this.proxy = proxy;
  }
  createConnection(options, cb) {
    const sock = net.connect(this.proxy.port, this.proxy.host);
    let done = false;
    const fail = err => {
      if (done) return;
      done = true;
      sock.destroy();
      cb(err);
    };
    sock.once('error', fail);
    sock.setTimeout(8000, () => fail(new Error('Proxy CONNECT timeout')));
    sock.once('connect', () => {
      const target = `${options.host}:${options.port || 443}`;
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
    });

    let headerBuf = '';
    const onData = chunk => {
      headerBuf += chunk.toString('latin1');
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      sock.removeListener('data', onData);
      sock.setTimeout(0);
      const statusLine = headerBuf.slice(0, headerBuf.indexOf('\r\n'));
      if (!/^HTTP\/1\.[01]\s+200\b/i.test(statusLine)) {
        return fail(new Error(`Proxy CONNECT rejected: ${statusLine}`));
      }
      if (done) return;
      done = true;
      const tlsSock = tls.connect({
        socket: sock,
        servername: options.servername || options.host,
        rejectUnauthorized: false
      });
      cb(null, tlsSock);
    };
    sock.on('data', onData);
  }
}

function getProxyHttpsAgent(proxy) {
  const key = `${proxy.host}:${proxy.port}`;
  if (cachedProxyHttpsAgent.key !== key || !cachedProxyHttpsAgent.agent) {
    cachedProxyHttpsAgent = { key, agent: new ProxyHttpsAgent(proxy) };
  }
  return cachedProxyHttpsAgent.agent;
}

function openUpstreamRequest(targetUrl, { method = 'GET', headers = {}, timeoutMs = 10000, useProxy = true } = {}, onResponse) {
  const u = new URL(targetUrl);
  const isHttps = u.protocol === 'https:';
  const proxy = useProxy && !isLanHost(u.hostname) ? getSystemProxy() : null;

  const finalHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ...headers
  };

  if (proxy && !isHttps) {
    // Plain HTTP over HTTP proxy
    return http.request(
      {
        hostname: proxy.host,
        port: proxy.port,
        path: targetUrl,
        method,
        headers: { ...finalHeaders, Host: u.host },
        agent: httpAgent,
        timeout: timeoutMs
      },
      onResponse
    );
  }

  const mod = isHttps ? https : http;
  const agent = isHttps ? (proxy ? getProxyHttpsAgent(proxy) : httpsAgent) : httpAgent;
  return mod.request(
    {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: finalHeaders,
      agent,
      timeout: timeoutMs,
      rejectUnauthorized: false
    },
    onResponse
  );
}

function decodeSubtitleBuffer(buf) {
  if (!buf || !buf.length) return '';
  // UTF-8 BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  // UTF-16 LE BOM
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  // UTF-16 BE BOM
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  // Strict UTF-8 check; fallback to GB18030 (superset of GBK/GB2312) for legacy Chinese subtitles
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

function fetchText(targetUrl, headers = {}, timeoutMs = 8000, redirects = 5, useProxy = true) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = openUpstreamRequest(targetUrl, { method: 'GET', headers, timeoutMs, useProxy }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, targetUrl).href;
          return fetchText(nextUrl, headers, timeoutMs, redirects - 1, useProxy).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            buffer,
            body: buffer.toString('utf8'),
            finalUrl: targetUrl
          });
        });
      });
    } catch (err) {
      return reject(err);
    }
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', err => {
      // Seamless fallback to direct if system proxy refuses connection
      if (useProxy && getSystemProxy() && !isLanHost(new URL(targetUrl).hostname)) {
        return fetchText(targetUrl, headers, timeoutMs, redirects, false).then(resolve, reject);
      }
      reject(err);
    });
    req.end();
  });
}

// ---------- SSDP / UPnP Discovery ----------

async function inspectDeviceLocation(locationUrl) {
  try {
    const res = await fetchText(locationUrl, {}, 4000);
    if (res.status < 200 || res.status >= 300) return null;
    const xml = res.body;
    const baseUrl = new URL(locationUrl);
    const friendlyName = extractXmlTag(xml, 'friendlyName') || baseUrl.hostname;
    const udn = extractXmlTag(xml, 'UDN') || locationUrl;

    // Parse services block
    const serviceRegex = /<service>([\s\S]*?)<\/service>/gi;
    let avControlUrl = '';
    let avServiceType = 'urn:schemas-upnp-org:service:AVTransport:1';
    let rcControlUrl = '';
    let rcServiceType = 'urn:schemas-upnp-org:service:RenderingControl:1';

    let match;
    while ((match = serviceRegex.exec(xml)) !== null) {
      const block = match[1];
      const sType = extractXmlTag(block, 'serviceType');
      const cUrl = extractXmlTag(block, 'controlURL');
      if (!sType || !cUrl) continue;
      const resolvedControl = new URL(cUrl, baseUrl.origin + '/').href;
      if (/AVTransport/i.test(sType)) {
        avControlUrl = resolvedControl;
        avServiceType = sType;
      } else if (/RenderingControl/i.test(sType)) {
        rcControlUrl = resolvedControl;
        rcServiceType = sType;
      }
    }

    if (!avControlUrl) return null;

    const device = {
      udn,
      name: friendlyName,
      host: baseUrl.hostname,
      location: locationUrl,
      avControlUrl,
      avServiceType,
      rcControlUrl,
      rcServiceType,
      lastSeen: Date.now()
    };
    devices.set(udn, device);
    return device;
  } catch {
    return null;
  }
}

function discoverDevices(timeoutMs = 2500) {
  return new Promise(resolve => {
    const seenLocations = new Set();
    const sockets = [];
    const addrs = getLocalIPv4Addresses();
    const bindList = addrs.length ? addrs.map(a => a.address) : ['0.0.0.0'];

    const searchTargets = [
      'urn:schemas-upnp-org:service:AVTransport:1',
      'urn:schemas-upnp-org:device:MediaRenderer:1'
    ];

    for (const bindIp of bindList) {
      try {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sockets.push(sock);

        sock.on('message', msg => {
          const text = msg.toString('utf8');
          const locMatch = text.match(/^LOCATION:\s*(.+)$/im);
          if (locMatch) {
            const loc = locMatch[1].trim();
            if (!seenLocations.has(loc)) {
              seenLocations.add(loc);
              inspectDeviceLocation(loc);
            }
          }
        });

        sock.on('error', () => {});

        sock.bind(0, bindIp, () => {
          for (const st of searchTargets) {
            const payload = Buffer.from(
              [
                'M-SEARCH * HTTP/1.1',
                `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
                'MAN: "ssdp:discover"',
                'MX: 2',
                `ST: ${st}`,
                '',
                ''
              ].join('\r\n')
            );
            try {
              sock.send(payload, 0, payload.length, SSDP_PORT, SSDP_ADDR);
            } catch {}
          }
        });
      } catch {}
    }

    setTimeout(() => {
      for (const s of sockets) {
        try {
          s.close();
        } catch {}
      }
      // Give in-flight XML fetches a tiny grace period
      setTimeout(() => {
        resolve(Array.from(devices.values()));
      }, 300);
    }, timeoutMs);
  });
}

// ---------- UPnP SOAP Calls ----------

function sendSoap(controlUrl, serviceType, action, bodyXml) {
  return new Promise((resolve, reject) => {
    const u = new URL(controlUrl);
    const envelope =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="${serviceType}">${bodyXml}</u:${action}></s:Body>` +
      `</s:Envelope>`;

    const buf = Buffer.from(envelope, 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': buf.length,
          SOAPACTION: `"${serviceType}#${action}"`
        },
        timeout: 6000
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(text);
          } else {
            const errDesc = extractXmlTag(text, 'errorDescription') || `HTTP ${res.statusCode}`;
            reject(new Error(`DLNA ${action} failed: ${errDesc}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`DLNA ${action} timeout`)));
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function buildDidlMetadata({ title, mediaUrl, mimeType, subtitleUrl }) {
  const safeTitle = xmlEscape(title || 'Movy Video');
  const safeUrl = xmlEscape(mediaUrl);
  const safeMime = xmlEscape(mimeType || 'video/mp4');
  let subTags = '';
  if (subtitleUrl) {
    const safeSub = xmlEscape(subtitleUrl);
    subTags =
      `<sec:CaptionInfoEx sec:type="srt">${safeSub}</sec:CaptionInfoEx>` +
      `<sec:CaptionInfo sec:type="srt">${safeSub}</sec:CaptionInfo>` +
      `<res protocolInfo="http-get:*:text/srt:*">${safeSub}</res>`;
  }
  return (
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
    `xmlns:sec="http://www.sec.co.kr/dlna">` +
    `<item id="0" parentID="-1" restricted="1">` +
    `<dc:title>${safeTitle}</dc:title>` +
    `<upnp:class>object.item.videoItem</upnp:class>` +
    `<res protocolInfo="http-get:*:${safeMime}:DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000">${safeUrl}</res>` +
    subTags +
    `</item></DIDL-Lite>`
  );
}

// ---------- Subtitle Parsing (SRT / VTT / ASS), Ad Cleaning & Offset ----------

function parseTimestampToMs(ts) {
  const clean = ts.trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 3) {
    return Math.round((Number(parts[0]) * 3600 + Number(parts[1]) * 60 + parseFloat(parts[2])) * 1000);
  }
  if (parts.length === 2) {
    return Math.round((Number(parts[0]) * 60 + parseFloat(parts[1])) * 1000);
  }
  return 0;
}

function formatMsToSrt(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const hh = String(Math.floor(clamped / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((clamped % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((clamped % 60000) / 1000)).padStart(2, '0');
  const mmm = String(clamped % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
}

// Common Chinese subtitle ad/watermark patterns
const SUB_AD_REGEX =
  /(?:https?:\/\/|www\.|\.com|\.cn|\.tv|\.net|\.cc|\.org|微信(?:公众)?号|关注微信|QQ群|加群|字幕组招募|本字幕由.*?(?:制作|翻译|提供|压制)|翻译[:：].*?(?:校对|时间轴)|时间轴[:：]|压制[:：]|澳门|威尼斯人|葡京|赌博|博彩|棋牌|福利视频|免费看片|下载App|扫码|subhd|zimuku|opensubtitles|subtitlecat|yyets|人人影视|电影天堂|迅雷看看|字幕库)/i;

function isAdCueText(text) {
  const clean = String(text || '').trim();
  if (!clean) return true;
  if (SUB_AD_REGEX.test(clean)) return true;
  return false;
}

function parseAssToCues(text) {
  const lines = text.split('\n');
  let formatCols = null;
  const cues = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^Format:/i.test(line) && !formatCols && /Start/i.test(line) && /Text/i.test(line)) {
      formatCols = line.slice(7).split(',').map(s => s.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;

    const rest = line.slice(9).trim();
    const startIdx = formatCols ? formatCols.indexOf('start') : 1;
    const endIdx = formatCols ? formatCols.indexOf('end') : 2;
    const styleIdx = formatCols ? formatCols.indexOf('style') : 3;
    const textIdx = formatCols ? formatCols.indexOf('text') : 9;

    const parts = [];
    let cur = rest;
    for (let i = 0; i < textIdx; i++) {
      const comma = cur.indexOf(',');
      if (comma === -1) break;
      parts.push(cur.slice(0, comma).trim());
      cur = cur.slice(comma + 1);
    }
    parts.push(cur.trim());
    if (parts.length <= textIdx) continue;

    // Skip watermark/logo/staff style lines
    const styleName = parts[styleIdx] || '';
    if (/(logo|watermark|staff|credit|ad|op|ed|title)/i.test(styleName)) continue;

    const startMs = parseTimestampToMs(parts[startIdx]);
    const endMs = parseTimestampToMs(parts[endIdx]);
    if (endMs <= startMs) continue;

    // Clean ASS override tags {\...} and convert \N / \n to newlines
    const rawDialogue = parts[textIdx] || '';
    // Skip positioned screen signs/watermarks like {\pos(x,y)} if short non-dialogue
    if (/\\pos\(|\\move\(/i.test(rawDialogue) && rawDialogue.length < 40) continue;

    const cleaned = rawDialogue
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N|\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !isAdCueText(l))
      .join('\n')
      .trim();

    if (!cleaned) continue;
    cues.push({ startMs, endMs, text: cleaned });
  }

  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

function parseRawSubtitleToCues(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Detect ASS/SSA format
  if (/\[Script Info\]/i.test(text) || /^Dialogue:/im.test(text)) {
    return parseAssToCues(text);
  }

  // Standard SRT / VTT format
  const blocks = text.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (!lines.length) continue;
    if (/^WEBVTT|^NOTE|^STYLE|^REGION/i.test(lines[0])) continue;

    const timeLineIndex = lines.findIndex(l => l.includes('-->'));
    if (timeLineIndex === -1) continue;

    const m = lines[timeLineIndex].match(/([\d:.]+(?:,\d+)?)\s*-->\s*([\d:.]+(?:,\d+)?)/);
    if (!m) continue;

    const startMs = parseTimestampToMs(m[1]);
    const endMs = parseTimestampToMs(m[2]);
    if (endMs <= startMs) continue;

    const cleaned = lines
      .slice(timeLineIndex + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !isAdCueText(l))
      .join('\n')
      .trim();

    if (!cleaned) continue;
    cues.push({ startMs, endMs, text: cleaned });
  }

  return cues;
}

function convertAndShiftSubtitleToSrt(rawText, offsetSec = 0) {
  const offsetMs = Math.round((Number(offsetSec) || 0) * 1000);
  const cues = parseRawSubtitleToCues(rawText);
  const out = [];
  let idx = 1;

  for (const c of cues) {
    const startMs = c.startMs + offsetMs;
    const endMs = c.endMs + offsetMs;
    if (endMs <= 0) continue;
    out.push(`${idx}\r\n${formatMsToSrt(startMs)} --> ${formatMsToSrt(endMs)}\r\n${c.text}`);
    idx++;
  }

  return out.join('\r\n\r\n') + '\r\n';
}

function convertAndShiftSubtitleToVtt(rawText, offsetSec = 0) {
  const srt = convertAndShiftSubtitleToSrt(rawText, offsetSec);
  const vttBody = srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2 --> $3.$4');
  return 'WEBVTT\n\n' + vttBody;
}

function parseSubtitleIntervalsSec(rawText) {
  const cues = parseRawSubtitleToCues(rawText);
  const intervals = [];
  for (const c of cues) {
    const start = c.startMs / 1000;
    const end = c.endMs / 1000;
    if (end > start && start < 7200) {
      intervals.push([start, Math.min(end, start + 12)]);
    }
  }
  return intervals;
}

function computeSubtitleAutoOffset(refRaw, targetRaw) {
  const refIntervals = parseSubtitleIntervalsSec(refRaw);
  const tgtIntervals = parseSubtitleIntervalsSec(targetRaw);
  if (refIntervals.length < 8 || tgtIntervals.length < 8) {
    return { ok: false, reason: '字幕条目过少，无法自动比对' };
  }

  // Discretize speech activity into 0.1s bins (first 40 minutes = 24000 bins)
  const STEP = 0.1;
  const MAX_SEC = 2400;
  const BINS = Math.floor(MAX_SEC / STEP);
  const refGrid = new Uint8Array(BINS);
  const tgtStarts = [];

  for (const [s, e] of refIntervals) {
    if (s >= MAX_SEC) break;
    const a = Math.max(0, Math.floor(s / STEP));
    const b = Math.min(BINS - 1, Math.ceil(e / STEP));
    for (let i = a; i <= b; i++) refGrid[i] = 1;
  }

  for (const [s, e] of tgtIntervals) {
    if (s >= MAX_SEC) break;
    const a = Math.floor(s / STEP);
    const mid = Math.floor(((s + e) * 0.5) / STEP);
    const b = Math.min(BINS - 1, Math.floor(e / STEP));
    tgtStarts.push(a, mid, b);
  }

  if (!tgtStarts.length) return { ok: false, reason: '目标字幕无有效时间轴' };

  // Search offset in [-45s, +45s] at 0.1s resolution
  const MAX_LAG = 450; // 45.0s
  let bestLag = 0;
  let bestScore = -1;
  let zeroScore = 0;

  for (let lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
    let score = 0;
    for (let i = 0; i < tgtStarts.length; i++) {
      const idx = tgtStarts[i] + lag;
      if (idx >= 0 && idx < BINS && refGrid[idx]) score++;
    }
    if (lag === 0) zeroScore = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  const confidence = bestScore / tgtStarts.length;
  const offsetSec = Number((bestLag * STEP).toFixed(1));
  return {
    ok: true,
    offsetSec,
    confidence: Number(confidence.toFixed(2)),
    improved: bestScore > zeroScore * 1.03
  };
}

// ---------- Online Chinese Subtitle Search (Xunlei Curated Primary + SubtitleCat Fallback) ----------

function buildSubtitleSearchQuery({ title, year, mediaType, season, episode }) {
  const cleanTitle = String(title || '')
    .replace(/\s*[-|–—].*$/, '')
    .replace(/\(\d{4}\)/g, '')
    .trim();
  if (!cleanTitle) return '';
  if (mediaType === 'series' && Number(season) > 0 && Number(episode) > 0) {
    const s = String(Number(season)).padStart(2, '0');
    const e = String(Number(episode)).padStart(2, '0');
    if (!/S\d+E\d+/i.test(cleanTitle)) {
      return `${cleanTitle} S${s}E${e}`;
    }
  }
  return cleanTitle;
}

async function searchXunleiSubtitles(query, year = '') {
  try {
    const url = `https://api-shoulei-ssl.xunlei.com/oracle/subtitle?name=${encodeURIComponent(query)}`;
    const res = await fetchText(url, {}, 7000);
    if (res.status !== 200) return [];
    const data = JSON.parse(res.body);
    const list = Array.isArray(data.data) ? data.data : [];

    const out = [];
    const seen = new Set();

    for (const item of list) {
      if (!item || !item.url) continue;
      const ext = String(item.ext || '').toLowerCase();
      if (!['srt', 'ass', 'ssa', 'vtt'].includes(ext)) continue;

      const langs = Array.isArray(item.languages) ? item.languages.join(' ') : '';
      const name = String(item.name || '').trim() || `subtitle.${ext}`;
      const combined = `${langs} ${name}`;

      // Keep Chinese subtitles only
      const isSimplified = /(简体|简中|chs|zh[-_]?cn|gb|双语)/i.test(combined);
      const isTraditional = /(繁体|繁中|cht|zh[-_]?tw|zh[-_]?hk|big5)/i.test(combined);
      const isChinese = isSimplified || isTraditional || /(中文|汉语|chinese|chi|zho)/i.test(combined) || /[\u4e00-\u9fa5]/.test(name);
      if (!isChinese) continue;

      const dedupKey = `${name.toLowerCase()}|${item.url}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      let score = 70;
      if (isSimplified) score += 45;
      else if (isTraditional) score += 15;
      if (/(nf\.web|netflix|web-?dl|webrip|bluray|bdrip|1080p|2160p|4k)/i.test(name)) score += 20;
      if (/(官方|精校|特效|双语|中英)/i.test(combined)) score += 12;
      if (year && name.includes(String(year))) score += 10;
      if (/(花絮|预告|trailer|sample|extra)/i.test(name)) score -= 40;
      if (ext === 'srt' || ext === 'ass') score += 5;

      const tag = isSimplified ? '简' : isTraditional ? '繁' : '中';
      const cleanLabel = name.replace(/\.(srt|ass|ssa|vtt)$/i, '');

      out.push({
        id: item.url,
        url: item.url,
        label: cleanLabel,
        tag,
        ext: ext.toUpperCase(),
        source: 'xunlei',
        score
      });
    }

    // Deduplicate identical display names keeping highest-scored URL
    out.sort((a, b) => b.score - a.score);
    const uniqueByName = [];
    const seenName = new Set();
    for (const s of out) {
      const key = `${s.tag}:${s.label.toLowerCase()}`;
      if (seenName.has(key)) continue;
      seenName.add(key);
      uniqueByName.push(s);
    }
    return uniqueByName.slice(0, 15);
  } catch {
    return [];
  }
}

async function fetchSubtitleCatDetail(detailUrl) {
  try {
    const res = await fetchText(detailUrl, {}, 6500);
    if (res.status !== 200) return [];
    const html = res.body;
    const matches = [...html.matchAll(/href="(\/subs\/[^"]*(?:zh[-_]?CN|zh[-_]?TW|zh[-_]?HK|zh|chs|cht)[^"]*\.srt)"/gi)];
    const found = [];
    const seen = new Set();
    for (const m of matches) {
      const rel = m[1];
      const absUrl = `https://www.subtitlecat.com${rel}`;
      if (seen.has(absUrl)) continue;
      seen.add(absUrl);

      const fileName = decodeURIComponent(rel.split('/').pop() || 'subtitle.srt');
      const isSimplified = /zh[-_]?cn|chs/i.test(fileName);
      const isTraditional = /zh[-_]?tw|zh[-_]?hk|cht/i.test(fileName);
      found.push({
        id: absUrl,
        url: absUrl,
        label: fileName.replace(/\.srt$/i, ''),
        tag: isSimplified ? '简' : isTraditional ? '繁' : '中',
        ext: 'SRT',
        source: 'subtitlecat',
        score: isSimplified ? 55 : isTraditional ? 30 : 40
      });
    }
    return found;
  } catch {
    return [];
  }
}

async function searchSubtitleCatFallback(query) {
  try {
    const searchUrl = `https://www.subtitlecat.com/index.php?search=${encodeURIComponent(query)}`;
    const res = await fetchText(searchUrl, {}, 7500);
    if (res.status !== 200) return [];

    const detailHrefs = [];
    const seenHref = new Set();
    for (const m of res.body.matchAll(/href="(subs\/[^"]+\.html)"/gi)) {
      const h = m[1];
      if (!seenHref.has(h)) {
        seenHref.add(h);
        detailHrefs.push(`https://www.subtitlecat.com/${h}`);
        if (detailHrefs.length >= 5) break;
      }
    }

    const resultsNested = await Promise.all(detailHrefs.map(fetchSubtitleCatDetail));
    const merged = [];
    const seenUrl = new Set();
    for (const list of resultsNested) {
      for (const item of list) {
        if (!seenUrl.has(item.url)) {
          seenUrl.add(item.url);
          merged.push(item);
        }
      }
    }
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, 8);
  } catch {
    return [];
  }
}

async function searchChineseSubtitles({ title, year, mediaType, season, episode }) {
  const query = buildSubtitleSearchQuery({ title, year, mediaType, season, episode });
  if (!query) return { query: '', subtitles: [] };

  // 1. Primary: Xunlei curated Chinese subtitle library (high quality, clean, rich)
  let subs = await searchXunleiSubtitles(query, year);

  // 2. Fallback only when primary returns fewer than 2 results
  if (subs.length < 2) {
    const fallback = await searchSubtitleCatFallback(year ? `${query} ${year}` : query);
    const seen = new Set(subs.map(s => s.url));
    for (const f of fallback) {
      if (!seen.has(f.url)) {
        seen.add(f.url);
        subs.push(f);
      }
    }
  }

  return { query, subtitles: subs.slice(0, 15) };
}

// ---------- HLS Playlist Rewriting, Ring Prefetch Cache & Media Proxy ----------

function evictSegmentCacheIfNeeded() {
  while (segmentCache.size > MAX_SEG_CACHE_ITEMS || segmentCacheBytes > MAX_SEG_CACHE_BYTES) {
    const oldestKey = segmentCache.keys().next().value;
    if (!oldestKey) break;
    const item = segmentCache.get(oldestKey);
    segmentCache.delete(oldestKey);
    if (item && item.size) segmentCacheBytes = Math.max(0, segmentCacheBytes - item.size);
  }
}

function prefetchSegment(token) {
  if (!token || segmentCache.has(token)) return;
  const entry = proxyTokens.get(token);
  if (!entry || entry.type !== 'bin') return;

  const slot = { promise: null, buffer: null, contentType: 'video/mp2t', status: 200, size: 0, at: Date.now() };
  segmentCache.set(token, slot);

  slot.promise = fetchText(entry.url, entry.headers || {}, 15000)
    .then(result => {
      if (result.status < 200 || result.status >= 300 || !result.buffer || result.buffer.length > MAX_SINGLE_SEG_BYTES) {
        segmentCache.delete(token);
        return null;
      }
      slot.buffer = result.buffer;
      slot.size = result.buffer.length;
      slot.status = result.status;
      slot.contentType = result.headers['content-type'] || 'video/mp2t';
      segmentCacheBytes += slot.size;
      evictSegmentCacheIfNeeded();
      return slot;
    })
    .catch(() => {
      segmentCache.delete(token);
      return null;
    });
}

function prefetchAhead(entry, count = 3) {
  if (!entry || !Array.isArray(entry.playlistSeq) || typeof entry.seqIndex !== 'number') return;
  for (let offset = 1; offset <= count; offset++) {
    const nextTok = entry.playlistSeq[entry.seqIndex + offset];
    if (nextTok) prefetchSegment(nextTok);
  }
}

function serveBufferedSegment(req, res, slot) {
  const buf = slot.buffer;
  const total = buf.length;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d*)-(\d*)/i);
    if (m) {
      const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
      const end = m[2] === '' ? total - 1 : Math.min(total - 1, Number(m[2]));
      if (start <= end && start < total) {
        const slice = buf.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': slot.contentType,
          'Content-Length': slice.length,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(req.method === 'HEAD' ? undefined : slice);
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': slot.contentType,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function rewriteM3u8(content, baseUrl, localBase, headers) {
  const lines = content.split(/\r?\n/);
  const segmentSeq = [];
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Rewrite URI="..." inside tags like #EXT-X-KEY, #EXT-X-MAP (init.mp4), or #EXT-X-MEDIA
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
        const abs = new URL(uri, baseUrl).href;
        const isSub = /\.m3u8(\?|$)/i.test(abs);
        const isInitMp4 = /\.mp4(\?|$)/i.test(abs);
        const tok = createToken({ url: abs, headers, type: isSub ? 'hls' : isInitMp4 ? 'bin' : 'key' });
        if (isInitMp4) prefetchSegment(tok);
        const ext = isSub ? '.m3u8' : isInitMp4 ? '.mp4' : '';
        return `URI="${localBase}/proxy/media/${tok}${ext}"`;
      });
    }

    const abs = new URL(trimmed, baseUrl).href;
    const isSubPlaylist = /\.m3u8(\?|$)/i.test(abs);
    const seqIndex = isSubPlaylist ? -1 : segmentSeq.length;
    const tok = createToken({
      url: abs,
      headers,
      type: isSubPlaylist ? 'hls' : 'bin',
      playlistSeq: isSubPlaylist ? null : segmentSeq,
      seqIndex
    });
    if (!isSubPlaylist) segmentSeq.push(tok);
    const ext = isSubPlaylist
      ? '.m3u8'
      : /\.m4s(\?|$)/i.test(abs)
        ? '.m4s'
        : /\.mp4(\?|$)/i.test(abs)
          ? '.mp4'
          : /\.ts(\?|$)/i.test(abs)
            ? '.ts'
            : '';
    return `${localBase}/proxy/media/${tok}${ext}`;
  });

  // Warm up the first 2 segments immediately when a media playlist is fetched
  if (segmentSeq.length > 0) {
    prefetchSegment(segmentSeq[0]);
    if (segmentSeq[1]) prefetchSegment(segmentSeq[1]);
  }
  return rewritten.join('\n');
}

function handleMediaProxy(req, res, token) {
  if (req.socket) {
    try { req.socket.setNoDelay(true); } catch {}
  }

  const entry = proxyTokens.get(token);
  if (!entry) {
    res.writeHead(404);
    return res.end('Token expired');
  }

  // Lossless FFmpeg MPEG-TS remux mode (fixes fMP4/.m4s black screen on Hisense/domestic TVs; <2% CPU)
  if (entry.type === 'remux' && ffmpegAvailable) {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'video/mp2ts',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end();
    }

    const inputUrl = entry.localInputUrl || entry.url;
    const startSec = Math.max(0, Math.floor(Number(entry.startTime) || 0));
    const audioOff = Number(entry.audioOffset) || 0;
    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts+discardcorrupt'];

    if (Math.abs(audioOff) >= 0.05) {
      if (startSec > 0) ffArgs.push('-ss', String(startSec));
      ffArgs.push('-i', inputUrl);
      if (startSec > 0) ffArgs.push('-ss', String(startSec));
      ffArgs.push('-itsoffset', String(audioOff), '-i', inputUrl);
      ffArgs.push('-map', '0:v:0', '-map', '1:a:0?', '-c', 'copy', '-mpegts_flags', '+initial_discontinuity', '-f', 'mpegts', 'pipe:1');
    } else {
      if (startSec > 0) ffArgs.push('-ss', String(startSec));
      ffArgs.push('-i', inputUrl);
      ffArgs.push('-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-mpegts_flags', '+initial_discontinuity', '-f', 'mpegts', 'pipe:1');
    }

    res.writeHead(200, {
      'Content-Type': 'video/mp2ts',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });

    const ff = spawn(ffmpegBin, ffArgs, { windowsHide: true });
    activeFfmpegs.add(ff);
    ff.stdout.pipe(res);

    const cleanup = () => {
      activeFfmpegs.delete(ff);
      try { ff.kill('SIGKILL'); } catch {}
    };
    ff.on('exit', () => activeFfmpegs.delete(ff));
    ff.on('error', () => {
      cleanup();
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    req.on('close', cleanup);
    return;
  }

  // HLS playlist rewrite
  if (entry.type === 'hls') {
    const hostHeader = req.headers.host || `127.0.0.1:${PORT}`;
    const localBase = `http://${hostHeader}`;
    fetchText(entry.url, entry.headers || {}, 10000)
      .then(result => {
        const body = rewriteM3u8(result.body, result.finalUrl || entry.url, localBase, entry.headers || {});
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        });
        res.end(body);
      })
      .catch(err => {
        res.writeHead(502);
        res.end(`Upstream HLS error: ${err.message}`);
      });
    return;
  }

  // Trigger lookahead prefetch for the next 3 HLS segments immediately
  prefetchAhead(entry, 3);

  // Serve directly from memory ring cache if this segment was prefetched
  const cached = segmentCache.get(token);
  if (cached) {
    if (cached.buffer) {
      return serveBufferedSegment(req, res, cached);
    }
    if (cached.promise) {
      cached.promise.then(slot => {
        if (res.writableEnded || res.destroyed) return;
        if (slot && slot.buffer) {
          serveBufferedSegment(req, res, slot);
        } else {
          pipeUpstream(entry.url, 5, true);
        }
      });
      return;
    }
  }

  // Direct Keep-Alive streaming proxy (supports Range for MP4/TS seeking, zero first-byte wait)
  const upstreamHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ...(entry.headers || {})
  };
  if (req.headers.range) {
    upstreamHeaders.Range = req.headers.range;
  }

  function pipeUpstream(targetUrl, redirects = 5, useProxy = true) {
    let upReq;
    try {
      upReq = openUpstreamRequest(
        targetUrl,
        { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: upstreamHeaders, timeoutMs: 20000, useProxy },
        upRes => {
          if ([301, 302, 303, 307, 308].includes(upRes.statusCode) && upRes.headers.location && redirects > 0) {
            upRes.resume();
            const next = new URL(upRes.headers.location, targetUrl).href;
            return pipeUpstream(next, redirects - 1, useProxy);
          }
          const respHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': upRes.headers['accept-ranges'] || 'bytes'
          };
          if (upRes.headers['content-type']) respHeaders['Content-Type'] = upRes.headers['content-type'];
          if (upRes.headers['content-length']) respHeaders['Content-Length'] = upRes.headers['content-length'];
          if (upRes.headers['content-range']) respHeaders['Content-Range'] = upRes.headers['content-range'];

          res.writeHead(upRes.statusCode || 200, respHeaders);
          if (req.method === 'HEAD') {
            upRes.resume();
            return res.end();
          }
          upRes.pipe(res);
        }
      );
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(`Upstream stream error: ${err.message}`);
      }
      return;
    }
    upReq.on('error', err => {
      if (useProxy && !res.headersSent && getSystemProxy() && !isLanHost(new URL(targetUrl).hostname)) {
        return pipeUpstream(targetUrl, redirects, false);
      }
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(`Upstream stream error: ${err.message}`);
      } else {
        res.end();
      }
    });
    req.on('close', () => upReq.destroy());
    upReq.end();
  }

  pipeUpstream(entry.url);
}

function handleSubtitleProxy(req, res, token) {
  const entry = proxyTokens.get(token);
  if (!entry) {
    res.writeHead(404);
    return res.end('Subtitle token expired');
  }
  fetchText(entry.url, entry.headers || {}, 8000)
    .then(result => {
      const srt = convertAndShiftSubtitleToSrt(decodeSubtitleBuffer(result.buffer), entry.subtitleOffset || 0);
      res.writeHead(200, {
        'Content-Type': 'text/srt; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      res.end(srt);
    })
    .catch(err => {
      res.writeHead(502);
      res.end(`Subtitle error: ${err.message}`);
    });
}

// ---------- Local Control API ----------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function isLocalClient(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function queryPlaybackStatus(dev) {
  let position = 0;
  let duration = 0;
  let state = 'UNKNOWN';
  let volume = null;

  await Promise.all([
    sendSoap(dev.avControlUrl, dev.avServiceType, 'GetPositionInfo', '<InstanceID>0</InstanceID>')
      .then(posXml => {
        position = parseHms(extractXmlTag(posXml, 'RelTime'));
        duration = parseHms(extractXmlTag(posXml, 'TrackDuration'));
      })
      .catch(() => {}),
    sendSoap(dev.avControlUrl, dev.avServiceType, 'GetTransportInfo', '<InstanceID>0</InstanceID>')
      .then(trXml => {
        state = extractXmlTag(trXml, 'CurrentTransportState') || 'UNKNOWN';
      })
      .catch(() => {}),
    dev.rcControlUrl
      ? sendSoap(dev.rcControlUrl, dev.rcServiceType, 'GetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel>')
          .then(volXml => {
            const v = Number(extractXmlTag(volXml, 'CurrentVolume'));
            if (!Number.isNaN(v)) volume = v;
          })
          .catch(() => {})
      : Promise.resolve()
  ]);

  return { position, duration, state, volume };
}

async function estimateHlsDurationSec(m3u8Url, headers) {
  try {
    const res = await fetchText(m3u8Url, headers || {}, 6000);
    if (res.status < 200 || res.status >= 300) return 0;
    let total = 0;
    for (const m of res.body.matchAll(/#EXTINF:([\d.]+)/gi)) {
      total += parseFloat(m[1]) || 0;
    }
    return Math.floor(total);
  } catch {
    return 0;
  }
}

async function castMediaToDevice(dev, { mediaUrl, subtitleUrl, title, headers, subtitleOffset = 0, audioOffset = 0, startTime = 0, knownDuration = 0 }) {
  killAllFfmpegs();

  const localIp = pickLocalIpForTarget(dev.host);
  const localBase = `http://${localIp}:${PORT}`;
  const isHls = /\.m3u8(\?|$)/i.test(mediaUrl);
  const useAudioOffset = Math.abs(Number(audioOffset) || 0) >= 0.05 && ffmpegAvailable;
  // Automatically remux HLS to standard MPEG-TS when ffmpeg is installed (fixes fMP4/.m4s black screen on Hisense/domestic TVs)
  const useRemux = ffmpegAvailable && (isHls || useAudioOffset);
  const resolvedStart = Math.max(0, Math.floor(Number(startTime) || 0));

  let proxiedMediaUrl = '';
  let mimeType = 'video/mp4';

  if (useRemux) {
    // Route FFmpeg input through our own local proxy so it inherits system proxy, Keep-Alive, and 3-segment prefetch cache
    const srcToken = createToken({
      url: mediaUrl,
      headers: headers || {},
      type: isHls ? 'hls' : 'bin'
    });
    const srcExt = isHls ? '.m3u8' : '.mp4';
    const localInputUrl = `http://127.0.0.1:${PORT}/proxy/media/${srcToken}${srcExt}`;

    const remuxToken = crypto.randomBytes(10).toString('hex');
    proxyTokens.set(remuxToken, {
      url: mediaUrl,
      localInputUrl,
      headers: headers || {},
      type: 'remux',
      startTime: resolvedStart,
      audioOffset: useAudioOffset ? Number(audioOffset) : 0,
      createdAt: Date.now()
    });
    proxiedMediaUrl = `${localBase}/proxy/media/${remuxToken}.ts`;
    mimeType = 'video/mp2ts';
  } else {
    const mediaToken = createToken({
      url: mediaUrl,
      headers: headers || {},
      type: isHls ? 'hls' : 'bin'
    });
    const ext = isHls ? '.m3u8' : '.mp4';
    proxiedMediaUrl = `${localBase}/proxy/media/${mediaToken}${ext}`;
    mimeType = isHls ? 'application/vnd.apple.mpegurl' : 'video/mp4';
  }

  let proxiedSubUrl = '';
  if (subtitleUrl) {
    const subToken = createToken({
      url: subtitleUrl,
      headers: headers || {},
      type: 'sub',
      subtitleOffset: Number(subtitleOffset) || 0
    });
    proxiedSubUrl = `${localBase}/proxy/subtitle/${subToken}.srt`;
  }

  const metadata = buildDidlMetadata({
    title: title || 'Movy Video',
    mediaUrl: proxiedMediaUrl,
    mimeType,
    subtitleUrl: proxiedSubUrl
  });

  try {
    await sendSoap(dev.avControlUrl, dev.avServiceType, 'Stop', '<InstanceID>0</InstanceID>');
  } catch {}

  await sendSoap(
    dev.avControlUrl,
    dev.avServiceType,
    'SetAVTransportURI',
    `<InstanceID>0</InstanceID>` +
      `<CurrentURI>${xmlEscape(proxiedMediaUrl)}</CurrentURI>` +
      `<CurrentURIMetaData>${xmlEscape(metadata)}</CurrentURIMetaData>`
  );

  await sendSoap(
    dev.avControlUrl,
    dev.avServiceType,
    'Play',
    '<InstanceID>0</InstanceID><Speed>1</Speed>'
  );

  if (resolvedStart > 3 && !useRemux) {
    setTimeout(() => {
      sendSoap(
        dev.avControlUrl,
        dev.avServiceType,
        'Seek',
        `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${formatHms(resolvedStart)}</Target>`
      ).catch(() => {});
    }, 1200);
  }

  currentSession = {
    udn: dev.udn,
    deviceName: dev.name,
    title: title || 'Movy Video',
    mediaUrl,
    subtitleUrl: subtitleUrl || '',
    subtitleOffset: Number(subtitleOffset) || 0,
    audioOffset: Number(audioOffset) || 0,
    headers: headers || {},
    remuxMode: useRemux,
    remuxStartOffset: useRemux ? resolvedStart : 0,
    duration: knownDuration || 0,
    startedAt: Date.now()
  };

  // Fill duration asynchronously for remuxed HLS streams so seek bar shows accurate total time
  if (useRemux && isHls && !currentSession.duration) {
    estimateHlsDurationSec(mediaUrl, headers).then(dur => {
      if (currentSession && currentSession.mediaUrl === mediaUrl && dur > 0) {
        currentSession.duration = dur;
      }
    }).catch(() => {});
  }

  return currentSession;
}

const server = http.createServer(async (req, res) => {
  lastActivityAt = Date.now();
  const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // LAN-accessible proxy routes for the TV
  const mediaMatch = pathname.match(/^\/proxy\/media\/([a-f0-9]+)(?:\.[a-z0-9]+)?$/i);
  if (mediaMatch) {
    return handleMediaProxy(req, res, mediaMatch[1]);
  }
  const subMatch = pathname.match(/^\/proxy\/subtitle\/([a-f0-9]+)(?:\.srt)?$/i);
  if (subMatch) {
    return handleSubtitleProxy(req, res, subMatch[1]);
  }

  // Control API: localhost only
  if (!isLocalClient(req)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        port: PORT,
        ffmpegAvailable,
        deviceCount: devices.size,
        session: currentSession
      });
    }

    if (pathname === '/api/snapshot' && req.method === 'GET') {
      // Instant response from memory (never block UI on SSDP discovery)
      if (devices.size === 0) {
        discoverDevices(2200).catch(() => {});
      }
      return sendJson(res, 200, {
        ok: true,
        port: PORT,
        ffmpegAvailable,
        devices: Array.from(devices.values()),
        session: currentSession
      });
    }

    if (pathname === '/api/devices' && req.method === 'GET') {
      const refresh = urlObj.searchParams.get('refresh') === '1';
      const list = refresh ? await discoverDevices(2200) : Array.from(devices.values());
      if (!refresh && devices.size === 0) {
        discoverDevices(2200).catch(() => {});
      }
      return sendJson(res, 200, { devices: list });
    }

    if (pathname === '/api/devices/add' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.location) return sendJson(res, 400, { error: 'Missing location URL' });
      const dev = await inspectDeviceLocation(body.location.trim());
      if (!dev) return sendJson(res, 404, { error: 'Unable to parse DLNA device at that URL' });
      return sendJson(res, 200, { device: dev, devices: Array.from(devices.values()) });
    }

    if (pathname === '/api/cast' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { udn, mediaUrl, subtitleUrl, title, headers, subtitleOffset = 0, audioOffset = 0, startTime = 0 } = body;
      const dev = devices.get(udn);
      if (!dev) return sendJson(res, 404, { error: 'TV device not found' });
      if (!mediaUrl) return sendJson(res, 400, { error: 'Missing mediaUrl' });

      const session = await castMediaToDevice(dev, {
        mediaUrl,
        subtitleUrl,
        title,
        headers,
        subtitleOffset,
        audioOffset,
        startTime
      });
      return sendJson(res, 200, { ok: true, session });
    }

    if (pathname === '/api/control' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { action, udn, value } = body;
      const targetUdn = udn || currentSession?.udn;
      const dev = devices.get(targetUdn);
      if (!dev) return sendJson(res, 404, { error: 'No active TV device' });

      if (action === 'play') {
        await sendSoap(dev.avControlUrl, dev.avServiceType, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
      } else if (action === 'pause') {
        await sendSoap(dev.avControlUrl, dev.avServiceType, 'Pause', '<InstanceID>0</InstanceID>');
      } else if (action === 'stop') {
        await sendSoap(dev.avControlUrl, dev.avServiceType, 'Stop', '<InstanceID>0</InstanceID>');
        killAllFfmpegs();
        currentSession = null;
        segmentCache.clear();
        segmentCacheBytes = 0;
      } else if (action === 'seek') {
        if (currentSession && currentSession.remuxMode) {
          // Remuxed MPEG-TS stream seeks by restarting FFmpeg cleanly at the target timestamp
          await castMediaToDevice(dev, {
            mediaUrl: currentSession.mediaUrl,
            subtitleUrl: currentSession.subtitleUrl,
            title: currentSession.title,
            headers: currentSession.headers,
            subtitleOffset: currentSession.subtitleOffset,
            audioOffset: currentSession.audioOffset,
            startTime: Number(value) || 0,
            knownDuration: currentSession.duration || 0
          });
        } else {
          await sendSoap(
            dev.avControlUrl,
            dev.avServiceType,
            'Seek',
            `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${formatHms(value)}</Target>`
          );
        }
      } else if (action === 'volume' && dev.rcControlUrl) {
        const vol = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        await sendSoap(
          dev.rcControlUrl,
          dev.rcServiceType,
          'SetVolume',
          `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${vol}</DesiredVolume>`
        );
      } else {
        return sendJson(res, 400, { error: 'Unsupported action' });
      }
      return sendJson(res, 200, { ok: true, session: currentSession });
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      if (!currentSession) return sendJson(res, 200, { active: false });
      const dev = devices.get(currentSession.udn);
      if (!dev) return sendJson(res, 200, { active: false });

      const status = await queryPlaybackStatus(dev);
      const pos = currentSession.remuxMode
        ? (currentSession.remuxStartOffset || 0) + (status.position || 0)
        : status.position;
      const dur = status.duration > 0 ? status.duration : (currentSession.duration || 0);
      return sendJson(res, 200, {
        active: true,
        session: currentSession,
        ...status,
        position: pos,
        duration: dur
      });
    }

    if (pathname === '/api/subtitles/search' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await searchChineseSubtitles({
        imdbId: body.imdbId || '',
        title: body.title || '',
        year: body.year || '',
        mediaType: body.mediaType || 'movie',
        season: body.season || 0,
        episode: body.episode || 0
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/subtitles/vtt' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.url) return sendJson(res, 400, { error: 'Missing subtitle url' });
      const fetched = await fetchText(body.url, body.headers || {}, 8000);
      if (fetched.status < 200 || fetched.status >= 300) {
        return sendJson(res, 502, { error: `Subtitle fetch failed (${fetched.status})` });
      }
      const vtt = convertAndShiftSubtitleToVtt(decodeSubtitleBuffer(fetched.buffer), body.offset || 0);
      return sendJson(res, 200, { vtt });
    }

    if (pathname === '/api/subtitles/auto-sync' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.refUrl || !body.targetUrl) {
        return sendJson(res, 400, { error: 'Missing refUrl or targetUrl' });
      }
      const [refRes, tgtRes] = await Promise.all([
        fetchText(body.refUrl, body.refHeaders || {}, 8000),
        fetchText(body.targetUrl, body.targetHeaders || {}, 8000)
      ]);
      if (refRes.status < 200 || refRes.status >= 300 || tgtRes.status < 200 || tgtRes.status >= 300) {
        return sendJson(res, 502, { error: '字幕下载失败，无法比对' });
      }
      const result = computeSubtitleAutoOffset(decodeSubtitleBuffer(refRes.buffer), decodeSubtitleBuffer(tgtRes.buffer));
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal error' });
  }
});

function startBridgeServer({ silent = false } = {}) {
  return new Promise((resolve, reject) => {
    const onErr = err => {
      if (err && err.code === 'EADDRINUSE') {
        resolve({ port: PORT, alreadyRunning: true });
      } else {
        reject(err);
      }
    };
    server.once('error', onErr);
    server.listen(PORT, '0.0.0.0', () => {
      server.removeListener('error', onErr);
      if (!silent) {
        console.log(`[Movy Cast Bridge] Running on http://127.0.0.1:${PORT}`);
        console.log(`[Movy Cast Bridge] FFmpeg audio-offset remux: ${ffmpegAvailable ? 'available' : 'not installed (subtitle offset still works)'}`);
      }
      discoverDevices(2200).then(list => {
        if (!silent) {
          console.log(`[Movy Cast Bridge] Discovered ${list.length} DLNA device(s)`);
        }
      });
      resolve({ port: PORT, alreadyRunning: false });
    });
  });
}

process.on('exit', killAllFfmpegs);
process.on('SIGINT', () => { killAllFfmpegs(); process.exit(0); });
process.on('SIGTERM', () => { killAllFfmpegs(); process.exit(0); });

if (require.main === module) {
  startBridgeServer({ silent: false }).catch(err => {
    console.error('[Movy Cast Bridge] Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = {
  PORT,
  startBridgeServer,
  hasActiveSession: () => Boolean(currentSession),
  getLastActivityAt: () => lastActivityAt
};
