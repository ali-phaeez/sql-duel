/* SQL Duel client. Plain JS module, no build step for this file. Talks to the room's Durable Object over one WebSocket.
   The live preview runs the same SQL engine as the server: /engine/ is emitted from src/sql by `npm run build`. */
import { runQuery, SqlError } from '/engine/index.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const store = {
  get(key) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? null : JSON.parse(v);
    } catch (_) {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* private mode: fine, we just won't remember */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch (_) {
      /* ignore */
    }
  },
};

const ROUND_MS = 90_000;
const PREVIEW_DELAY_MS = 200;
const PREVIEW_MAX_ROWS = 50;

const S = {
  screen: null,
  me: null, // { id, secret }
  code: null,
  room: null, // latest snapshot
  ws: null,
  offset: 0, // serverNow - Date.now()
  samples: [],
  reconnectAttempt: 0,
  reconnectTimer: 0,
  pingTimer: 0,
  lastPong: 0,
  kicked: false,
  lastError: null,
  roundKey: null, // "index:puzzleId" of the round currently drawn
  previewTimer: 0,
  submitting: false,
  tick: 0,
};

const serverTime = () => Date.now() + S.offset;
const isHost = () => !!(S.room && S.me && S.room.hostId === S.me.id);
const playerName = (id) => (S.room && S.room.players.find((p) => p.id === id)?.name) || 'Someone';
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtSecs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- elements ----
const el = {
  screens: { home: $('#screen-home'), lobby: $('#screen-lobby'), round: $('#screen-round'), results: $('#screen-results'), final: $('#screen-final') },
  name: $('#name'), code: $('#code'), create: $('#create'), join: $('#join'), homeError: $('#home-error'),
  roomCode: $('#room-code'), share: $('#share'), players: $('#players'), playerCount: $('#player-count'),
  hostControls: $('#host-controls'), start: $('#start'), startHint: $('#start-hint'),
  waiting: $('#waiting'), hostName: $('#host-name'), settingsSummary: $('#settings-summary'), leave: $('#leave'),
  roundLabel: $('#round-label'), roundDifficulty: $('#round-difficulty'), timer: $('#timer'), barFill: $('#bar-fill'),
  story: $('#story'), target: $('#target'), orderedTag: $('#ordered-tag'), tables: $('#tables'),
  editor: $('#editor'), submit: $('#submit'), verdict: $('#verdict'), preview: $('#preview'), previewMeta: $('#preview-meta'),
  solved: $('#solved'), scores: $('#scores'),
  resultsLabel: $('#results-label'), nextIn: $('#next-in'), resultsStory: $('#results-story'), results: $('#results'),
  next: $('#next'), resultsScores: $('#results-scores'),
  leaderboard: $('#leaderboard'), playAgain: $('#play-again'), finalWaiting: $('#final-waiting'), finalResults: $('#final-results'),
  leaveFinal: $('#leave-final'),
  overlay: $('#overlay'), overlayCard: $('#overlay-card'), reconnecting: $('#reconnecting'), help: $('#help'), toast: $('#toast'),
};

// ---- screens & small UI ----
function showScreen(name) {
  if (S.screen === name) return;
  S.screen = name;
  for (const [key, node] of Object.entries(el.screens)) node.hidden = key !== name;
  window.scrollTo(0, 0);
}
function showHome(message) {
  showScreen('home');
  hideOverlay();
  el.reconnecting.hidden = true;
  setBusy(false);
  if (message) {
    el.homeError.textContent = message;
    el.homeError.hidden = false;
  } else el.homeError.hidden = true;
}
function setBusy(busy) {
  el.create.disabled = busy;
  el.join.disabled = busy;
}
function showOverlay(html) {
  el.overlayCard.innerHTML = html;
  el.overlay.hidden = false;
}
function hideOverlay() {
  el.overlay.hidden = true;
}
let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}
function clearSession() {
  store.del('sd.session');
  S.me = null;
  S.code = null;
  S.room = null;
  S.roundKey = null;
}

// ---- tables ----
function tableHtml(t, caption) {
  const numeric = t.columns.map((_, i) => t.rows.length > 0 && t.rows.every((r) => r[i] === null || typeof r[i] === 'number'));
  const head = t.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('');
  const body = t.rows
    .map((r) => '<tr>' + r.map((v, i) => {
      if (v === null) return '<td class="null">NULL</td>';
      return `<td${numeric[i] ? ' class="num"' : ''}>${esc(v)}</td>`;
    }).join('') + '</tr>')
    .join('');
  const cap = caption ? `<caption>${esc(caption)}</caption>` : '';
  return `<table class="data">${cap}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---- connection ----
function connect({ code, name, resume }) {
  if (S.ws) {
    const old = S.ws;
    S.ws = null;
    try { old.close(); } catch (_) { /* ignore */ }
  }
  S.kicked = false;
  S.lastError = null;
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (resume) { params.set('pid', resume.pid); params.set('secret', resume.secret); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/${code}?${params.toString()}`);
  S.ws = ws;
  S.code = code;
  ws.addEventListener('open', () => {
    if (S.ws !== ws) return;
    S.reconnectAttempt = 0;
    el.reconnecting.hidden = true;
    startPing();
  });
  ws.addEventListener('message', (e) => {
    if (S.ws !== ws) return;
    let m;
    try { m = JSON.parse(e.data); } catch (_) { return; }
    handle(m);
  });
  ws.addEventListener('close', (e) => {
    if (S.ws !== ws) return;
    S.ws = null;
    onClosed(e);
  });
}

function onClosed(e) {
  stopPing();
  if (e.code === 4001 || S.kicked) { S.kicked = false; showKicked(); return; }
  if (e.code === 4002 || e.code === 4003 || e.code === 4004) {
    clearSession();
    showHome(S.lastError || 'Could not join that room.');
    return;
  }
  const sess = store.get('sd.session');
  if (sess && sess.code && S.code === sess.code) scheduleReconnect();
  else showHome('Connection lost.');
}

function scheduleReconnect() {
  el.reconnecting.hidden = false;
  clearTimeout(S.reconnectTimer);
  const delay = Math.min(5000, 500 * Math.pow(2, S.reconnectAttempt));
  S.reconnectAttempt++;
  S.reconnectTimer = setTimeout(reconnectNow, delay);
}

async function reconnectNow() {
  clearTimeout(S.reconnectTimer);
  const sess = store.get('sd.session');
  if (!sess || !sess.code) { el.reconnecting.hidden = true; showHome(); return; }
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
  const info = await probe(sess.code);
  if (info === null) { clearSession(); showHome('That room has closed.'); return; }
  if (info === undefined) { scheduleReconnect(); return; }
  connect({ code: sess.code, resume: { pid: sess.pid, secret: sess.secret } });
}

/** object when the room exists, null when it does not, undefined on a network error. */
async function probe(code) {
  try {
    const r = await fetch(`/api/rooms/${code}`, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) return undefined;
    return await r.json();
  } catch (_) {
    return undefined;
  }
}

function send(msg) {
  if (S.ws && S.ws.readyState === 1) {
    try { S.ws.send(JSON.stringify(msg)); return true; } catch (_) { /* ignore */ }
  }
  return false;
}

function startPing() {
  stopPing();
  S.lastPong = Date.now();
  sendPing();
  S.pingTimer = setInterval(() => {
    if (!S.ws || S.ws.readyState !== 1) return;
    if (Date.now() - S.lastPong > 15000) {
      try { S.ws.close(4999, 'stale'); } catch (_) { /* ignore */ }
      return;
    }
    sendPing();
  }, 5000);
}
function stopPing() { clearInterval(S.pingTimer); S.pingTimer = 0; }
function sendPing() { send({ type: 'ping', t: Date.now() }); }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (S.ws && S.ws.readyState === 1) { sendPing(); return; }
  if (store.get('sd.session') && !S.kicked && el.overlay.hidden) reconnectNow();
});
window.addEventListener('online', () => {
  if (!(S.ws && S.ws.readyState === 1) && store.get('sd.session') && el.overlay.hidden) reconnectNow();
});

// ---- messages ----
function handle(m) {
  if (typeof m.serverNow === 'number' && S.samples.length === 0) S.offset = m.serverNow - Date.now();
  switch (m.type) {
    case 'welcome':
      S.me = { id: m.playerId, secret: m.secret };
      store.set('sd.session', { code: m.state.code, pid: m.playerId, secret: m.secret });
      if (location.search) history.replaceState(null, '', '/');
      applyState(m.state);
      break;
    case 'state':
      applyState(m.state);
      break;
    case 'verdict':
      onVerdict(m);
      break;
    case 'pong': {
      const now = Date.now();
      S.lastPong = now;
      const rtt = Math.max(0, now - m.t);
      S.samples.push({ rtt, sample: m.serverNow + rtt / 2 - now });
      if (S.samples.length > 5) S.samples.shift();
      S.offset = S.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).sample;
      break;
    }
    case 'error':
      onError(m);
      break;
    default:
      break;
  }
}

function onError(m) {
  S.lastError = m.message;
  switch (m.code) {
    case 'kicked_duplicate': S.kicked = true; break;
    case 'too_fast':
    case 'bad_message':
      S.submitting = false;
      setVerdict(m.message, 'wait');
      updateSubmit();
      break;
    case 'not_host':
    case 'not_allowed':
      S.submitting = false;
      updateSubmit();
      toast(m.message);
      break;
    default: break; // room_full / bad_name / not_found are followed by a close with a matching code
  }
}

function applyState(state) {
  S.room = state;
  S.code = state.code;
  switch (state.phase) {
    case 'lobby':
      S.roundKey = null;
      showScreen('lobby');
      renderLobby();
      break;
    case 'round':
      showScreen('round');
      renderRound();
      break;
    case 'round_end':
      showScreen('results');
      renderResults();
      break;
    case 'game_end':
      showScreen('final');
      renderFinal();
      break;
  }
}

// ---- lobby ----
function renderLobby() {
  const r = S.room;
  el.roomCode.textContent = r.code;
  el.playerCount.textContent = `(${r.players.length}/8)`;
  el.players.innerHTML = r.players
    .map((p) => {
      const badges = [
        p.id === r.hostId ? '<span class="badge host">Host</span>' : '',
        S.me && p.id === S.me.id ? '<span class="badge you">You</span>' : '',
        p.connected ? '' : '<span class="badge">Offline</span>',
      ].join('');
      return `<li class="player-row${p.connected ? '' : ' offline'}" data-testid="player-row"><span class="name">${esc(p.name)}</span>${badges}</li>`;
    })
    .join('');
  const host = isHost();
  el.hostControls.hidden = !host;
  el.waiting.hidden = host;
  el.hostName.textContent = playerName(r.hostId);
  el.settingsSummary.textContent = `${r.settings.rounds} rounds, ${r.settings.difficulty}`;
  for (const b of $$('[data-rounds]')) b.setAttribute('aria-pressed', String(Number(b.dataset.rounds) === r.settings.rounds));
  for (const b of $$('[data-difficulty]')) b.setAttribute('aria-pressed', String(b.dataset.difficulty === r.settings.difficulty));
  const online = r.players.filter((p) => p.connected).length;
  el.start.disabled = online < 2;
  el.startHint.hidden = online >= 2;
}

// ---- round ----
function draftKey() {
  const r = S.room && S.room.round;
  return r ? `sd.draft.${S.room.code}.${r.index}.${r.puzzle.id}` : null;
}

function renderRound() {
  const r = S.room;
  const round = r.round;
  if (!round) return;
  const key = `${round.index}:${round.puzzle.id}`;
  if (S.roundKey !== key) {
    S.roundKey = key;
    const pz = round.puzzle;
    el.screens.round.dataset.puzzleId = pz.id;
    el.roundLabel.textContent = `Round ${round.index + 1} of ${round.total}`;
    el.roundDifficulty.textContent = pz.difficulty;
    el.roundDifficulty.className = `tag ${pz.difficulty}`;
    el.story.textContent = pz.story;
    el.orderedTag.hidden = !pz.ordered;
    el.target.innerHTML = tableHtml(pz.target);
    el.tables.innerHTML = pz.tables
      .map((t) => `<div class="table-wrap" data-testid="source-table" data-table="${esc(t.name)}">${tableHtml(t, t.name)}</div>`)
      .join('');
    const own = r.me && r.me.query;
    el.editor.value = own || store.get(draftKey()) || '';
    setVerdict('', '');
    S.submitting = false;
    runPreview();
  }
  const me = r.me || { solved: false, wrong: 0, points: 0 };
  el.editor.readOnly = me.solved;
  if (me.solved) setVerdict(`Correct! +${me.points}`, 'ok');
  updateSubmit();
  el.solved.innerHTML = round.solved.length
    ? round.solved
        .map((s, i) => `<li data-testid="solved-item">${i + 1}. ${esc(playerName(s.playerId))} <span class="muted">${fmtSecs(s.ms)} · +${s.points}</span></li>`)
        .join('')
    : '<li class="none">Nobody yet.</li>';
  renderScores(el.scores);
  updateTimers();
}

function updateSubmit() {
  const solved = !!(S.room && S.room.me && S.room.me.solved);
  el.submit.disabled = solved || S.submitting || !el.editor.value.trim();
  el.submit.textContent = solved ? 'Solved' : S.submitting ? 'Checking…' : 'Submit';
}

function setVerdict(text, kind) {
  el.verdict.textContent = text;
  el.verdict.className = `verdict${kind ? ' ' + kind : ''}`;
}

function renderScores(node) {
  const players = S.room.players.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  node.innerHTML = players
    .map((p) => `<span class="score-chip${p.connected ? '' : ' offline'}">${esc(p.name)} <b data-testid="score-${esc(p.name)}">${p.score}</b></span>`)
    .join('');
}

function submitQuery() {
  const r = S.room;
  if (!r || r.phase !== 'round' || !r.round || (r.me && r.me.solved) || S.submitting) return;
  const query = el.editor.value;
  if (!query.trim()) return;
  if (!send({ type: 'submit', query, round: r.round.index })) {
    setVerdict('Not connected. Trying again…', 'wait');
    return;
  }
  S.submitting = true;
  setVerdict('Checking…', '');
  updateSubmit();
}

function onVerdict(v) {
  S.submitting = false;
  if (!S.room || !S.room.round || v.round !== S.room.round.index) return;
  if (v.ok) {
    if (S.room.me) { S.room.me.solved = true; S.room.me.points = v.points; S.room.me.wrong = v.wrong; }
    el.editor.readOnly = true;
    setVerdict(`Correct! +${v.points}`, 'ok');
  } else {
    if (S.room.me) S.room.me.wrong = v.wrong;
    setVerdict(`Not yet (${plural(v.wrong, 'wrong try')}): ${v.reason}`, 'bad');
  }
  updateSubmit();
}

// ---- live preview ----
function runPreview() {
  clearTimeout(S.previewTimer);
  const round = S.room && S.room.round;
  if (!round) return;
  const query = el.editor.value;
  if (!query.trim()) {
    el.preview.innerHTML = '<p class="empty">Your result appears here as you type.</p>';
    el.previewMeta.textContent = '';
    return;
  }
  try {
    const result = runQuery(query, round.puzzle.tables);
    const shown = { columns: result.columns, rows: result.rows.slice(0, PREVIEW_MAX_ROWS) };
    el.preview.innerHTML = tableHtml(shown);
    el.previewMeta.textContent = `${plural(result.rows.length, 'row')}${result.rows.length > PREVIEW_MAX_ROWS ? ` (first ${PREVIEW_MAX_ROWS} shown)` : ''}`;
    el.preview.dataset.state = 'result';
  } catch (e) {
    const msg = e instanceof SqlError ? e.message : `Unexpected error: ${e && e.message}`;
    el.preview.innerHTML = `<p class="sql-error" data-testid="preview-error">${esc(msg)}</p>`;
    el.previewMeta.textContent = 'error';
    el.preview.dataset.state = 'error';
  }
}

el.editor.addEventListener('input', () => {
  const key = draftKey();
  if (key) store.set(key, el.editor.value);
  updateSubmit();
  clearTimeout(S.previewTimer);
  S.previewTimer = setTimeout(runPreview, PREVIEW_DELAY_MS);
});
el.editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runPreview();
    submitQuery();
  }
});
el.submit.addEventListener('click', () => {
  runPreview();
  submitQuery();
});

// ---- round end ----
function resultsHtml(rows) {
  return rows
    .map((x) => {
      const status = x.solved ? `<span class="ok">✓ ${fmtSecs(x.ms)}</span>` : '<span class="miss">✗ not solved</span>';
      const wrong = x.wrong ? `<span class="muted">${plural(x.wrong, 'wrong try')}</span>` : '';
      const bonus = x.bonus ? ' <span class="muted">(+1 shortest)</span>' : '';
      const pts = x.points + x.bonus;
      const query = x.solved ? `<pre><code>${esc(x.query)}</code></pre>` : '';
      return `<div class="result-row" data-testid="result-row" data-player="${esc(x.name)}">
        <div class="top"><span class="who">${esc(x.name)}</span>${status}${wrong}<span class="pts" data-testid="result-points">+${pts}${bonus}</span></div>${query}</div>`;
    })
    .join('');
}

function renderResults() {
  const r = S.room;
  const round = r.round;
  el.resultsLabel.textContent = round ? `Round ${round.index + 1} of ${round.total} · answers` : 'Answers';
  el.resultsStory.textContent = round ? round.puzzle.story : '';
  el.results.innerHTML = resultsHtml(r.results || []);
  el.next.hidden = !isHost();
  if (round) el.next.textContent = round.index + 1 >= round.total ? 'Final standings' : 'Next round';
  renderScores(el.resultsScores);
  updateTimers();
}

// ---- game end ----
function renderFinal() {
  const r = S.room;
  el.leaderboard.innerHTML = (r.ranking || [])
    .map((x) => `<li class="${x.rank === 1 ? 'first' : ''}" data-testid="leaderboard-row"><span class="rank">${x.rank}.</span><span class="name">${esc(x.name)}</span><span class="score" data-testid="final-score-${esc(x.name)}">${x.score}</span></li>`)
    .join('');
  el.playAgain.hidden = !isHost();
  el.finalWaiting.hidden = isHost();
  el.finalWaiting.textContent = `Waiting for ${playerName(r.hostId)} to start another game…`;
  el.finalResults.innerHTML = resultsHtml(r.results || []);
}

// ---- timers ----
function updateTimers() {
  const r = S.room;
  if (!r) return;
  const now = serverTime();
  if (r.phase === 'round' && r.round && r.round.endsAt) {
    const left = Math.max(0, r.round.endsAt - now);
    const secs = Math.ceil(left / 1000);
    el.timer.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    el.timer.classList.toggle('low', secs <= 10);
    el.barFill.style.width = `${Math.min(100, (left / ROUND_MS) * 100)}%`;
  } else if (r.phase === 'round_end' && r.nextAt) {
    const secs = Math.max(0, Math.ceil((r.nextAt - now) / 1000));
    const last = r.round && r.round.index + 1 >= r.round.total;
    el.nextIn.textContent = `${last ? 'Final standings' : 'Next round'} in ${secs} s`;
  }
}
S.tick = setInterval(updateTimers, 250);

// ---- controls ----
el.name.value = store.get('sd.name') || '';
const params = new URLSearchParams(location.search);
if (params.get('room')) el.code.value = params.get('room').toUpperCase().slice(0, 4);

function readName() {
  const name = el.name.value.replace(/\s+/g, ' ').trim();
  if (!name) {
    showHome('Pick a nickname first.');
    el.name.focus();
    return null;
  }
  store.set('sd.name', name);
  return name;
}

el.create.addEventListener('click', async () => {
  const name = readName();
  if (!name) return;
  setBusy(true);
  try {
    const r = await fetch('/api/rooms', { method: 'POST' });
    if (!r.ok) throw new Error('create failed');
    const { code } = await r.json();
    connect({ code, name });
  } catch (_) {
    showHome('Could not create a room. Check your connection and try again.');
  }
});

async function joinFromInput() {
  const name = readName();
  if (!name) return;
  const code = el.code.value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) { showHome('Room codes have 4 letters.'); return; }
  setBusy(true);
  const info = await probe(code);
  if (info === null) { showHome(`There is no room ${code}.`); return; }
  if (info === undefined) { showHome('Could not reach the server. Try again.'); return; }
  if (info.full) { showHome(`Room ${code} is full.`); return; }
  connect({ code, name });
}
el.join.addEventListener('click', joinFromInput);
el.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput(); });
el.code.addEventListener('input', () => { el.code.value = el.code.value.toUpperCase().replace(/[^A-Z]/g, ''); });
el.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') (el.code.value ? joinFromInput() : el.create.click()); });

for (const b of $$('[data-rounds]')) b.addEventListener('click', () => send({ type: 'settings', rounds: Number(b.dataset.rounds) }));
for (const b of $$('[data-difficulty]')) b.addEventListener('click', () => send({ type: 'settings', difficulty: b.dataset.difficulty }));
el.start.addEventListener('click', () => send({ type: 'start' }));
el.next.addEventListener('click', () => send({ type: 'next' }));
el.playAgain.addEventListener('click', () => send({ type: 'playAgain' }));

function leaveRoom() {
  send({ type: 'leave' });
  const ws = S.ws;
  S.ws = null;
  stopPing();
  try { ws && ws.close(1000, 'left'); } catch (_) { /* ignore */ }
  clearSession();
  showHome();
}
el.leave.addEventListener('click', leaveRoom);
el.leaveFinal.addEventListener('click', leaveRoom);

el.share.addEventListener('click', async () => {
  const url = `${location.origin}/${S.room ? S.room.code : ''}`;
  try {
    if (navigator.share) await navigator.share({ title: 'SQL Duel', text: 'Join my SQL Duel room', url });
    else {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    }
  } catch (_) {
    toast(url);
  }
});

function showKicked() {
  showOverlay(`<h2>Opened in another tab</h2><p>This room is open in another tab or window. Only one can play at a time.</p>
    <button class="btn primary" id="use-here" data-testid="use-here">Play in this tab</button>
    <button class="link" id="kicked-leave">Leave room</button>`);
  $('#use-here').addEventListener('click', () => { hideOverlay(); reconnectNow(); });
  $('#kicked-leave').addEventListener('click', () => { hideOverlay(); clearSession(); showHome(); });
}

for (const b of $$('[data-open-help]')) b.addEventListener('click', () => { el.help.hidden = false; $('[data-close-help]').focus(); });
$('[data-close-help]').addEventListener('click', () => { el.help.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.help.hidden = true; });

// ---- start ----
(async function boot() {
  const sess = store.get('sd.session');
  const wanted = params.get('room') && params.get('room').toUpperCase();
  if (sess && sess.code && (!wanted || wanted === sess.code)) {
    showScreen('home');
    el.reconnecting.hidden = false;
    await reconnectNow();
    return;
  }
  showHome();
  if (wanted) el.name.focus();
})();
