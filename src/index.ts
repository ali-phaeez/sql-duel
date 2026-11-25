// Worker entry: room creation/probe API, WebSocket hand-off to the room's Durable Object,
// and short share links (/ABCD -> /?room=ABCD). Everything else is served from ./public by Static Assets.

import { generateCode, isValidCode, normalizeCode } from './codes.ts';

export { RoomDO } from './room.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/rooms') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        if (await stub.create(code)) return json({ code }, 201);
      }
      return json({ error: 'busy' }, 503);
    }

    const probe = path.match(/^\/api\/rooms\/([A-Za-z]{4})$/);
    if (probe) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const code = normalizeCode(probe[1]);
      if (!isValidCode(code)) return json({ error: 'not_found' }, 404);
      const info = await env.ROOM.get(env.ROOM.idFromName(code)).info();
      return info ? json(info) : json({ error: 'not_found' }, 404);
    }

    const ws = path.match(/^\/ws\/([A-Za-z]{4})$/);
    if (ws) {
      const code = normalizeCode(ws[1]);
      if (!isValidCode(code)) return new Response('Not found', { status: 404 });
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }

    const short = path.match(/^\/([A-Za-z]{4})$/);
    if (short) {
      const code = normalizeCode(short[1]);
      if (isValidCode(code)) return Response.redirect(`${url.origin}/?room=${code}`, 302);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
