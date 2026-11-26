// Pistoleros de Chatarra 3D — servidor del modo online.
// El Worker sirve la web (carpeta public/) y envía las conexiones /ws a una
// "sala" (Durable Object) que reenvía la posición y los disparos de cada jugador
// al resto. No guarda nada: cuando todos se van, la sala queda vacía.
import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 200; // prácticamente sin límite
const MAX_MSG = 65536;

export class Room extends DurableObject {
  async fetch(request) {
    const others = this.ctx.getWebSockets();
    if (others.length >= MAX_PLAYERS) {
      // Avisamos y cerramos: la sala está llena.
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.send(JSON.stringify({ t: "full" }));
      server.close(1013, "full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

    const peers = [];
    for (const ws of others) {
      const a = readAttachment(ws);
      if (a && !a.gone) peers.push({ id: a.id, d: a.d || {} });
    }

    // API de hibernación: Cloudflare puede "dormir" la sala entre mensajes.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, d: {} });
    server.send(JSON.stringify({ t: "hello", id, peers }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (!m || m.t !== "p" || typeof m.d !== "object" || m.d === null) return;

    const a = readAttachment(ws);
    if (!a || a.gone) return;
    a.d = m.d;
    try { ws.serializeAttachment(a); } catch {
      // El adjunto tiene un tamaño máximo: guardamos solo lo básico para los que entren después.
      const d = m.d;
      try { ws.serializeAttachment({ id: a.id, d: { n: d.n, tm: d.tm, ch: d.ch, c: d.c, x: d.x, z: d.z, y: d.y, al: d.al, hp: d.hp, k: d.k } }); } catch {}
    }

    const out = JSON.stringify({ t: "p", id: a.id, d: m.d });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) {
        try { other.send(out); } catch { /* conexión ya cerrada */ }
      }
    }
  }

  webSocketClose(ws, code) {
    this.bye(ws);
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* ya cerrada */ }
  }

  webSocketError(ws) {
    this.bye(ws);
  }

  bye(ws) {
    const a = readAttachment(ws);
    if (!a || a.gone) return;
    a.gone = true;
    try { ws.serializeAttachment({ id: a.id, gone: true }); } catch {}
    const out = JSON.stringify({ t: "leave", id: a.id });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) {
        try { other.send(out); } catch {}
      }
    }
  }
}

// Clasificación mundial: un único Durable Object guarda los mejores jugadores.
const BOARD_MAX = 500;
export class Board extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    let all = (await this.ctx.storage.get("all")) || {};
    if (request.method === "POST" && url.pathname === "/api/score") {
      let b;
      try { b = await request.json(); } catch { return json({ ok: false }, 400); }
      const id = String(b.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 24);
      if (id.length < 6) return json({ ok: false }, 400);
      const now = Date.now(), prev = all[id];
      if (prev && now - prev.t < 20000) return json({ ok: true, slow: true });
      const clean = (v, max) => Math.max(0, Math.min(max, Math.floor(+v || 0)));
      all[id] = {
        id,
        n: String(b.n || "Forastero").replace(/[<>&"]/g, "").slice(0, 14) || "Forastero",
        lvl: clean(b.lvl, 999), xp: clean(b.xp, 1e7), k: clean(b.k, 1e8), w: clean(b.w, 1e7), t: now,
      };
      const ids = Object.keys(all);
      if (ids.length > BOARD_MAX) {
        ids.sort((a, c) => score(all[a]) - score(all[c]));
        for (const x of ids.slice(0, ids.length - BOARD_MAX)) delete all[x];
      }
      await this.ctx.storage.put("all", all);
      return json({ ok: true });
    }
    const top = Object.values(all).sort((a, c) => score(c) - score(a)).slice(0, 50);
    return json({ top });
  }
}
const score = (r) => r.lvl * 1e7 + r.xp;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function readAttachment(ws) {
  try { return ws.deserializeAttachment(); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Aquí se conecta el juego por WebSocket.", { status: 426 });
      }
      const name = (url.searchParams.get("room") || "duelo-3d").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 48) || "duelo-3d";
      const stub = env.ROOM.get(env.ROOM.idFromName(name));
      return stub.fetch(request);
    }

    if (url.pathname === "/api/top" || url.pathname === "/api/score") {
      const stub = env.BOARD.get(env.BOARD.idFromName("mundial"));
      return stub.fetch(request);
    }

    // Todo lo demás: los archivos de la carpeta public/
    return env.ASSETS.fetch(request);
  },
};
