// Connect — сервер караоке-комнат: статика, комнаты, очередь, сигналинг WebRTC.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
let BOT_USERNAME = process.env.BOT_USERNAME || '';
const APP_SHORT_NAME = process.env.APP_SHORT_NAME || '';
// Публичный HTTPS-адрес приложения. На Render подставляется автоматически.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const WEBHOOK_SECRET = BOT_TOKEN ? crypto.createHash('sha256').update('wh:' + BOT_TOKEN).digest('hex').slice(0, 48) : '';
const ALLOW_GUESTS = process.env.ALLOW_GUESTS !== '0';
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS || 6);
const MAX_PENDING = 10;
const ROOM_TTL_MS = 30 * 60 * 1000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ICE_SERVERS = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

// ---------- Профили и избранное ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = {}; }
let saveTimer = null;
function saveUsers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(USERS_FILE, JSON.stringify(users), () => {});
  }, 500);
}

// ---------- Проверка Telegram initData ----------
function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 24 * 3600) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

const publicId = (userKey) => crypto.createHash('sha256').update(userKey).digest('hex').slice(0, 12);
const rid = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);
function roomCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += abc[b % abc.length];
  return rooms.has(s) ? roomCode() : s;
}
const clip = (s, n) => String(s ?? '').slice(0, n);

// ---------- Комнаты ----------
/** room: { id, hostKey, members: Map<peerId, member>, admitted: Set<userKey>, queue, current, history, emptyTimer } */
const rooms = new Map();

function membersIn(room) { return [...room.members.values()].filter((m) => m.status === 'in'); }
function hostPeer(room) {
  const ins = membersIn(room).sort((a, b) => a.joinedAt - b.joinedAt);
  return ins.find((m) => m.userKey === room.hostKey) || ins[0] || null;
}
const pub = (m) => ({ peerId: m.peerId, uid: m.uid, name: m.name, photo: m.photo, cam: m.cam, mic: m.mic });

function snapshot(room) {
  const host = hostPeer(room);
  return {
    id: room.id,
    hostPeerId: host?.peerId || null,
    members: membersIn(room).sort((a, b) => a.joinedAt - b.joinedAt).map(pub),
    pending: [...room.members.values()].filter((m) => m.status === 'pending').map(pub),
    queue: room.queue,
    current: room.current,
    history: room.history.slice(-15),
    maxMembers: MAX_MEMBERS,
  };
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, filter = () => true) {
  for (const m of room.members.values()) if (filter(m)) send(m.ws, msg);
}
function pushState(room) {
  const snap = snapshot(room);
  for (const m of room.members.values()) send(m.ws, { type: 'state', room: snap, you: { peerId: m.peerId, status: m.status } });
}

// Справедливая очередь: каждый поёт по разу за круг, порядок внутри круга — по первому появлению.
function fairOrder(queue) {
  const byOwner = new Map();
  for (const it of queue) {
    if (!byOwner.has(it.ownerUid)) byOwner.set(it.ownerUid, []);
    byOwner.get(it.ownerUid).push(it);
  }
  const out = [];
  const lists = [...byOwner.values()];
  for (let round = 0; out.length < queue.length; round++) {
    for (const l of lists) if (l[round]) out.push(l[round]);
  }
  return out;
}

function leaveRoom(member) {
  const room = rooms.get(member.roomId);
  if (!room) return;
  room.members.delete(member.peerId);
  member.roomId = null;
  if (room.current && room.current.singerPeerId === member.peerId) {
    room.history.push({ ...room.current.item, endedAt: Date.now() });
    room.current = null;
  }
  if (room.members.size === 0) {
    room.emptyTimer = setTimeout(() => rooms.delete(room.id), ROOM_TTL_MS);
  }
  pushState(room);
}

function enterRoom(member, room) {
  clearTimeout(room.emptyTimer);
  member.roomId = room.id;
  member.joinedAt = Date.now();
  room.members.set(member.peerId, member);
}


// ---------- Telegram-бот ----------
async function tgApi(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

const ROOM_RE = /^[A-Z0-9]{4,10}$/;
function appLinkFor(roomId) {
  if (BOT_USERNAME && APP_SHORT_NAME) return `https://t.me/${BOT_USERNAME}/${APP_SHORT_NAME}` + (roomId ? `?startapp=${roomId}` : '');
  return null;
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text || !msg.text.startsWith('/start')) return;
  const payload = msg.text.split(/\s+/)[1]?.toUpperCase() || '';
  const roomId = ROOM_RE.test(payload) ? payload : '';
  const isPrivate = msg.chat.type === 'private';
  const webUrl = PUBLIC_URL + (roomId ? `/?room=${roomId}` : '/');
  // В группах кнопки web_app запрещены — там даём обычную ссылку на Mini App.
  const button = isPrivate
    ? { text: roomId ? '🎤 Войти в комнату' : '🎤 Создать комнату', web_app: { url: webUrl } }
    : { text: '🎤 Открыть Connect', url: appLinkFor(roomId) || `https://t.me/${BOT_USERNAME}?start=${roomId}` };
  const text = roomId
    ? `Вас зовут на караоке в комнату ${roomId}! Нажмите кнопку — и хозяин впустит вас.`
    : 'Connect — караоке с друзьями прямо в Telegram.\n\nСоздайте комнату, нажмите «Позвать друзей» и отправьте ссылку в чат. Каждый добавляет песню в очередь — и поём по очереди 🎶';
  await tgApi('sendMessage', { chat_id: msg.chat.id, text, reply_markup: { inline_keyboard: [[button]] } });
}

async function setupBot() {
  if (!BOT_TOKEN) return;
  try {
    const me = await tgApi('getMe');
    if (!BOT_USERNAME) BOT_USERNAME = me.username;
    console.log(`Бот @${me.username} подключён`);
    if (!PUBLIC_URL) { console.log('PUBLIC_URL не задан — webhook и кнопка меню не настроены'); return; }
    if (!PUBLIC_URL.startsWith('https://')) { console.log('PUBLIC_URL должен начинаться с https:// — Telegram не откроет http'); return; }
    await tgApi('setWebhook', { url: `${PUBLIC_URL}/tg/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true });
    await tgApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Караоке', web_app: { url: PUBLIC_URL + '/' } } });
    await tgApi('setMyCommands', { commands: [{ command: 'start', description: 'Открыть караоке-комнату' }] });
    await tgApi('setMyDescription', { description: 'Караоке-комната для друзей: видео, общая очередь песен и живые реакции. Создайте комнату и отправьте ссылку в чат.' }).catch(() => {});
    console.log(`Webhook, кнопка меню и команды настроены на ${PUBLIC_URL}`);
  } catch (e) {
    console.error('Не удалось настроить бота:', e.message);
  }
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const titleCache = new Map();
async function youtubeTitle(videoId) {
  if (titleCache.has(videoId)) return titleCache.get(videoId);
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    const t = clip(j.title, 140);
    titleCache.set(videoId, t);
    return t;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: ICE_SERVERS, botUsername: BOT_USERNAME, appShortName: APP_SHORT_NAME, allowGuests: ALLOW_GUESTS, maxMembers: MAX_MEMBERS }));
  }
  if (url.pathname === '/api/yt-title') {
    const v = url.searchParams.get('v') || '';
    const title = /^[\w-]{11}$/.test(v) ? await youtubeTitle(v) : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ title }));
  }
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/tg/webhook' && req.method === 'POST') {
    if (!BOT_TOKEN || req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) { res.writeHead(403); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200); res.end('ok');
      try { handleUpdate(JSON.parse(body)).catch((e) => console.error('bot:', e.message)); } catch {}
    });
    return;
  }

  let p = decodeURIComponent(url.pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  const member = { peerId: rid(10), ws, userKey: null, uid: null, name: '', photo: '', roomId: null, status: null, cam: false, mic: true, joinedAt: 0 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const err = (code, text) => send(ws, { type: 'error', code, text });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const room = member.roomId ? rooms.get(member.roomId) : null;
    const isIn = room && member.status === 'in';
    const isHost = isIn && hostPeer(room)?.peerId === member.peerId;

    switch (msg.type) {
      case 'ping':
        return send(ws, { type: 'pong', t: msg.t, server: Date.now() });

      case 'hello': {
        const tgUser = verifyInitData(msg.initData);
        if (tgUser) {
          member.userKey = 'tg:' + tgUser.id;
          member.name = clip([tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUser.username || 'Гость', 40);
          member.photo = clip(tgUser.photo_url, 500);
        } else if (ALLOW_GUESTS) {
          const gid = /^[\w-]{8,40}$/.test(msg.guestId || '') ? msg.guestId : rid(16);
          member.userKey = 'guest:' + gid;
          member.name = clip(String(msg.name || '').trim(), 40) || 'Гость';
        } else {
          return err('auth', 'Откройте Connect через Telegram');
        }
        member.uid = publicId(member.userKey);
        const profile = users[member.userKey] || (users[member.userKey] = { favorites: [] });
        profile.name = member.name;
        profile.lastSeen = Date.now();
        saveUsers();
        return send(ws, {
          type: 'welcome', peerId: member.peerId, uid: member.uid, name: member.name, photo: member.photo,
          telegram: !!tgUser, favorites: profile.favorites, server: Date.now(),
        });
      }

      case 'create': {
        if (!member.userKey) return err('hello', 'Нет приветствия');
        if (member.roomId) leaveRoom(member);
        const r = { id: roomCode(), hostKey: member.userKey, members: new Map(), admitted: new Set([member.userKey]), queue: [], current: null, history: [], createdAt: Date.now() };
        rooms.set(r.id, r);
        member.status = 'in';
        enterRoom(member, r);
        return pushState(r);
      }

      case 'join': {
        if (!member.userKey) return err('hello', 'Нет приветствия');
        const r = rooms.get(String(msg.roomId || '').toUpperCase());
        if (!r) return err('no-room', 'Комната не найдена — возможно, вечер уже закончился');
        if (member.roomId) leaveRoom(member);
        // Тот же человек с другой вкладки/после перезагрузки — убираем старое подключение.
        for (const m of r.members.values()) {
          if (m.userKey === member.userKey) { m.ws.close(4000, 'replaced'); leaveRoom(m); }
        }
        const admitted = r.admitted.has(member.userKey);
        if (admitted && membersIn(r).length >= MAX_MEMBERS) return err('full', `В комнате уже ${MAX_MEMBERS} человек`);
        if (!admitted) {
          if (membersIn(r).length >= MAX_MEMBERS) return err('full', `В комнате уже ${MAX_MEMBERS} человек`);
          if ([...r.members.values()].filter((m) => m.status === 'pending').length >= MAX_PENDING) return err('full', 'Слишком много запросов, попробуйте позже');
        }
        member.status = admitted ? 'in' : 'pending';
        enterRoom(member, r);
        if (!admitted) broadcast(r, { type: 'knock', peerId: member.peerId, name: member.name }, (m) => m.peerId === hostPeer(r)?.peerId);
        return pushState(r);
      }

      case 'admit':
      case 'reject': {
        if (!isHost) return;
        const target = room.members.get(msg.peerId);
        if (!target || target.status !== 'pending') return;
        if (msg.type === 'admit') {
          if (membersIn(room).length >= MAX_MEMBERS) return err('full', 'Комната заполнена');
          target.status = 'in';
          target.joinedAt = Date.now();
          room.admitted.add(target.userKey);
        } else {
          send(target.ws, { type: 'rejected' });
          room.members.delete(target.peerId);
          target.roomId = null;
          target.status = null;
        }
        return pushState(room);
      }

      case 'kick': {
        if (!isHost || msg.peerId === member.peerId) return;
        const target = room.members.get(msg.peerId);
        if (!target) return;
        room.admitted.delete(target.userKey);
        send(target.ws, { type: 'kicked' });
        leaveRoom(target);
        return;
      }

      case 'leave':
        if (room) leaveRoom(member);
        member.status = null;
        return;

      case 'media':
        if (!isIn) return;
        member.cam = !!msg.cam;
        member.mic = !!msg.mic;
        return pushState(room);

      case 'queue:add': {
        if (!isIn) return;
        if (room.queue.length >= 60) return err('queue', 'Очередь переполнена');
        if (room.queue.filter((q) => q.ownerUid === member.uid).length >= 10) return err('queue', 'Не больше 10 песен от одного человека');
        const type = msg.song?.type === 'file' ? 'file' : 'youtube';
        const item = { id: rid(8), type, ownerUid: member.uid, ownerName: member.name, title: clip(msg.song?.title, 140) || 'Без названия', addedAt: Date.now() };
        // ref — локальная метка клиента, чтобы связать песню с файлом на его устройстве.
        if (type === 'file') item.ref = clip(msg.song?.ref, 24);
        if (type === 'youtube') {
          if (!/^[\w-]{11}$/.test(msg.song?.videoId || '')) return err('queue', 'Не похоже на ссылку YouTube');
          item.videoId = msg.song.videoId;
          if (!msg.song.title) item.title = (await youtubeTitle(item.videoId)) || 'Видео с YouTube';
        }
        room.queue = fairOrder([...room.queue, item]);
        return pushState(room);
      }

      case 'queue:remove': {
        if (!isIn) return;
        const it = room.queue.find((q) => q.id === msg.id);
        if (!it || (it.ownerUid !== member.uid && !isHost)) return;
        room.queue = fairOrder(room.queue.filter((q) => q.id !== msg.id));
        return pushState(room);
      }

      case 'song:start': {
        if (!isIn || room.current) return;
        const it = room.queue.find((q) => q.id === msg.id) || room.queue[0];
        if (!it || it.ownerUid !== member.uid) return err('turn', 'Сейчас не ваша очередь');
        if (it !== room.queue[0] && !isHost) {
          const ownersInRoom = new Set(membersIn(room).map((m) => m.uid));
          // Можно начать не первую песню, только если владелец первой вышел.
          if (ownersInRoom.has(room.queue[0].ownerUid)) return err('turn', 'Сейчас не ваша очередь');
        }
        room.queue = room.queue.filter((q) => q.id !== it.id);
        room.current = { item: it, singerPeerId: member.peerId, singerUid: member.uid, startedAt: Date.now() + 4000 };
        return pushState(room);
      }

      case 'song:end': {
        if (!isIn || !room.current) return;
        if (room.current.singerPeerId !== member.peerId && !isHost) return;
        if (msg.id && msg.id !== room.current.item.id) return;
        room.history.push({ ...room.current.item, endedAt: Date.now() });
        room.current = null;
        return pushState(room);
      }

      case 'reaction': {
        if (!isIn) return;
        const emoji = ['👏', '🔥', '😍', '😂', '🎤', '💜'].includes(msg.emoji) ? msg.emoji : '👏';
        return broadcast(room, { type: 'reaction', emoji, from: member.peerId, name: member.name }, (m) => m.status === 'in');
      }

      case 'signal': {
        if (!isIn) return;
        const target = room.members.get(msg.to);
        if (!target || target.status !== 'in') return;
        return send(target.ws, { type: 'signal', from: member.peerId, data: msg.data });
      }

      case 'fav:add':
      case 'fav:remove': {
        if (!member.userKey) return;
        const profile = users[member.userKey];
        const s = msg.song || {};
        if (s.type !== 'youtube' || !/^[\w-]{11}$/.test(s.videoId || '')) return;
        profile.favorites = profile.favorites.filter((f) => f.videoId !== s.videoId);
        if (msg.type === 'fav:add') profile.favorites.unshift({ type: 'youtube', videoId: s.videoId, title: clip(s.title, 140) });
        profile.favorites = profile.favorites.slice(0, 100);
        saveUsers();
        return send(ws, { type: 'favorites', favorites: profile.favorites });
      }
    }
  });

  ws.on('close', () => { if (member.roomId) leaveRoom(member); });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`Connect запущен: http://localhost:${PORT}`);
  if (!BOT_TOKEN) console.log('BOT_TOKEN не задан — вход через Telegram не проверяется, все заходят как гости.');
  setupBot();
});
