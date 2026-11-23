#!/usr/bin/env node
'use strict';

const { PORT, startBridgeServer, hasActiveSession, getLastActivityAt } = require('./server.js');

function sendNativeMessage(obj) {
  try {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    process.stdout.write(Buffer.concat([header, json]));
  } catch {}
}

let browserDisconnected = false;
let serverReady = false;

startBridgeServer({ silent: true })
  .then(info => {
    serverReady = true;
    sendNativeMessage({ ok: true, event: 'ready', port: info.port, alreadyRunning: Boolean(info.alreadyRunning) });
  })
  .catch(err => {
    sendNativeMessage({ ok: false, error: err.message || 'Failed to start bridge' });
    process.exit(1);
  });

// Read length-prefixed JSON messages from Chrome/Edge
let inputBuf = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  inputBuf = Buffer.concat([inputBuf, chunk]);
  while (inputBuf.length >= 4) {
    const msgLen = inputBuf.readUInt32LE(0);
    if (inputBuf.length < 4 + msgLen) break;
    const payload = inputBuf.subarray(4, 4 + msgLen).toString('utf8');
    inputBuf = inputBuf.subarray(4 + msgLen);
    try {
      const msg = JSON.parse(payload);
      if (msg && msg.type === 'ping') {
        sendNativeMessage({ ok: true, event: 'pong', port: PORT, ready: serverReady });
      }
    } catch {}
  }
});

// When browser closes all movy tabs or disconnects native port, exit cleanly once idle
process.stdin.on('end', () => {
  browserDisconnected = true;
  if (!hasActiveSession()) {
    setTimeout(() => {
      if (!hasActiveSession() && Date.now() - getLastActivityAt() > 8000) {
        process.exit(0);
      }
    }, 10000);
  }
});

setInterval(() => {
  if (!browserDisconnected) return;
  const idleMs = Date.now() - getLastActivityAt();
  // If browser disconnected and no active cast (or TV stopped pulling stream for 3 minutes), exit
  if ((!hasActiveSession() && idleMs > 15000) || idleMs > 180000) {
    process.exit(0);
  }
}, 15000).unref();
