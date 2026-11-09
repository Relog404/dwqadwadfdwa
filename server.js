#!/usr/bin/env node
/* MAX-style messenger demo server: static files + JSON API + SSE. No dependencies. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const DB_FILE = path.join(DATA, 'db.json');

fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------------------------------------------------------------- db */

function loadDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.users = db.users || [];
    db.chats = db.chats || [];
    db.messages = db.messages || [];
    db.calls = db.calls || [];
    db.sessions = db.sessions || {};
    return db;
  } catch (e) {
    return { users: [], chats: [], messages: [], calls: [], sessions: {} };
  }
}

const db = loadDB();
let saveTimer = null;
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('save failed', e); }
  }, 150);
}

/* --------------------------------------------------------------- seed */

const SEED_USERS = [
  { number: '9001112233', name: 'Александр' },
  { number: '9002223344', name: 'Мария' },
  { number: '9003334455', name: 'Дмитрий' },
  { number: '9004445566', name: 'Елена' },
  { number: '9005556677', name: 'Сергей' },
  { number: '9006667788', name: 'Ольга' },
  { number: '9007778899', name: 'Павел' },
  { number: '9008889900', name: 'Ирина' },
  { number: '7001112233', name: 'MAX Новости', isChannel: true },
];

function seed() {
  let changed = false;
  for (const s of SEED_USERS) {
    if (!db.users.find(u => u.number === s.number)) {
      db.users.push({
        number: s.number,
        password: null,           // claimable: first to enter the number sets a password
        name: s.name,
        avatar: null,
        isChannel: !!s.isChannel,
        createdAt: Date.now(),
        lastSeen: null,
      });
      changed = true;
    }
  }
  if (changed) saveDB();
}
seed();

/* -------------------------------------------------------------- utils */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); }
  catch (e) { throw new Error('bad json'); }
}

function normNumber(s) {
  return String(s || '').replace(/[^\d+]/g, '').slice(0, 20);
}

function publicUser(u) {
  if (!u) return null;
  return {
    number: u.number,
    name: u.name,
    avatar: u.avatar || null,
    isChannel: !!u.isChannel,
    online: hasConn(u.number),
    lastSeen: u.lastSeen || null,
  };
}

function userByNumber(n) { return db.users.find(u => u.number === n); }

function issueToken(number) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.sessions[token] = number;
  saveDB();
  return token;
}

function authFrom(req, url) {
  const h = req.headers['authorization'] || '';
  let token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token && url) token = url.searchParams.get('token') || '';
  if (!token) return null;
  const number = db.sessions[token];
  if (!number) return null;
  const user = userByNumber(number);
  return user ? { token, user } : null;
}

/* --------------------------------------------------------------- sse */

/** number -> Set<ServerResponse> */
const conns = new Map();

function hasConn(number) {
  const s = conns.get(number);
  return !!(s && s.size);
}

function sendEvent(res, obj) {
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { /* ignore */ }
}

function broadcastTo(number, obj) {
  const s = conns.get(number);
  if (!s) return;
  for (const res of s) sendEvent(res, obj);
}

function broadcastAll(obj) {
  for (const set of conns.values()) for (const res of set) sendEvent(res, obj);
}

function addConn(number, res) {
  if (!conns.has(number)) conns.set(number, new Set());
  conns.get(number).add(res);
  broadcastAll({ event: 'presence', number, online: true });
}

function removeConn(number, res) {
  const s = conns.get(number);
  if (s) {
    s.delete(res);
    if (!s.size) {
      conns.delete(number);
      const u = userByNumber(number);
      if (u) { u.lastSeen = Date.now(); saveDB(); }
      broadcastAll({ event: 'presence', number, online: false, lastSeen: u ? u.lastSeen : null });
    }
  }
}

/* ------------------------------------------------------------ chat api */

function chatSummary(chat, me) {
  const peerNum = chat.members.find(m => m !== me) || chat.members[0];
  const peer = userByNumber(peerNum);
  const msgs = db.messages.filter(m => m.chatId === chat.id);
  const last = msgs[msgs.length - 1] || null;
  const unread = msgs.filter(m => m.from !== me && !m.readBy.includes(me)).length;
  return {
    id: chat.id,
    peer: publicUser(peer),
    folder: chat.folder || null,
    lastMessage: last,
    unread,
    updatedAt: chat.updatedAt || (last ? last.ts : chat.createdAt),
    deletedFor: undefined,
  };
}

function visibleChats(me) {
  return db.chats
    .filter(c => c.members.includes(me) && !(c.deletedFor || []).includes(me))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function findDirect(a, b) {
  return db.chats.find(c =>
    c.members.length === 2 && c.members.includes(a) && c.members.includes(b));
}

function assertChatMember(chat, me) {
  if (!chat || !chat.members.includes(me)) throw Object.assign(new Error('no chat'), { code: 404 });
}

/* ---------------------------------------------------------- call logic */

const ringingTimers = new Map();

function callPeers(call) { return [call.from, call.to]; }

function broadcastCall(call, event, extra) {
  for (const p of callPeers(call)) broadcastTo(p, Object.assign({ event, call }, extra || {}));
}

function logCall(call) {
  db.calls.push(call);
  saveDB();
}

/* -------------------------------------------------------------- router */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler });
}

/* --- auth --- */

route('POST', '/api/auth/step1', async (req, res, _u, body) => {
  const number = normNumber(body.number);
  if (number.length < 3) return sendJSON(res, 400, { error: 'Введите номер (минимум 3 цифры)' });
  let user = userByNumber(number);
  if (!user) {
    user = { number, password: null, name: number, avatar: null, isChannel: false, createdAt: Date.now(), lastSeen: Date.now() };
    db.users.push(user);
    saveDB();
    return sendJSON(res, 200, { mode: 'set-password', number });
  }
  if (!user.password) return sendJSON(res, 200, { mode: 'set-password', number });
  return sendJSON(res, 200, { mode: 'login', number, name: user.name });
});

route('POST', '/api/auth/set-password', async (req, res, _u, body) => {
  const number = normNumber(body.number);
  const password = String(body.password || '');
  if (!password) return sendJSON(res, 400, { error: 'Введите пароль' });
  const user = userByNumber(number);
  if (!user) return sendJSON(res, 400, { error: 'Сначала введите номер' });
  user.password = password;
  user.lastSeen = Date.now();
  const token = issueToken(number);
  return sendJSON(res, 200, { token, user: publicUser(user) });
});

route('POST', '/api/auth/login', async (req, res, _u, body) => {
  const number = normNumber(body.number);
  const password = String(body.password || '');
  const user = userByNumber(number);
  if (!user || !user.password) return sendJSON(res, 400, { error: 'Номер не найден' });
  if (user.password !== password) return sendJSON(res, 401, { error: 'Неверный пароль' });
  user.lastSeen = Date.now();
  const token = issueToken(number);
  return sendJSON(res, 200, { token, user: publicUser(user) });
});

route('POST', '/api/auth/recover', async (req, res, _u, body) => {
  const number = normNumber(body.number);
  const password = String(body.password || '');
  if (!password) return sendJSON(res, 400, { error: 'Введите новый пароль' });
  const user = userByNumber(number);
  if (!user) return sendJSON(res, 400, { error: 'Номер не найден' });
  user.password = password;
  user.lastSeen = Date.now();
  const token = issueToken(number);
  return sendJSON(res, 200, { token, user: publicUser(user) });
});

/* --- me --- */

route('GET', '/api/me', async (req, res, auth) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  return sendJSON(res, 200, { user: publicUser(auth.user) });
});

route('POST', '/api/me', async (req, res, auth, body) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const u = auth.user;
  if (typeof body.name === 'string') {
    const name = body.name.trim().slice(0, 64);
    if (name) u.name = name;
  }
  if (body.avatar === null) u.avatar = null;
  else if (typeof body.avatar === 'string') u.avatar = body.avatar.slice(0, 512);
  saveDB();
  broadcastAll({ event: 'user', user: publicUser(u) });
  return sendJSON(res, 200, { user: publicUser(u) });
});

route('POST', '/api/change-password', async (req, res, auth, body) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const oldP = String(body.oldPassword || '');
  const newP = String(body.newPassword || '');
  if (!newP) return sendJSON(res, 400, { error: 'Введите новый пароль' });
  if (auth.user.password !== oldP) return sendJSON(res, 401, { error: 'Неверный текущий пароль' });
  auth.user.password = newP;
  saveDB();
  return sendJSON(res, 200, { ok: true });
});

/* --- users --- */

route('GET', '/api/search-users', async (req, res, auth, _b, _p, url) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  let users = db.users.filter(u => u.number !== auth.user.number);
  if (q) {
    const digits = q.replace(/[^\d+]/g, '');
    users = users.filter(u =>
      u.name.toLowerCase().includes(q) || (digits.length > 0 && u.number.includes(digits)) );
  }
  users = users.slice(0, 30);
  return sendJSON(res, 200, { users: users.map(publicUser) });
});

/* --- chats --- */

route('GET', '/api/chats', async (req, res, auth) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const chats = visibleChats(auth.user.number).map(c => chatSummary(c, auth.user.number));
  return sendJSON(res, 200, { chats });
});

route('POST', '/api/chats', async (req, res, auth, body) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const peerNumber = normNumber(body.peerNumber);
  const peer = userByNumber(peerNumber);
  if (!peer) return sendJSON(res, 404, { error: 'Пользователь не найден' });
  if (peer.number === auth.user.number) return sendJSON(res, 400, { error: 'Нельзя написать самому себе' });
  let chat = findDirect(auth.user.number, peer.number);
  if (!chat) {
    chat = {
      id: 'c' + crypto.randomBytes(8).toString('hex'),
      members: [auth.user.number, peer.number],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedFor: [],
      folder: null,
      msgSeq: 0,
    };
    db.chats.push(chat);
  } else {
    chat.deletedFor = [];
  }
  saveDB();
  const summary = chatSummary(chat, auth.user.number);
  broadcastTo(peer.number, { event: 'chat', chat: Object.assign({}, chatSummary(chat, peer.number), { for: peer.number }) });
  return sendJSON(res, 200, { chat: summary });
});

route('POST', '/api/chats/:id/folder', async (req, res, auth, body, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const chat = db.chats.find(c => c.id === params.id);
  assertChatMember(chat, auth.user.number);
  chat.folder = body.folder || null;
  saveDB();
  return sendJSON(res, 200, { ok: true, folder: chat.folder });
});

route('DELETE', '/api/chats/:id', async (req, res, auth, _b, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const chat = db.chats.find(c => c.id === params.id);
  assertChatMember(chat, auth.user.number);
  chat.deletedFor = chat.deletedFor || [];
  if (!chat.deletedFor.includes(auth.user.number)) chat.deletedFor.push(auth.user.number);
  saveDB();
  for (const m of chat.members) {
    if (m === auth.user.number) continue;
    broadcastTo(m, { event: 'chat-deleted', chatId: chat.id, by: auth.user.number });
  }
  return sendJSON(res, 200, { ok: true });
});

route('GET', '/api/chats/:id/messages', async (req, res, auth, _b, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const chat = db.chats.find(c => c.id === params.id);
  assertChatMember(chat, auth.user.number);
  const msgs = db.messages.filter(m => m.chatId === chat.id).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  return sendJSON(res, 200, { messages: msgs });
});

route('POST', '/api/chats/:id/messages', async (req, res, auth, body, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const chat = db.chats.find(c => c.id === params.id);
  assertChatMember(chat, auth.user.number);
  const type = ['text', 'sticker', 'voice', 'video', 'media'].includes(body.type) ? body.type : 'text';
  const msg = {
    id: 'm' + crypto.randomBytes(8).toString('hex'),
    chatId: chat.id,
    from: auth.user.number,
    ts: Date.now(),
    seq: ++chat.msgSeq,
    type,
    text: typeof body.text === 'string' ? body.text.slice(0, 4000) : '',
    url: typeof body.url === 'string' ? body.url.slice(0, 512) : null,
    duration: typeof body.duration === 'number' ? Math.min(body.duration, 3600) : null,
    attachments: Array.isArray(body.attachments)
      ? body.attachments.slice(0, 10).map(a => ({
          type: a && a.type === 'video' ? 'video' : 'image',
          url: String((a && a.url) || '').slice(0, 512),
          w: Math.max(1, Math.min(4000, (a && a.w) | 0 || 400)),
          h: Math.max(1, Math.min(4000, (a && a.h) | 0 || 300)),
        })).filter(a => a.url)
      : [],
    replyTo: (body.replyTo && body.replyTo.id)
      ? { id: String(body.replyTo.id).slice(0, 40), from: String(body.replyTo.from || '').slice(0, 20), text: String(body.replyTo.text || '').slice(0, 300) }
      : null,
    reactions: {},
    readBy: [auth.user.number],
  };
  if (type === 'text' && !msg.text.trim() && !msg.attachments.length) {
    return sendJSON(res, 400, { error: 'Пустое сообщение' });
  }
  db.messages.push(msg);
  chat.updatedAt = msg.ts;
  chat.deletedFor = [];
  saveDB();
  for (const member of chat.members) {
    broadcastTo(member, { event: 'message', chatId: chat.id, message: msg, chat: chatSummary(chat, member) });
  }
  return sendJSON(res, 200, { message: msg });
});

route('POST', '/api/chats/:id/read', async (req, res, auth, _b, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const chat = db.chats.find(c => c.id === params.id);
  assertChatMember(chat, auth.user.number);
  let changed = false;
  for (const m of db.messages) {
    if (m.chatId === chat.id && m.from !== auth.user.number && !m.readBy.includes(auth.user.number)) {
      m.readBy.push(auth.user.number);
      changed = true;
    }
  }
  if (changed) {
    saveDB();
    for (const member of chat.members) {
      if (member !== auth.user.number) broadcastTo(member, { event: 'read', chatId: chat.id, by: auth.user.number });
    }
  }
  return sendJSON(res, 200, { ok: true });
});

route('POST', '/api/chats/:id/typing', async (req, res, auth, _b, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const chat = db.chats.find(c => c.id === params.id);
  assertChatMember(chat, auth.user.number);
  for (const member of chat.members) {
    if (member !== auth.user.number) broadcastTo(member, { event: 'typing', chatId: chat.id, by: auth.user.number });
  }
  return sendJSON(res, 200, { ok: true });
});

route('POST', '/api/chats/:id/messages/:mid/react', async (req, res, auth, body, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const chat = db.chats.find(c => c.id === params.id);
  assertChatMember(chat, auth.user.number);
  const msg = db.messages.find(m => m.id === params.mid && m.chatId === chat.id);
  if (!msg) return sendJSON(res, 404, { error: 'no message' });
  const emoji = String(body.emoji || '👍').slice(0, 8);
  msg.reactions = msg.reactions || {};
  const arr = msg.reactions[emoji] || [];
  const idx = arr.indexOf(auth.user.number);
  if (idx >= 0) arr.splice(idx, 1); else arr.push(auth.user.number);
  if (arr.length) msg.reactions[emoji] = arr; else delete msg.reactions[emoji];
  saveDB();
  for (const member of chat.members) {
    broadcastTo(member, { event: 'message-updated', chatId: chat.id, message: msg });
  }
  return sendJSON(res, 200, { message: msg });
});

route('DELETE', '/api/chats/:id/messages/:mid', async (req, res, auth, _b, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const chat = db.chats.find(c => c.id === params.id);
  assertChatMember(chat, auth.user.number);
  const idx = db.messages.findIndex(m => m.id === params.mid && m.chatId === chat.id);
  if (idx < 0) return sendJSON(res, 404, { error: 'no message' });
  const msg = db.messages[idx];
  if (msg.from !== auth.user.number) return sendJSON(res, 403, { error: 'Можно удалять только свои сообщения' });
  db.messages.splice(idx, 1);
  saveDB();
  for (const member of chat.members) {
    broadcastTo(member, { event: 'message-deleted', chatId: chat.id, messageId: msg.id, chat: chatSummary(chat, member) });
  }
  return sendJSON(res, 200, { ok: true });
});

/* --- upload --- */

route('POST', '/api/upload', async (req, res, auth, body) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const data = String(body.data || '');
  const m = data.match(/^data:(image\/(?:png|jpe?g|webp|gif)|video\/(?:webm|mp4)|audio\/(?:webm|ogg|mpeg|wav));base64,(.+)$/);
  if (!m) return sendJSON(res, 400, { error: 'Ожидается файл' });
  const b64 = m[2];
  if (b64.length > 18 * 1024 * 1024) return sendJSON(res, 400, { error: 'Файл слишком большой' });
  let ext = m[1].split('/')[1];
  if (ext === 'jpeg') ext = 'jpg';
  if (ext === 'mpeg') ext = 'mp3';
  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS, name), Buffer.from(b64, 'base64'));
  return sendJSON(res, 200, { url: '/uploads/' + name });
});

/* --- calls --- */

route('GET', '/api/calls', async (req, res, auth) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const calls = db.calls
    .filter(c => c.from === auth.user.number || c.to === auth.user.number)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 100)
    .map(c => Object.assign({}, c, { peer: publicUser(userByNumber(c.from === auth.user.number ? c.to : c.from)) }));
  return sendJSON(res, 200, { calls });
});

route('POST', '/api/calls', async (req, res, auth, body) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const to = normNumber(body.to);
  const peer = userByNumber(to);
  if (!peer) return sendJSON(res, 404, { error: 'Абонент не найден' });
  const call = {
    id: 'k' + crypto.randomBytes(8).toString('hex'),
    from: auth.user.number,
    to,
    video: !!body.video,
    ts: Date.now(),
    startedAt: null,
    duration: 0,
    status: 'ringing',
  };
  logCall(call);
  if (!hasConn(to)) {
    call.status = 'missed';
    saveDB();
    broadcastCall(call, 'call:ended');
    return sendJSON(res, 200, { call });
  }
  broadcastCall(call, 'call:incoming');
  const timer = setTimeout(() => {
    const live = db.calls.find(c => c.id === call.id);
    if (live && live.status === 'ringing') {
      live.status = 'missed';
      saveDB();
      ringingTimers.delete(call.id);
      broadcastCall(live, 'call:ended');
    }
  }, 30000);
  ringingTimers.set(call.id, timer);
  return sendJSON(res, 200, { call });
});

route('POST', '/api/calls/:id/accept', async (req, res, auth, _b, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const call = db.calls.find(c => c.id === params.id);
  if (!call || call.to !== auth.user.number) return sendJSON(res, 404, { error: 'no call' });
  if (call.status !== 'ringing') return sendJSON(res, 400, { error: 'call is not ringing' });
  clearTimeout(ringingTimers.get(call.id));
  ringingTimers.delete(call.id);
  call.status = 'active';
  call.startedAt = Date.now();
  saveDB();
  broadcastCall(call, 'call:accepted');
  return sendJSON(res, 200, { call });
});

route('POST', '/api/calls/:id/decline', async (req, res, auth, _b, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const call = db.calls.find(c => c.id === params.id);
  if (!call || call.to !== auth.user.number) return sendJSON(res, 404, { error: 'no call' });
  clearTimeout(ringingTimers.get(call.id));
  ringingTimers.delete(call.id);
  if (call.status === 'ringing') { call.status = 'rejected'; saveDB(); }
  broadcastCall(call, 'call:ended');
  return sendJSON(res, 200, { call });
});

route('POST', '/api/calls/:id/hangup', async (req, res, auth, _b, params) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  const call = db.calls.find(c => c.id === params.id);
  if (!call || !callPeers(call).includes(auth.user.number)) return sendJSON(res, 404, { error: 'no call' });
  clearTimeout(ringingTimers.get(call.id));
  ringingTimers.delete(call.id);
  if (call.status === 'ringing') call.status = 'cancelled';
  else if (call.status === 'active') {
    call.status = 'completed';
    call.duration = Math.max(0, Math.round((Date.now() - (call.startedAt || Date.now())) / 1000));
  }
  saveDB();
  broadcastCall(call, 'call:ended');
  return sendJSON(res, 200, { call });
});

/* --- SSE --- */

route('GET', '/api/events', async (req, res, auth) => {
  if (!auth) return sendJSON(res, 401, { error: 'unauthorized' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');
  addConn(auth.user.number, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    removeConn(auth.user.number, res);
  });
  return undefined; // keep open
});

/* ------------------------------------------------------- static + serve */

let indexHTML = null;
let spriteSVG = null;

function ensureIndex() {
  if (indexHTML !== null) return indexHTML;
  try {
    let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    if (!spriteSVG) {
      try { spriteSVG = fs.readFileSync(path.join(PUBLIC, 'sprite.svg'), 'utf8'); }
      catch (e) { spriteSVG = ''; }
    }
    if (html.includes('<!--SPRITE-->')) html = html.replace('<!--SPRITE-->', spriteSVG);
    indexHTML = html;
  } catch (e) {
    indexHTML = '<!DOCTYPE html><html><body>index missing</body></html>';
  }
  return indexHTML;
}

function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  if (p === '/index.html') {
    const html = ensureIndex();
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(html);
    return true;
  }
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return true; }
  let stat;
  try { stat = fs.statSync(file); } catch (e) { return false; }
  if (stat.isDirectory()) return false;
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveUploads(req, res, pathname) {
  if (!pathname.startsWith('/uploads/')) return false;
  const name = path.basename(pathname);
  const file = path.join(UPLOADS, name);
  try { fs.statSync(file); } catch (e) { res.writeHead(404); res.end(); return true; }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    const auth = authFrom(req, url);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      let body = {};
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
        try { body = await readJSON(req); }
        catch (e) { return sendJSON(res, 400, { error: 'bad request' }); }
      }
      try {
        const out = await r.handler(req, res, auth, body, params, url);
        if (out !== undefined && !res.writableEnded && !res.headersSent) sendJSON(res, 200, out);
      } catch (e) {
        const code = e.code && Number.isInteger(e.code) ? e.code : 500;
        if (!res.headersSent) sendJSON(res, code, { error: e.message || 'server error' });
        else console.error(e);
      }
      return;
    }
    return sendJSON(res, 404, { error: 'not found' });
  }

  if (serveUploads(req, res, pathname)) return;
  if (serveStatic(req, res, pathname)) return;
  // SPA fallback for unknown non-file paths
  if (!path.extname(pathname)) {
    const html = ensureIndex();
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('MAX demo server on http://0.0.0.0:' + PORT);
});
