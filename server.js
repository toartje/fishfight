import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const TICK_RATE_MS = 50;
const START_MASS = 20;
const EAT_RATIO = 1.15;
const SPLIT_TUNING = {
  MAX_PARTS: 16,
  MIN_MASS: 30,
  LAUNCH_SPEED: 14,
  LAUNCH_DISTANCE: 1.75,
  MERGE_TIMER: 300
};

const MAPS = {
  reef: { world: { width: 4200, height: 3600 } },
  scrap: { world: { width: 4600, height: 3400 } },
  ember: { world: { width: 4000, height: 4000 } }
};

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
const rooms = new Map();
const playersById = new Map();
const socketMeta = new Map();

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function radiusFromMass(mass) {
  return Math.sqrt(Math.max(0, mass)) * 5.7;
}

function speedFromMass(mass) {
  return Math.max(0.92, 10.5 / Math.pow(Math.max(1, mass), 0.33));
}

function normalize(dx, dy) {
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

function getRoomKey(mode, mapId) {
  return `${mode || "casual"}:${mapId || "reef"}`;
}

function getRoom(roomKey, mapId = "reef") {
  let room = rooms.get(roomKey);
  if (room) return room;

  const map = MAPS[mapId] || MAPS.reef;
  room = {
    key: roomKey,
    mapId: MAPS[mapId] ? mapId : "reef",
    map,
    world: { ...map.world },
    seed: `fishfight:${mapId || "reef"}:casual`,
    players: new Map(),
    tick: 0,
    lastBroadcastAt: 0
  };

  rooms.set(roomKey, room);
  return room;
}

function findSafeSpawn(room, spread = 220) {
  for (let i = 0; i < 40; i++) {
    const candidate = {
      x: rand(spread, room.world.width - spread),
      y: rand(spread, room.world.height - spread)
    };
    const tooClose = [...room.players.values()].some((entity) => {
      const ex = entity.x ?? entity.parts?.[0]?.x ?? 0;
      const ey = entity.y ?? entity.parts?.[0]?.y ?? 0;
      return Math.hypot(candidate.x - ex, candidate.y - ey) < 300;
    });
    if (!tooClose) return candidate;
  }
  return { x: room.world.width / 2, y: room.world.height / 2 };
}

function getTotalMass(parts) {
  return parts.reduce((sum, part) => sum + part.mass, 0);
}

function getMainPart(player) {
  if (!player.parts.length) return null;
  return player.parts.reduce((best, part) => (part.mass > best.mass ? part : best), player.parts[0]);
}

function updatePlayerCenter(player) {
  if (!player.parts.length) return;
  const total = getTotalMass(player.parts);
  let sumX = 0;
  let sumY = 0;
  for (const part of player.parts) {
    sumX += part.x * part.mass;
    sumY += part.y * part.mass;
  }
  player.x = sumX / total;
  player.y = sumY / total;
  player.mass = total;
}

function pullPlayerPartsTogether(player) {
  if (player.parts.length < 2) return;
  const total = getTotalMass(player.parts);
  let centerX = 0;
  let centerY = 0;
  for (const part of player.parts) {
    centerX += part.x * part.mass;
    centerY += part.y * part.mass;
  }
  centerX /= total;
  centerY /= total;
  for (const part of player.parts) {
    if (part.mergeTimer <= 0) {
      part.x += (centerX - part.x) * 0.006;
      part.y += (centerY - part.y) * 0.006;
    }
  }
}

function mergePlayerParts(player) {
  for (let i = player.parts.length - 1; i >= 0; i--) {
    for (let j = i - 1; j >= 0; j--) {
      const a = player.parts[i];
      const b = player.parts[j];
      if (a.mergeTimer > 0 || b.mergeTimer > 0) continue;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance < Math.max(radiusFromMass(a.mass), radiusFromMass(b.mass)) * 0.45) {
        const total = a.mass + b.mass;
        b.x = (a.x * a.mass + b.x * b.mass) / total;
        b.y = (a.y * a.mass + b.y * b.mass) / total;
        b.mass = total;
        player.parts.splice(i, 1);
        break;
      }
    }
  }
}

function movePlayer(player, room) {
  if (player.dead) return;
  const move = normalize(player.moveX, player.moveY);
  if (Math.hypot(move.x, move.y) > 0.001) {
    player.dirX = move.x;
    player.dirY = move.y;
  }

  const maxSpeed = Math.max(...player.parts.map((part) => speedFromMass(part.mass)), 1.15);
  if (player.moveX !== 0 || player.moveY !== 0) {
    const targetX = move.x * maxSpeed;
    const targetY = move.y * maxSpeed;
    player.moveVelocity.x += (targetX - player.moveVelocity.x) * 0.18;
    player.moveVelocity.y += (targetY - player.moveVelocity.y) * 0.18;
  } else {
    player.moveVelocity.x *= 0.94;
    player.moveVelocity.y *= 0.94;
  }

  if (Math.abs(player.moveVelocity.x) < 0.01) player.moveVelocity.x = 0;
  if (Math.abs(player.moveVelocity.y) < 0.01) player.moveVelocity.y = 0;

  for (const part of player.parts) {
    const speed = speedFromMass(part.mass);
    const moveScale = speed / maxSpeed;
    part.x += player.moveVelocity.x * moveScale;
    part.y += player.moveVelocity.y * moveScale;
    part.x += part.vx || 0;
    part.y += part.vy || 0;
    part.vx = (part.vx || 0) * 0.92;
    part.vy = (part.vy || 0) * 0.92;
    part.x = Math.max(0, Math.min(room.world.width, part.x));
    part.y = Math.max(0, Math.min(room.world.height, part.y));
    if (part.mergeTimer > 0) part.mergeTimer--;
  }

  pullPlayerPartsTogether(player);
  mergePlayerParts(player);
  updatePlayerCenter(player);
}

function splitPlayer(player) {
  if (player.dead) return false;
  if (player.parts.length >= SPLIT_TUNING.MAX_PARTS) return false;
  const move = normalize(player.moveX || player.dirX || 1, player.moveY || player.dirY || 0);
  const snapshot = [...player.parts];
  let didSplit = false;

  for (const part of snapshot) {
    if (player.parts.length >= SPLIT_TUNING.MAX_PARTS) break;
    if (part.mass < SPLIT_TUNING.MIN_MASS) continue;
    const newMass = part.mass / 2;
    const launch = radiusFromMass(newMass) * SPLIT_TUNING.LAUNCH_DISTANCE;
    part.mass = newMass;
    player.parts.push({
      x: part.x + move.x * launch,
      y: part.y + move.y * launch,
      mass: newMass,
      vx: move.x * SPLIT_TUNING.LAUNCH_SPEED,
      vy: move.y * SPLIT_TUNING.LAUNCH_SPEED,
      mergeTimer: SPLIT_TUNING.MERGE_TIMER
    });
    didSplit = true;
  }

  if (didSplit) {
    updatePlayerCenter(player);
    player.moveVelocity.x += move.x * 2;
    player.moveVelocity.y += move.y * 2;
  }
  return didSplit;
}

function applyMassDecay(room) {
  const apply = (mass) => {
    if (mass <= 100) return 0;
    if (mass <= 500) return mass * 0.001;
    if (mass <= 1000) return mass * 0.002;
    if (mass <= 2500) return mass * 0.0035;
    if (mass <= 5000) return mass * 0.005;
    return mass * 0.0075;
  };

  for (const player of room.players.values()) {
    if (player.dead) continue;
    for (const part of player.parts) {
      const decay = apply(part.mass) / 60;
      if (decay > 0) part.mass = Math.max(START_MASS, part.mass - decay);
    }
    updatePlayerCenter(player);
  }
}

function resolvePlayerCollisions(room) {
  const playerEntries = [...room.players.values()];
  for (let i = 0; i < playerEntries.length; i++) {
    for (let j = i + 1; j < playerEntries.length; j++) {
      const a = playerEntries[i];
      const b = playerEntries[j];
      if (a.dead || b.dead) continue;
      for (let ai = a.parts.length - 1; ai >= 0; ai--) {
        for (let bi = b.parts.length - 1; bi >= 0; bi--) {
          const pa = a.parts[ai];
          const pb = b.parts[bi];
          const distance = Math.hypot(pa.x - pb.x, pa.y - pb.y);
          if (distance < Math.max(radiusFromMass(pa.mass), radiusFromMass(pb.mass)) * 0.72 && pa.mass > pb.mass * EAT_RATIO) {
            pa.mass += pb.mass * 0.55;
            b.parts.splice(bi, 1);
            if (!b.parts.length) {
              b.dead = true;
              b.parts = [];
              b.mass = 0;
            }
            updatePlayerCenter(a);
            if (b.parts.length) updatePlayerCenter(b);
            break;
          }
          if (distance < Math.max(radiusFromMass(pa.mass), radiusFromMass(pb.mass)) * 0.72 && pb.mass > pa.mass * EAT_RATIO) {
            pb.mass += pa.mass * 0.55;
            a.parts.splice(ai, 1);
            if (!a.parts.length) {
              a.dead = true;
              a.parts = [];
              a.mass = 0;
            }
            if (a.parts.length) updatePlayerCenter(a);
            updatePlayerCenter(b);
            break;
          }
        }
      }
    }
  }
}

function serializeRoom(room) {
  return {
    type: "state",
    seed: room.seed,
    room: room.key,
    mapId: room.mapId,
    tick: room.tick,
    world: room.world,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      x: player.x,
      y: player.y,
      mass: player.mass,
      color: player.color,
      nameColor: player.nameColor,
      fishType: player.fishType,
      skin: player.skin,
      dirX: player.dirX,
      dirY: player.dirY,
      parts: player.parts.map((part) => ({
        x: part.x,
        y: part.y,
        mass: part.mass,
        vx: part.vx || 0,
        vy: part.vy || 0,
        mergeTimer: part.mergeTimer || 0
      })),
      dead: Boolean(player.dead)
    }))
  };
}

function broadcastRoom(room) {
  const payload = JSON.stringify(serializeRoom(room));
  for (const player of room.players.values()) {
    if (player.ws && player.ws.readyState === 1) {
      player.ws.send(payload);
    }
  }
}

function createPlayerState(sessionId, packet, room) {
  const spawn = findSafeSpawn(room, 20);
  return {
    id: sessionId,
    name: String(packet.name || "Guest").slice(0, 24),
    x: spawn.x,
    y: spawn.y,
    mass: START_MASS,
    color: String(packet.color || "#38bdf8"),
    nameColor: String(packet.nameColor || "white"),
    fishType: String(packet.fishType || "pufferfish"),
    skin: packet.skin || null,
    dirX: 1,
    dirY: 0,
    moveX: 0,
    moveY: 0,
    moveVelocity: { x: 0, y: 0 },
    parts: [{ x: spawn.x, y: spawn.y, mass: START_MASS, vx: 0, vy: 0, mergeTimer: 0 }],
    lastSeen: Date.now(),
    dead: false,
    splitCooldown: 0,
    fireCooldown: 0
  };
}

function stepRoom(room) {
  room.tick++;
  for (const player of room.players.values()) {
    player.splitCooldown = Math.max(0, player.splitCooldown - 1);
    player.fireCooldown = Math.max(0, player.fireCooldown - 1);
    movePlayer(player, room);
  }
  resolvePlayerCollisions(room);
  applyMassDecay(room);
}

wss.on("connection", (ws) => {
  const sessionId = `p-${Math.random().toString(36).slice(2, 10)}`;
  ws.isAlive = true;
  socketMeta.set(ws, { sessionId, roomKey: null });

  ws.send(JSON.stringify({
    type: "session",
    id: sessionId,
    seed: `fishfight:reef:casual`,
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

    const meta = socketMeta.get(ws);
    if (!meta) return;

    if (packet.type === "join" || packet.type === "ready" || packet.type === "update") {
      const roomKey = getRoomKey(packet.mode || "casual", packet.mapId || "reef");
      const room = getRoom(roomKey, packet.mapId || "reef");
      meta.roomKey = roomKey;

      let player = room.players.get(sessionId);
      if (!player) {
        player = createPlayerState(sessionId, packet, room);
        room.players.set(sessionId, player);
      }
      player.ws = ws;
      player.name = String(packet.name || player.name || "Guest").slice(0, 24);
      player.color = String(packet.color || player.color || "#38bdf8");
      player.nameColor = String(packet.nameColor || player.nameColor || "white");
      player.fishType = String(packet.fishType || player.fishType || "pufferfish");
      player.skin = packet.skin || player.skin || null;
      player.moveX = Number(packet.dirX) || 0;
      player.moveY = Number(packet.dirY) || 0;
      player.lastSeen = Date.now();

      if (packet.type === "ready") {
        if (Number.isFinite(Number(packet.x)) && Number.isFinite(Number(packet.y))) {
          player.x = Math.max(0, Math.min(room.world.width, Number(packet.x)));
          player.y = Math.max(0, Math.min(room.world.height, Number(packet.y)));
          player.parts = [{ x: player.x, y: player.y, mass: START_MASS, vx: 0, vy: 0, mergeTimer: 0 }];
          player.mass = START_MASS;
          player.dead = false;
        }
      }

      playersById.set(sessionId, player);
      ws.send(JSON.stringify({
        type: "session",
        id: sessionId,
        seed: room.seed,
        message: "Player registered."
      }));
      broadcastRoom(room);
      return;
    }

    if (packet.type === "action") {
      const player = playersById.get(sessionId);
      if (!player) return;
      if (packet.action === "split" && player.splitCooldown <= 0) {
        if (splitPlayer(player)) player.splitCooldown = 24;
      }
      return;
    }

    if (packet.type === "update") {
      const player = playersById.get(sessionId);
      if (!player) return;
      if (player.dead) return;
      player.moveX = Number(packet.dirX) || 0;
      player.moveY = Number(packet.dirY) || 0;
      player.name = String(packet.name || player.name || "Guest").slice(0, 24);
      player.color = String(packet.color || player.color || "#38bdf8");
      player.nameColor = String(packet.nameColor || player.nameColor || "white");
      player.fishType = String(packet.fishType || player.fishType || "pufferfish");
      player.skin = packet.skin || player.skin || null;
      player.lastSeen = Date.now();
      return;
    }

    if (packet.type === "leave") {
      const room = rooms.get(meta.roomKey);
      if (room) room.players.delete(sessionId);
      playersById.delete(sessionId);
      meta.roomKey = null;
    }
  });

  ws.on("close", () => {
    const meta = socketMeta.get(ws);
    if (meta?.roomKey) {
      const room = rooms.get(meta.roomKey);
      if (room) room.players.delete(sessionId);
    }
    playersById.delete(sessionId);
    socketMeta.delete(ws);
  });

  ws.on("error", () => {
    const meta = socketMeta.get(ws);
    if (meta?.roomKey) {
      const room = rooms.get(meta.roomKey);
      if (room) room.players.delete(sessionId);
    }
    playersById.delete(sessionId);
    socketMeta.delete(ws);
  });
});

setInterval(() => {
  const cutoff = Date.now() - 12000;
  for (const [id, player] of playersById.entries()) {
    if (player.lastSeen < cutoff) {
      const room = rooms.get(socketMeta.get(player.ws)?.roomKey);
      if (room) room.players.delete(id);
      playersById.delete(id);
    }
  }

  const now = Date.now();
  for (const room of rooms.values()) {
    stepRoom(room);
    if (!room.lastBroadcastAt || now - room.lastBroadcastAt >= 100) {
      room.lastBroadcastAt = now;
      broadcastRoom(room);
    }
  }

  if (!server.lastPingAt || now - server.lastPingAt >= 25000) {
    server.lastPingAt = now;
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
  }
}, TICK_RATE_MS);

server.listen(PORT, () => {
  console.log(`FishFight casual websocket server listening on port ${PORT}`);
});
