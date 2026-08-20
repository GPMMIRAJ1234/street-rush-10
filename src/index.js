import { DurableObject } from "cloudflare:workers";

const COLORS = [
  "#e94560","#4cc9f0","#f9c74f","#90be6d","#f9844a",
  "#b5179e","#43aa8b","#f72585","#577590","#f8961e"
];

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export class RaceHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.rooms = new Map();
    this.sockets = new Map();

    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get("rooms");

      if (saved) {
        this.rooms = new Map(
          saved.map(([code, room]) => [
            code,
            {
              ...room,
              players: new Map(room.players || [])
            }
          ])
        );
      }
    });
  }

  async save() {
    const data = [...this.rooms.entries()].map(([code, room]) => [
      code,
      {
        code: room.code,
        host: room.host,
        started: room.started,
        settings: room.settings,
        players: [...room.players.entries()].map(([id, p]) => [
          id,
          {
            id: p.id,
            name: p.name,
            color: p.color,
            ready: p.ready,
            x: p.x,
            progress: p.progress,
            lap: p.lap,
            finished: p.finished
          }
        ])
      }
    ]);

    await this.ctx.storage.put("rooms", data);
  }

  viewPlayer(p) {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      ready: p.ready,
      x: p.x,
      progress: p.progress,
      lap: p.lap,
      finished: p.finished
    };
  }

  state(room) {
    return {
      type: "state",
      room: room.code,
      host: room.host,
      started: room.started,
      settings: room.settings,
      players: [...room.players.values()].map(p =>
        this.viewPlayer(p)
      )
    };
  }

  send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  broadcast(room, message) {
    for (const player of room.players.values()) {
      const ws = this.sockets.get(player.id);

      if (ws) {
        this.send(ws, message);
      }
    }
  }

  createRoom() {
    let code;

    do {
      code = makeCode();
    } while (this.rooms.has(code));

    const room = {
      code,
      host: null,
      started: false,

      settings: {
        track: "Downtown Rush",
        laps: 3,
        powerups: true,
        collision: true
      },

      players: new Map()
    };

    this.rooms.set(code, room);

    return room;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== "/ws") {
      return new Response("Street Rush multiplayer server");
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket required", {
        status: 426
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    let playerId = null;
    let roomCode = null;

    server.addEventListener("message", async event => {
      let msg;

      try {
        msg = JSON.parse(event.data);
      } catch {
        this.send(server, {
          type: "error",
          message: "Invalid message"
        });
        return;
      }

      /*
       * CREATE ROOM
       */
      if (msg.type === "create") {
        if (playerId) return;

        const room = this.createRoom();

        playerId = crypto.randomUUID();
        roomCode = room.code;

        const player = {
          id: playerId,
          name: String(msg.name || "Player").slice(0, 14),
          color: msg.color || COLORS[0],
          ready: true,
          x: 0,
          progress: 0,
          lap: 0,
          finished: false
        };

        room.host = playerId;
        room.players.set(playerId, player);

        this.sockets.set(playerId, server);

        await this.save();

        this.send(server, {
          type: "created",
          id: playerId,
          room: room.code
        });

        this.send(server, this.state(room));

        return;
      }

      /*
       * JOIN ROOM
       */
      if (msg.type === "join") {
        if (playerId) return;

        const code = String(msg.room || "")
          .trim()
          .toUpperCase();

        const room = this.rooms.get(code);

        if (!room) {
          this.send(server, {
            type: "error",
            message: "Room not found"
          });
          return;
        }

        if (room.started) {
          this.send(server, {
            type: "error",
            message: "Race already started"
          });
          return;
        }

        if (room.players.size >= 10) {
          this.send(server, {
            type: "error",
            message: "Room is full"
          });
          return;
        }

        playerId = crypto.randomUUID();
        roomCode = room.code;

        const player = {
          id: playerId,
          name: String(msg.name || "Player").slice(0, 14),
          color:
            msg.color ||
            COLORS[room.players.size % COLORS.length],
          ready: false,
          x: 0,
          progress: 0,
          lap: 0,
          finished: false
        };

        room.players.set(playerId, player);

        this.sockets.set(playerId, server);

        await this.save();

        this.send(server, {
          type: "joined",
          id: playerId,
          room: room.code
        });

        this.broadcast(room, this.state(room));

        return;
      }

      /*
       * Ignore messages until the player has joined a room.
       */
      if (!playerId || !roomCode) return;

      const room = this.rooms.get(roomCode);

      if (!room) return;

      const player = room.players.get(playerId);

      if (!player) return;

      /*
       * READY
       */
      if (msg.type === "ready" && !room.started) {
        player.ready = !!msg.value;

        await this.save();

        this.broadcast(room, this.state(room));

        return;
      }

      /*
       * HOST SETTINGS
       */
      if (
        msg.type === "settings" &&
        playerId === room.host &&
        !room.started
      ) {
        const s = msg.settings || {};

        const tracks = [
          "Downtown Rush",
          "Desert Highway",
          "Mountain Pass",
          "Neon City"
        ];

        if (tracks.includes(s.track)) {
          room.settings.track = s.track;
        }

        if ([2, 3, 5].includes(Number(s.laps))) {
          room.settings.laps = Number(s.laps);
        }

        if (typeof s.powerups === "boolean") {
          room.settings.powerups = s.powerups;
        }

        if (typeof s.collision === "boolean") {
          room.settings.collision = s.collision;
        }

        await this.save();

        this.broadcast(room, this.state(room));

        return;
      }

      /*
       * START RACE
       */
      if (
        msg.type === "start" &&
        playerId === room.host &&
        !room.started
      ) {
        if (room.players.size < 2) {
          this.send(server, {
            type: "error",
            message: "At least 2 players are required"
          });
          return;
        }

        const everyoneReady =
          [...room.players.values()].every(p => p.ready);

        if (!everyoneReady) {
          this.send(server, {
            type: "error",
            message: "Every player must be READY"
          });
          return;
        }

        room.started = true;

        for (const p of room.players.values()) {
          p.x = 0;
          p.progress = 0;
          p.lap = 0;
          p.finished = false;
        }

        await this.save();

        this.broadcast(room, {
          type: "start",
          settings: room.settings,
          serverTime: Date.now()
        });

        this.broadcast(room, this.state(room));

        return;
      }

      /*
       * REAL-TIME CAR POSITION
       */
      if (msg.type === "input" && room.started) {
        const x = Number(msg.x);
        const progress = Number(msg.progress);
        const lap = Number(msg.lap);

        if (Number.isFinite(x)) {
          player.x = Math.max(
            -1.05,
            Math.min(1.05, x)
          );
        }

        if (Number.isFinite(progress)) {
          player.progress = Math.max(
            0,
            Math.min(0.999999, progress)
          );
        }

        if (Number.isInteger(lap)) {
          player.lap = Math.max(
            0,
            Math.min(room.settings.laps, lap)
          );
        }

        player.finished = !!msg.finished;

        this.broadcast(room, {
          type: "positions",
          players: [...room.players.values()].map(p =>
            this.viewPlayer(p)
          )
        });

        return;
      }
    });

    const disconnect = async () => {
      if (!playerId) return;

      this.sockets.delete(playerId);

      const room = this.rooms.get(roomCode);

      if (!room) return;

      room.players.delete(playerId);

      if (room.host === playerId) {
        const next =
          room.players.values().next().value;

        room.host = next ? next.id : null;
      }

      if (room.players.size === 0) {
        this.rooms.delete(room.code);
      } else {
        this.broadcast(room, this.state(room));
      }

      await this.save();
    };

    server.addEventListener("close", disconnect);
    server.addEventListener("error", disconnect);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const id = env.RACE_HUB.idFromName("street-rush-global");
      const hub = env.RACE_HUB.get(id);

      return hub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};
