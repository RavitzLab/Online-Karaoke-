import { Mesh } from './rtc.js';
import { SingerMixer } from './singer.js';
import { YouTubeSync, parseYouTubeId } from './yt.js';

const tg = window.Telegram?.WebApp;
const inTg = !!tg?.initData;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('connect.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('connect.' + k, JSON.stringify(v)); } catch {} },
};
const haptic = (kind = 'light') => { try { tg?.HapticFeedback?.impactOccurred(kind); } catch {} };

const S = {
  config: { iceServers: [] },
  ws: null, me: null, room: null, you: null, intent: null, leaving: false,
  clock: { offset: 0, bestRtt: Infinity },
  favorites: [],
  localFiles: new Map(),        // ref -> File (минусовки остаются на устройстве)
  micStream: null, camStream: null, mic: true, cam: false,
  mixTrack: null, singingId: null,
  autoMuted: null,              // { songId, restore }
  streams: new Map(), peerState: new Map(),
  latency: 0.25,
  reverb: store.get('reverb', 0.3),
  musicVolume: store.get('music', 0.8),
  monitor: store.get('monitor', false),
  headphones: store.get('headphones', true),
  shift: store.get('shift', 0),
  needsTap: false,
};
const serverNow = () => Date.now() + S.clock.offset;
const mixer = new SingerMixer();

// ---------- Утилиты интерфейса ----------
function show(screen) {
  for (const id of ['home', 'wait', 'room']) $('#screen-' + id).hidden = id !== screen;
}
let toastTimer;
function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}
function openSheet(id) {
  closeSheets();
  $('#' + id).hidden = false;
  tg?.BackButton?.show();
}
function closeSheets() {
  document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true));
  tg?.BackButton?.hide();
}
document.querySelectorAll('.sheet').forEach((sheet) => {
  sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close]')) closeSheets(); });
});
tg?.BackButton?.onClick(closeSheets);

function guestId() {
  let id = store.get('guestId', null);
  if (!id) { id = crypto.getRandomValues(new Uint8Array(12)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''); store.set('guestId', id); }
  return id;
}
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const member = (peerId) => S.room?.members.find((m) => m.peerId === peerId);
const isHost = () => S.room?.hostPeerId === S.me?.peerId;

// ---------- Сеть ----------
function send(msg) { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(msg)); }

const mesh = new Mesh({
  send: (to, data) => send({ type: 'signal', to, data }),
  iceServers: [],
  onStream: (id, stream) => {
    if (stream) S.streams.set(id, stream); else S.streams.delete(id);
    renderTiles();
    renderStage();
  },
  onPeerState: (id, st) => { S.peerState.set(id, st); renderTiles(); },
});

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    send({ type: 'hello', initData: tg?.initData || '', guestId: guestId(), name: store.get('name', '') });
    syncClock();
  };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = (e) => {
    if (S.ws !== ws || S.leaving) return;
    mesh.closeAll();
    if (e.code === 4000) { goHome('Комната открыта в другом окне'); return; }
    if (S.you?.status) toast('Связь пропала, переподключаемся…');
    setTimeout(() => { if (S.ws === ws && !S.leaving) connect(); }, 1500);
  };
}

function syncClock() {
  for (let i = 0; i < 5; i++) setTimeout(() => send({ type: 'ping', t: Date.now() }), i * 250);
}
setInterval(() => { S.clock.bestRtt *= 1.5; syncClock(); }, 30000);

function onMessage(msg) {
  switch (msg.type) {
    case 'pong': {
      const now = Date.now();
      const rtt = now - msg.t;
      if (rtt <= S.clock.bestRtt) { S.clock.bestRtt = rtt; S.clock.offset = msg.server + rtt / 2 - now; }
      break;
    }
    case 'welcome':
      S.me = msg;
      S.favorites = msg.favorites || [];
      if (S.room?.id) send({ type: 'join', roomId: S.room.id });
      else if (S.intent?.type === 'join') send({ type: 'join', roomId: S.intent.roomId });
      else send({ type: 'create' });
      break;
    case 'state': onState(msg.room, msg.you); break;
    case 'knock': haptic('medium'); toast(`${msg.name} просится в комнату`); break;
    case 'rejected': goHome('Хозяин не впустил в комнату'); break;
    case 'kicked': goHome('Вас удалили из комнаты'); break;
    case 'reaction': showReaction(msg.emoji, msg.name); break;
    case 'signal': mesh.handleSignal(msg.from, msg.data); break;
    case 'favorites': S.favorites = msg.favorites; renderFavs(); renderQueue(); break;
    case 'error':
      if (['no-room', 'full', 'auth'].includes(msg.code) && S.you?.status !== 'in') goHome(msg.text);
      else toast(msg.text);
      break;
  }
}

function onState(room, you) {
  const prev = S.room;
  S.room = room;
  S.you = you;
  if (you.status === 'pending') { show('wait'); return; }
  if (you.status !== 'in') return;
  show('room');
  if (!inTg && new URLSearchParams(location.search).get('room') !== room.id) history.replaceState(null, '', `?room=${room.id}`);
  mesh.sync(S.me.peerId, room.members.map((m) => m.peerId));
  if (prev?.current?.item.id !== room.current?.item.id) onSongChange(room.current);
  render();
  keepAwake();
}

// ---------- Свои микрофон и камера ----------
async function initMic() {
  try {
    S.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    S.mic = true;
  } catch {
    S.micStream = null;
    S.mic = false;
    toast('Без микрофона: вы будете слышать других, но не сможете петь');
  }
  applyTracks();
}

function applyTracks() {
  const micTrack = S.micStream?.getAudioTracks()[0] || null;
  if (micTrack) micTrack.enabled = S.mic;
  mixer.setVoiceMuted(!S.mic);
  mesh.setTracks({
    audio: S.singingId && S.mixTrack ? S.mixTrack : micTrack,
    video: S.cam ? S.camStream?.getVideoTracks()[0] || null : null,
  });
}
const sendMedia = () => send({ type: 'media', cam: S.cam, mic: S.mic });

async function setMic(on) {
  if (on && !S.micStream && !S.singingId) {
    await initMic();
    if (!S.micStream) return;
  }
  S.mic = on;
  applyTracks();
  sendMedia();
  renderDock();
}

async function setCam(on) {
  if (on === S.cam) return;
  if (on) {
    try {
      S.camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } });
    } catch { toast('Нет доступа к камере'); return; }
  } else {
    S.camStream?.getTracks().forEach((t) => t.stop());
    S.camStream = null;
  }
  S.cam = on;
  applyTracks();
  sendMedia();
  renderDock(); renderTiles(); renderStage();
}

// ---------- Песня ----------
const yt = new YouTubeSync($('#yt'), {
  onEnded: () => { if (S.singingId) endMySong(); },
  onError: (code) => {
    const text = code === 101 || code === 150 ? 'Автор запретил показывать это видео вне YouTube' : 'Видео не загрузилось';
    toast(text, 4000);
    if (S.singingId) endMySong();
  },
  onNeedsTap: (need) => { S.needsTap = need; renderTapButton(); },
});

function songTime(cur) {
  const t = (serverNow() - cur.startedAt) / 1000;
  return cur.singerPeerId === S.me.peerId ? t : t - S.latency + S.shift;
}

async function onSongChange(cur) {
  if (S.singingId && S.singingId !== cur?.item.id) await stopSinging();
  if (S.autoMuted && S.autoMuted.songId !== cur?.item.id) {
    if (S.autoMuted.restore && !S.mic) setMic(true);
    S.autoMuted = null;
  }
  if (!cur || cur.item.type !== 'youtube') { yt.stop(); $('#yt').hidden = true; S.needsTap = false; renderTapButton(); }
  if (!cur) return;

  const mine = cur.singerPeerId === S.me.peerId;
  if (mine) await startSinging(cur);
  else {
    S.autoMuted = { songId: cur.item.id, restore: S.mic };
    if (S.mic) { setMic(false); toast('Микрофон выключен на время песни — включите, чтобы подпевать'); }
  }
  if (cur.item.type === 'youtube') {
    $('#yt').hidden = false;
    yt.load(cur.item.videoId, () => songTime(cur)).then(() => yt.setVolume(S.musicVolume)).catch(() => toast('YouTube недоступен'));
  }
  haptic('medium');
}

async function startSinging(cur) {
  S.singingId = cur.item.id;
  const file = cur.item.type === 'file' ? S.localFiles.get(cur.item.ref) : null;
  if (cur.item.type === 'file' && !file) { toast('Файл минусовки не найден'); endMySong(); return; }
  try {
    S.mixTrack = await mixer.start({ headphones: S.headphones, reverb: S.reverb, monitor: S.monitor, file, musicVolume: S.musicVolume });
  } catch (e) {
    console.error(e);
    toast('Не удалось включить микрофон для пения');
    S.singingId = null;
    endMySong(cur.item.id);
    return;
  }
  if (S.singingId !== cur.item.id) { mixer.stop(); return; }
  if (!S.mic) { S.mic = true; sendMedia(); }
  applyTracks();
  renderDock();
  if (file) mixer.playAt(cur.startedAt - S.clock.offset, () => endMySong());
}

async function stopSinging() {
  S.singingId = null;
  S.mixTrack = null;
  await mixer.stop();
  applyTracks();
}

function endMySong(id = S.room?.current?.item.id) { send({ type: 'song:end', id }); }

let singItem = null;
function openSingSheet(item) {
  singItem = item;
  $('#sing-title').textContent = item.title;
  $('#sing-headphones').checked = S.headphones;
  $('#sing-cam').checked = S.cam;
  $('#sing-reverb').value = S.reverb;
  $('#sing-reverb-val').textContent = Math.round(S.reverb * 100) + '%';
  $('#sing-file').value = '';
  $('#sing-file-box').hidden = !(item.type === 'file' && !S.localFiles.has(item.ref));
  openSheet('sheet-sing');
}
$('#sing-reverb').oninput = (e) => { $('#sing-reverb-val').textContent = Math.round(e.target.value * 100) + '%'; };
$('#btn-sing-go').onclick = async () => {
  const item = singItem;
  if (!item) return;
  if (item.type === 'file' && !S.localFiles.has(item.ref)) {
    const f = $('#sing-file').files[0];
    if (!f) { toast('Выберите файл минусовки'); return; }
    S.localFiles.set(item.ref, f);
  }
  S.headphones = $('#sing-headphones').checked; store.set('headphones', S.headphones);
  S.reverb = Number($('#sing-reverb').value); store.set('reverb', S.reverb);
  // Внутри нажатия: разблокировать звук (iOS) и подготовить файл.
  await mixer.prepare(item.type === 'file' ? S.localFiles.get(item.ref) : null);
  yt.tapToPlay();
  await setCam($('#sing-cam').checked);
  closeSheets();
  send({ type: 'song:start', id: item.id });
};

// Подстройка YouTube у слушателей под задержку голоса исполнителя.
setInterval(async () => {
  const cur = S.room?.current;
  if (!cur || cur.item.type !== 'youtube' || cur.singerPeerId === S.me?.peerId) return;
  const l = await mesh.latencyTo(cur.singerPeerId);
  if (l != null) S.latency = Math.min(1.5, Math.max(0.05, S.latency * 0.7 + l * 0.3));
}, 3000);

// Обратный отсчёт и прогресс.
setInterval(() => {
  const cur = S.room?.current;
  const cd = $('#countdown');
  if (!cur || S.you?.status !== 'in') { cd.hidden = true; return; }
  const left = Math.ceil((cur.startedAt - serverNow()) / 1000);
  cd.hidden = left <= 0;
  if (left > 0) cd.textContent = left;
  let p = null;
  if (cur.item.type === 'youtube' && yt.duration) p = { t: yt.time, d: yt.duration };
  else if (S.singingId) p = mixer.progress;
  $('#progress').hidden = !p;
  if (p) $('#progress i').style.width = Math.min(100, (p.t / p.d) * 100) + '%';
}, 250);

// ---------- Отрисовка ----------
function render() {
  if (!S.room) return;
  const r = S.room;
  $('#room-code').textContent = `Комната ${r.id}`;
  $('#room-count').textContent = `${r.members.length} из ${r.maxMembers} · ${isHost() ? 'вы хозяин' : 'хозяин — ' + (member(r.hostPeerId)?.name || '—')}`;
  renderKnocks(); renderStage(); renderCta(); renderTiles(); renderQueue(); renderDock(); renderFavs();
  $('#host-tools').hidden = !isHost() || !r.current;
}

function renderKnocks() {
  const box = $('#knocks');
  if (!isHost()) { box.innerHTML = ''; return; }
  box.innerHTML = S.room.pending.map((p) => `
    <div class="knock">
      <div class="who"><b>${esc(p.name)}</b><div class="muted">просится в комнату</div></div>
      <button class="btn small primary" data-admit="${esc(p.peerId)}">Впустить</button>
      <button class="btn small ghost" data-reject="${esc(p.peerId)}">✕</button>
    </div>`).join('');
}
$('#knocks').addEventListener('click', (e) => {
  const a = e.target.closest('[data-admit]'), r = e.target.closest('[data-reject]');
  if (a) send({ type: 'admit', peerId: a.dataset.admit });
  if (r) send({ type: 'reject', peerId: r.dataset.reject });
});

function renderStage() {
  const r = S.room;
  if (!r) return;
  const cur = r.current;
  const stage = $('#stage'), video = $('#stage-video'), empty = $('#stage-empty'), info = $('#stage-info');
  if (!cur) {
    stage.classList.remove('with-yt', 'live');
    video.hidden = true; video.srcObject = null; info.hidden = true; empty.hidden = false;
    const next = r.queue[0];
    empty.innerHTML = next
      ? `<div class="big-emoji">🎶</div><b>Следующей звучит «${esc(next.title)}»</b><span>поёт ${esc(next.ownerUid === S.me.uid ? 'вы' : next.ownerName)}</span>`
      : `<div class="big-emoji">🎤</div><b>Сцена свободна</b><span>Добавьте песню — и вечер начнётся</span>`;
    return;
  }
  const mine = cur.singerPeerId === S.me.peerId;
  const singer = member(cur.singerPeerId);
  const isYT = cur.item.type === 'youtube';
  stage.classList.toggle('with-yt', isYT);
  stage.classList.add('live');
  const stream = mine ? S.camStream : S.streams.get(cur.singerPeerId);
  const camOn = mine ? S.cam : !!singer?.cam;
  if (camOn && stream) {
    if (video.srcObject !== stream) { video.srcObject = stream; video.play().catch(() => {}); }
    video.hidden = false;
  } else { video.hidden = true; }
  empty.hidden = isYT || (camOn && !!stream);
  if (!empty.hidden) empty.innerHTML = `<div class="big-emoji">🎤</div><span>${mine ? 'Включите камеру, чтобы вас видели' : 'Исполнитель без камеры — слушаем!'}</span>`;
  info.hidden = false;
  $('#now-title').textContent = cur.item.title;
  $('#now-singer').textContent = mine ? 'Вы поёте' : `Поёт ${singer?.name || cur.item.ownerName}`;
}

function renderTapButton() { $('#btn-tap-sound').hidden = !S.needsTap; }
$('#btn-tap-sound').onclick = () => {
  S.needsTap = false;
  renderTapButton();
  yt.tapToPlay();
  document.querySelectorAll('video').forEach((v) => v.play().catch(() => {}));
};

function renderCta() {
  const r = S.room, cta = $('#turn-cta');
  if (r.current) {
    if (r.current.singerPeerId === S.me.peerId) {
      cta.hidden = false;
      cta.innerHTML = `<button class="btn ghost" data-cta="end">Закончить песню</button>`;
    } else cta.hidden = true;
    return;
  }
  const first = r.queue[0];
  if (!first) { cta.hidden = true; return; }
  const inRoom = new Set(r.members.map((m) => m.uid));
  const mine = r.queue.find((q) => q.ownerUid === S.me.uid);
  cta.hidden = false;
  if (first.ownerUid === S.me.uid) {
    cta.innerHTML = `<button class="btn primary big" data-cta="sing" data-id="${esc(first.id)}">Ваша очередь — спеть 🎤</button>`;
  } else if (mine && (!inRoom.has(first.ownerUid) || isHost())) {
    cta.innerHTML = `<p class="note">Сейчас очередь: ${esc(first.ownerName)}</p><button class="btn ghost" data-cta="sing" data-id="${esc(mine.id)}">Спеть свою песню сейчас</button>`;
  } else {
    cta.innerHTML = `<p class="note">Сейчас очередь: ${esc(first.ownerName)}. Ждём, когда начнёт петь</p>`;
  }
}
$('#turn-cta').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cta]');
  if (!b) return;
  if (b.dataset.cta === 'end') endMySong();
  if (b.dataset.cta === 'sing') {
    const item = S.room.queue.find((q) => q.id === b.dataset.id);
    if (item) openSingSheet(item);
  }
});

const tileEls = new Map();
function renderTiles() {
  const box = $('#tiles');
  const members = S.room?.members || [];
  const ids = new Set(members.map((m) => m.peerId));
  for (const [id, el] of tileEls) if (!ids.has(id)) { el.remove(); tileEls.delete(id); }
  members.forEach((m, i) => {
    let el = tileEls.get(m.peerId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      el.innerHTML = `<div class="face"><span class="avatar"></span><video playsinline autoplay></video><div class="badges"></div><i class="conn"></i></div><div class="name"></div>`;
      tileEls.set(m.peerId, el);
    }
    const video = el.querySelector('video');
    if (box.children[i] !== el) {
      box.insertBefore(el, box.children[i] || null);
      if (video.srcObject) video.play().catch(() => {});
    }
    const me = m.peerId === S.me.peerId;
    const stream = me ? S.camStream : S.streams.get(m.peerId) || null;
    video.muted = me; // свой звук не воспроизводим, чужой играет через плитку
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      if (stream) video.play().catch(() => { S.needsTap = true; renderTapButton(); });
    }
    const camOn = me ? S.cam : m.cam;
    video.classList.toggle('off', !camOn);
    const avatar = el.querySelector('.avatar');
    const avatarKey = m.photo || initials(m.name);
    if (avatar.dataset.key !== avatarKey) {
      avatar.dataset.key = avatarKey;
      avatar.innerHTML = m.photo ? `<img src="${esc(m.photo)}" alt="" referrerpolicy="no-referrer" />` : esc(initials(m.name));
    }
    el.querySelector('.badges').innerHTML = (m.peerId === S.room.hostPeerId ? '<span>👑</span>' : '') + (m.mic ? '' : '<span>🔇</span>');
    const conn = el.querySelector('.conn');
    const st = S.peerState.get(m.peerId);
    conn.hidden = me;
    conn.className = 'conn' + (st === 'connected' ? ' ok' : st === 'failed' ? ' bad' : '');
    conn.title = st || 'подключение…';
    el.classList.toggle('singing', S.room.current?.singerPeerId === m.peerId);
    el.querySelector('.name').textContent = me ? 'Вы' : m.name;
  });
}

const isFav = (videoId) => S.favorites.some((f) => f.videoId === videoId);
function songRow(it, { num, actions }) {
  return `<li class="${it.ownerUid === S.me.uid ? 'mine' : ''}">
    ${num != null ? `<span class="num">${num}</span>` : ''}
    <div class="meta"><div class="t">${it.type === 'file' ? '🎧 ' : ''}${esc(it.title)}</div><div class="o">${esc(it.ownerUid === S.me.uid ? 'вы' : it.ownerName)}</div></div>
    ${actions}
  </li>`;
}
function favBtn(it) {
  return it.type === 'youtube' ? `<button class="icon-btn ${isFav(it.videoId) ? 'on' : ''}" data-fav="${esc(it.videoId)}" data-title="${esc(it.title)}" title="В любимые">★</button>` : '';
}
function renderQueue() {
  const r = S.room;
  if (!r) return;
  $('#queue').innerHTML = r.queue.length
    ? r.queue.map((it, i) => songRow(it, {
        num: i + 1,
        actions: favBtn(it) + (it.ownerUid === S.me.uid || isHost() ? `<button class="icon-btn" data-remove="${esc(it.id)}" title="Убрать">✕</button>` : ''),
      })).join('')
    : `<li class="queue-empty">Пока пусто. Нажмите «+ Песня».</li>`;
  const hist = [...r.history].reverse();
  $('#history-box').hidden = !hist.length;
  $('#history').innerHTML = hist.map((it) => songRow(it, {
    actions: favBtn(it) + (it.type === 'youtube' ? `<button class="icon-btn" data-again="${esc(it.videoId)}" data-title="${esc(it.title)}" title="Спеть снова">↺</button>` : ''),
  })).join('');
}
function onSongListClick(e) {
  const fav = e.target.closest('[data-fav]'), rm = e.target.closest('[data-remove]'), again = e.target.closest('[data-again]');
  if (fav) {
    const song = { type: 'youtube', videoId: fav.dataset.fav, title: fav.dataset.title };
    send({ type: isFav(song.videoId) ? 'fav:remove' : 'fav:add', song });
    haptic();
  }
  if (rm) send({ type: 'queue:remove', id: rm.dataset.remove });
  if (again) { send({ type: 'queue:add', song: { type: 'youtube', videoId: again.dataset.again, title: again.dataset.title } }); toast('Добавлено в очередь'); }
}
$('#queue').addEventListener('click', onSongListClick);
$('#history').addEventListener('click', onSongListClick);

function renderDock() {
  const mic = $('#btn-mic'), cam = $('#btn-cam');
  mic.classList.toggle('off', !S.mic);
  mic.querySelector('.ico').textContent = S.mic ? '🎙️' : '🔇';
  cam.classList.toggle('on', S.cam);
}
$('#btn-mic').onclick = () => setMic(!S.mic);
$('#btn-cam').onclick = () => setCam(!S.cam);

let lastReaction = 0;
$('#emoji-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-emoji]');
  if (!b || Date.now() - lastReaction < 200) return;
  lastReaction = Date.now();
  send({ type: 'reaction', emoji: b.dataset.emoji });
  haptic();
});
function showReaction(emoji, name) {
  const layer = $('#reactions-layer');
  const el = document.createElement('div');
  el.className = 'reaction';
  el.style.left = 8 + Math.random() * 78 + '%';
  el.innerHTML = `${esc(emoji)}<small>${esc(name)}</small>`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

// ---------- Добавление песен ----------
$('#btn-add').onclick = () => { renderFavs(); openSheet('sheet-add'); };
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-body').forEach((b) => (b.hidden = b.dataset.body !== tab.dataset.tab));
  };
});
$('#btn-yt-add').onclick = () => {
  const id = parseYouTubeId($('#yt-url').value);
  if (!id) { toast('Вставьте ссылку на видео YouTube'); return; }
  send({ type: 'queue:add', song: { type: 'youtube', videoId: id } });
  $('#yt-url').value = '';
  closeSheets();
  toast('Песня в очереди');
};
$('#btn-yt-search').onclick = () => {
  const q = $('#yt-url').value.trim();
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent((q && !parseYouTubeId(q) ? q + ' ' : '') + 'караоке');
  if (tg?.openLink) tg.openLink(url); else window.open(url, '_blank');
};
$('#file-input').onchange = (e) => {
  const f = e.target.files[0];
  if (f && !$('#file-title').value) $('#file-title').value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
};
$('#btn-file-add').onclick = () => {
  const f = $('#file-input').files[0];
  if (!f) { toast('Выберите файл'); return; }
  const ref = Math.random().toString(36).slice(2, 12);
  S.localFiles.set(ref, f);
  send({ type: 'queue:add', song: { type: 'file', title: $('#file-title').value.trim() || f.name, ref } });
  $('#file-input').value = ''; $('#file-title').value = '';
  closeSheets();
  toast('Песня в очереди');
};
function renderFavs() {
  $('#fav-list').innerHTML = S.favorites.length
    ? S.favorites.map((f) => `<li><div class="meta"><div class="t">${esc(f.title || f.videoId)}</div></div>
        <button class="icon-btn on" data-fav="${esc(f.videoId)}" data-title="${esc(f.title)}" title="Убрать из любимых">★</button>
        <button class="btn small" data-again="${esc(f.videoId)}" data-title="${esc(f.title)}">В очередь</button></li>`).join('')
    : `<li class="queue-empty">Нажимайте ★ у песен в очереди — они сохранятся здесь${inTg ? '' : ' (на этом устройстве)'} для следующих вечеров.</li>`;
}
$('#fav-list').addEventListener('click', (e) => {
  onSongListClick(e);
  if (e.target.closest('[data-again]')) closeSheets();
});

// ---------- Настройки ----------
$('#btn-settings').onclick = () => {
  $('#set-reverb').value = S.reverb; $('#set-reverb-val').textContent = Math.round(S.reverb * 100) + '%';
  $('#set-music').value = S.musicVolume;
  $('#set-monitor').checked = S.monitor;
  $('#set-shift').value = S.shift; $('#set-shift-val').textContent = (S.shift > 0 ? '+' : '') + S.shift.toFixed(2) + ' с';
  $('#host-tools').hidden = !isHost() || !S.room?.current;
  openSheet('sheet-settings');
};
$('#set-reverb').oninput = (e) => {
  S.reverb = Number(e.target.value); store.set('reverb', S.reverb);
  $('#set-reverb-val').textContent = Math.round(S.reverb * 100) + '%';
  mixer.setReverb(S.reverb);
};
$('#set-music').oninput = (e) => {
  S.musicVolume = Number(e.target.value); store.set('music', S.musicVolume);
  yt.setVolume(S.musicVolume); mixer.setMusicVolume(S.musicVolume);
};
$('#set-monitor').onchange = (e) => { S.monitor = e.target.checked; store.set('monitor', S.monitor); mixer.setMonitor(S.monitor && S.headphones); };
$('#set-shift').oninput = (e) => {
  S.shift = Number(e.target.value); store.set('shift', S.shift);
  $('#set-shift-val').textContent = (S.shift > 0 ? '+' : '') + S.shift.toFixed(2) + ' с';
};
$('#btn-end-song').onclick = () => { endMySong(); closeSheets(); };
$('#btn-leave').onclick = () => { closeSheets(); leave(); };

// ---------- Приглашение ----------
function inviteLink() {
  const { botUsername, appShortName } = S.config;
  return botUsername && appShortName
    ? `https://t.me/${botUsername}/${appShortName}?startapp=${S.room.id}`
    : `${location.origin}/?room=${S.room.id}`;
}
$('#btn-invite').onclick = async () => {
  const link = inviteLink();
  const text = 'Заходи на караоке! 🎤';
  if (inTg) { tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`); return; }
  if (navigator.share) { try { await navigator.share({ title: 'Connect', text, url: link }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована — отправьте её друзьям'); }
  catch { prompt('Ссылка на комнату:', link); }
};

// ---------- Вход и выход ----------
let wakeLock = null;
async function keepAwake() {
  if (wakeLock || !navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => (wakeLock = null); } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.you?.status === 'in') keepAwake(); });

function teardown() {
  S.leaving = true;
  try { S.ws?.close(); } catch {}
  S.ws = null;
  mesh.closeAll();
  yt.stop();
  stopSinging();
  S.micStream?.getTracks().forEach((t) => t.stop());
  S.camStream?.getTracks().forEach((t) => t.stop());
  S.micStream = S.camStream = null;
  S.cam = false;
  S.room = S.you = null;
  for (const el of tileEls.values()) el.remove();
  tileEls.clear();
  S.streams.clear();
}

function leave() {
  send({ type: 'leave' });
  teardown();
  if (!inTg) history.replaceState(null, '', '/');
  S.intent = { type: 'create' };
  setupHome();
  show('home');
}

function goHome(error) {
  teardown();
  setupHome();
  show('home');
  const el = $('#home-error');
  el.textContent = error || '';
  el.hidden = !error;
}
$('#btn-cancel-wait').onclick = leave;

function setupHome() {
  const btn = $('#btn-start');
  btn.disabled = false;
  if (S.intent?.type === 'join') {
    $('#home-lead').textContent = `Вас позвали в караоке-комнату ${S.intent.roomId}. Заходите — споём!`;
    btn.textContent = 'Войти в комнату';
  } else {
    $('#home-lead').textContent = 'Караоке-комната для друзей. Создайте комнату, отправьте ссылку в чат и пойте по очереди — где бы вы ни были.';
    btn.textContent = 'Создать комнату';
  }
  $('#name-field').hidden = inTg;
  $('#name-input').value = store.get('name', '');
  $('#home-error').hidden = true;
}

$('#btn-start').onclick = async () => {
  if (!inTg) {
    const name = $('#name-input').value.trim();
    if (!name) { $('#name-input').focus(); toast('Напишите имя, чтобы друзья вас узнали'); return; }
    store.set('name', name);
  }
  const btn = $('#btn-start');
  btn.disabled = true;
  btn.textContent = 'Подключаемся…';
  S.leaving = false;
  await initMic();
  connect();
};

async function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.disableVerticalSwipes?.(); tg.setHeaderColor?.('bg_color'); } catch {}
  }
  try { S.config = await fetch('/api/config').then((r) => r.json()); } catch {}
  mesh.iceServers = S.config.iceServers || [];
  const roomId = (tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('room') || '').toUpperCase();
  S.intent = /^[A-Z0-9]{4,10}$/.test(roomId) ? { type: 'join', roomId } : { type: 'create' };
  setupHome();
  show('home');
  if (!inTg && S.config.allowGuests === false) {
    $('#btn-start').disabled = true;
    $('#home-error').textContent = 'Откройте Connect по ссылке в Telegram';
    $('#home-error').hidden = false;
  }
}
init();
