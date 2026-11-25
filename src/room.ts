// One Durable Object per room. Thin shell around src/game.ts:
// parse input -> advance(state, now) -> apply command -> commit() (persist, reschedule alarm, broadcast).
// Player SQL only ever runs in the in-memory engine against puzzle tables; it never touches ctx.storage.

import { DurableObject } from 'cloudflare:workers';
import packJson from '../puzzles/pack.json' with { type: 'json' };
import {
  addPlayer, advance, applySettings, bookOf, connectedPlayers, dedupeName, ensureHost, isExpired, isFull, maybeEndEarly,
  newRoom, nextDeadline, nextRound, playAgain, prune, removePlayer, sanitizeName, snapshot, startGame, submit,
} from './game.ts';
import type { PuzzleBook, Rng } from './game.ts';
import { MAX_MESSAGE_BYTES, MAX_PLAYERS, MIN_PLAYERS } from './protocol.ts';
import type { ClientMsg, ErrorCode, Phase, RoomState, ServerEvent } from './protocol.ts';
import type { Pack } from './puzzles.ts';

const BOOK: PuzzleBook = bookOf((packJson as unknown as Pack).puzzles);

interface Attachment {
  playerId: string;
}

export interface RoomInfo {
  code: string;
  phase: Phase;
  players: number;
  full: boolean;
}

const OPEN = 1; // WebSocket.readyState OPEN

export class RoomDO extends DurableObject<Env> {
  private state: RoomState | null = null;
  private rng: Rng = Math.random;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>('state')) ?? null;
      if (this.state) {
        // Self-heal after a wake-up: connection flags follow the sockets that actually survived.
        for (const p of this.state.players) p.connected = this.openSockets(p.id).length > 0;
      }
    });
  }

  // ---- RPC used by the Worker ----

  async create(code: string): Promise<boolean> {
    if (this.state) return false;
    this.state = newRoom(code, Date.now());
    this.state.idleSince = Date.now(); // nobody connected yet: an abandoned room still expires
    await this.persist();
    return true;
  }

  async info(): Promise<RoomInfo | null> {
    if (!this.state) return null;
    return {
      code: this.state.code,
      phase: this.state.phase,
      players: this.state.players.length,
      full: isFull(this.state),
    };
  }

  // ---- WebSocket join / resume ----

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const now = Date.now();

    const reject = (code: ErrorCode, closeCode: number, message: string): Response => {
      this.ctx.acceptWebSocket(server);
      this.sendTo(server, { type: 'error', code, message });
      try {
        server.close(closeCode, code);
      } catch {
        // already closed
      }
      return new Response(null, { status: 101, webSocket: client });
    };

    if (!this.state) return reject('not_found', 4004, 'That room does not exist or has expired.');
    const state = this.state;
    advance(state, now);

    const pid = url.searchParams.get('pid');
    const secret = url.searchParams.get('secret');
    let player = pid && secret ? state.players.find((p) => p.id === pid && p.secret === secret) : undefined;

    if (player) {
      // Same player in a second tab: the newest socket wins.
      for (const ws of this.ctx.getWebSockets(player.id)) {
        this.sendTo(ws, { type: 'error', code: 'kicked_duplicate', message: 'This room was opened in another tab.' });
        try {
          ws.close(4001, 'kicked_duplicate');
        } catch {
          // ignore
        }
      }
    } else {
      const name = sanitizeName(url.searchParams.get('name') ?? '');
      if (!name) return reject('bad_name', 4003, 'Pick a nickname of 1 to 12 characters.');
      if (isFull(state)) return reject('room_full', 4002, `This room is full (${MAX_PLAYERS} players).`);
      let id = crypto.randomUUID().slice(0, 8);
      while (state.players.some((p) => p.id === id)) id = crypto.randomUUID().slice(0, 8);
      player = addPlayer(state, {
        id,
        secret: crypto.randomUUID(),
        name: dedupeName(name, state.players.map((p) => p.name)),
        now,
      });
    }

    player.connected = true;
    player.lastSeen = now;
    state.idleSince = null;
    ensureHost(state);

    this.ctx.acceptWebSocket(server, [player.id]);
    server.serializeAttachment({ playerId: player.id } satisfies Attachment);
    state.seq++;
    this.sendTo(server, { type: 'welcome', playerId: player.id, secret: player.secret, state: snapshot(state, player.id, BOOK) });
    await this.persist();
    this.broadcastState(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Hibernation handlers ----

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.state) return;
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
    let msg: Partial<ClientMsg> & { type?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    const att = ws.deserializeAttachment() as Attachment | null;
    const state = this.state;
    const player = att ? state.players.find((p) => p.id === att.playerId) : undefined;
    if (!player) return;

    const now = Date.now();
    let dirty = advance(state, now);
    const isHost = state.hostId === player.id;
    const m = msg as ClientMsg;
    const deny = (code: ErrorCode, message: string): void => this.sendTo(ws, { type: 'error', code, message });

    switch (m.type) {
      case 'ping':
        this.sendTo(ws, { type: 'pong', t: typeof m.t === 'number' ? m.t : 0 });
        break;
      case 'submit': {
        const r = submit(state, player, m.query, m.round, now, BOOK);
        if (!r.ok) deny(r.code, r.message);
        else {
          this.sendTo(ws, { type: 'verdict', ...r.verdict });
          if (r.changed) dirty = true;
          else await this.persist(); // the wrong-try count must survive a restart
        }
        break;
      }
      case 'settings':
        if (!isHost) deny('not_host', 'Only the host can change settings.');
        else if (state.phase !== 'lobby') deny('not_allowed', 'Settings can only change in the lobby.');
        else if (applySettings(state, m.rounds, m.difficulty)) dirty = true;
        break;
      case 'start':
        if (!isHost) deny('not_host', 'Only the host can start the game.');
        else if (state.phase !== 'lobby') deny('not_allowed', 'The game is already running.');
        else if (connectedPlayers(state).length < MIN_PLAYERS) deny('not_allowed', `Need at least ${MIN_PLAYERS} connected players.`);
        else {
          startGame(state, now, BOOK, this.rng);
          dirty = true;
        }
        break;
      case 'next':
        if (!isHost) deny('not_host', 'Only the host can skip ahead.');
        else if (state.phase !== 'round_end') deny('not_allowed', 'There is no round to skip to yet.');
        else {
          nextRound(state, now);
          dirty = true;
        }
        break;
      case 'playAgain':
        if (!isHost) deny('not_host', 'Only the host can start a new game.');
        else if (state.phase !== 'game_end') deny('not_allowed', 'The game has not ended yet.');
        else {
          playAgain(state);
          dirty = true;
        }
        break;
      case 'leave':
        if (removePlayer(state, player.id)) {
          ensureHost(state);
          maybeEndEarly(state, now);
          dirty = true;
        }
        try {
          ws.close(1000, 'left');
        } catch {
          // ignore
        }
        break;
      default:
        break;
    }

    if (dirty) await this.commit();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.onSocketGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // some close codes (e.g. 1005) cannot be echoed; that's fine
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  async alarm(): Promise<void> {
    if (!this.state) return;
    const now = Date.now();
    if (isExpired(this.state, now) && this.openSockets().length === 0) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.state = null;
      return;
    }
    advance(this.state, now);
    prune(this.state, now);
    await this.commit();
  }

  // ---- internals ----

  private async onSocketGone(ws: WebSocket): Promise<void> {
    if (!this.state) return;
    const state = this.state;
    const now = Date.now();
    advance(state, now);
    const att = ws.deserializeAttachment() as Attachment | null;
    const player = att ? state.players.find((p) => p.id === att.playerId) : undefined;
    if (player) {
      const stillOpen = this.ctx.getWebSockets(player.id).some((s) => s !== ws && s.readyState === OPEN);
      if (!stillOpen && player.connected) {
        player.connected = false;
        player.lastSeen = now;
      }
      ensureHost(state);
      maybeEndEarly(state, now);
    }
    if (!this.ctx.getWebSockets().some((s) => s !== ws && s.readyState === OPEN)) state.idleSince = now;
    await this.commit(ws);
  }

  private openSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === OPEN);
  }

  private async commit(skip?: WebSocket): Promise<void> {
    if (!this.state) return;
    this.state.seq++;
    await this.persist();
    this.broadcastState(skip);
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    await this.ctx.storage.put('state', this.state);
    const next = nextDeadline(this.state, Date.now());
    if (next !== null) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  private sendTo(ws: WebSocket, ev: ServerEvent): void {
    try {
      ws.send(JSON.stringify({ ...ev, serverNow: Date.now() }));
    } catch {
      // socket already gone
    }
  }

  /** Every socket gets its own snapshot (it carries that player's own round state). */
  private broadcastState(skip?: WebSocket): void {
    if (!this.state) return;
    for (const ws of this.openSockets()) {
      if (ws === skip) continue;
      const att = ws.deserializeAttachment() as Attachment | null;
      this.sendTo(ws, { type: 'state', state: snapshot(this.state, att?.playerId ?? null, BOOK) });
    }
  }
}
