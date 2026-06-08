import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const TICK_RATE_MS = 66;
const WORLD = { width: 4200, height: 3600 };
const ROOM_NAME = "casual";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("FishFight casual websocket server is running.\n");
});

const wss = new WebSocketServer({ server });
const players = new Map();

function sanitizePlayer(packet = {}) {
  const x = Number(packet.x);
  const y = Number(packet.y);
  const mass = Number(packet.mass);
  const dirX = Number(packet.dirX);
  const dirY = Number(packet.dirY);
  const clampX = Number.isFinite(x) ? Math.max(0, Math.min(WORLD.width, x)) : 0;
  const clampY = Number.isFinite(y) ? Math.max(0, Math.min(WORLD.height, y)) : 0;

  return {
    id: String(packet.id || ""),
    name: String(packet.name || "Guest").slice(0, 24),
    x: clampX,
    y: clampY,
    mass: Number.isFinite(mass) ? mass : 20,
    color: String(packet.color || "#38bdf8"),
    nameColor: String(packet.nameColor || "white"),
    fishType: String(packet.fishType || "pufferfish"),
    mapId: String(packet.mapId || "reef"),
    dirX: Number.isFinite(dirX) ? dirX : 0,
    dirY: Number.isFinite(dirY) ? dirY : 0,
    skin: packet.skin || null,
    room: String(packet.room || ROOM_NAME),
    ts: Number.isFinite(Number(packet.ts)) ? Number(packet.ts) : Date.now()
  };
}

function broadcastState() {
  const payload = JSON.stringify({
    type: "state",
    world: WORLD,
    room: ROOM_NAME,
    count: players.size,
    players: Array.from(players.values()).filter((player) => player.room === ROOM_NAME)
  });

  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function removePlayer(id) {
  if (!id) return;
  players.delete(id);
}

wss.on("connection", (ws) => {
  const sessionId = `p-${Math.random().toString(36).slice(2, 10)}`;
  ws.isAlive = true;

  ws.send(JSON.stringify({
    type: "session",
    id: sessionId,
    message: "Connected to casual lobby server."
  }));

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let packet;
    try {
      packet = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (packet.type === "ping") {
      ws.send(JSON.stringify({
        type: "pong",
        ts: Number(packet.ts) || Date.now()
      }));
      return;
    }

    if (packet.type === "join" || packet.type === "ready" || packet.type === "update") {
      const player = sanitizePlayer(packet);
      player.id = sessionId;
      player.room = ROOM_NAME;
      players.set(sessionId, player);
      ws.send(JSON.stringify({
        type: "session",
        id: sessionId,
        message: "Player registered."
      }));
      return;
    }

    if (packet.type === "leave") {
      removePlayer(sessionId);
    }
  });

  ws.on("close", () => {
    removePlayer(sessionId);
  });

  ws.on("error", () => {
    removePlayer(sessionId);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // Ignore ping failures; close handlers will clean up.
    }
  }
  broadcastState();
}, TICK_RATE_MS);

server.listen(PORT, () => {
  console.log(`FishFight casual websocket server listening on port ${PORT}`);
});
