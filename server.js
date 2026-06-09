import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const TICK_RATE_MS = 50;
const WORLD = { width: 4200, height: 3600 };
const ROOM_NAME = "casual";
const SMOOTHING = 0.28;
const FOOD_COUNT = 700;
const BOT_COUNT = 40;
const VIRUS_COUNT = 18;
const EAT_RATIO = 1.15;
const VIRUS_MASS = 60;

const BOT_NAMES = [
  "Nemo",
  "Bubbles",
  "Reef",
  "Splash",
  "Coral",
  "Guppy",
  "Mako",
  "Drift",
  "Wave",
  "Fin"
];

const BOT_COLORS = [
  "#38bdf8",
  "#22c55e",
  "#f97316",
  "#ef4444",
  "#a855f7",
  "#facc15",
  "#14b8a6"
];

const BOT_FISH_TYPES = [
  "pufferfish",
  "anglerfish",
  "eel",
  "jellyfish",
  "clownfish"
];

const FOOD_KINDS = ["plankton", "kelp", "bubble", "sprout"];

const sharedWorld = {
  foods: [],
  bots: [],
  viruses: []
};

let entitySeq = 0;

function random(min, max) {
  return Math.random() * (max - min) + min;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)] || null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createFood() {
  return {
    id: `f-${Date.now().toString(36)}-${entitySeq++}`,
    kind: pick(FOOD_KINDS) || "plankton",
    x: random(0, WORLD.width),
    y: random(0, WORLD.height),
    r: random(4, 8),
    hitR: random(10, 15),
    points: 1,
    color: pick(["#34d399", "#60a5fa", "#f59e0b", "#f472b6"]) || "#34d399",
    drawScale: random(0.9, 1.2)
  };
}

function createVirus() {
  return {
    id: `v-${Date.now().toString(36)}-${entitySeq++}`,
    kind: "virus",
    x: random(120, WORLD.width - 120),
    y: random(120, WORLD.height - 120),
    r: VIRUS_MASS * 0.52,
    mass: VIRUS_MASS,
    eaten: 0
  };
}

function createBot() {
  const mass = random(20, 65);
  return {
    id: `b-${Date.now().toString(36)}-${entitySeq++}`,
    name: pick(BOT_NAMES) || "Bot",
    x: random(0, WORLD.width),
    y: random(0, WORLD.height),
    mass,
    color: pick(BOT_COLORS) || "#38bdf8",
    fishType: pick(BOT_FISH_TYPES) || "pufferfish",
    dx: random(-1, 1),
    dy: random(-1, 1),
    vx: 0,
    vy: 0,
    changeTimer: Math.floor(random(40, 160)),
    decisionTimer: Math.floor(random(15, 45)),
    splitCooldown: Math.floor(random(120, 260))
  };
}

function respawnFood(index) {
  sharedWorld.foods[index] = createFood();
}

function respawnBot(index) {
  sharedWorld.bots[index] = createBot();
}

function respawnVirus(index) {
  sharedWorld.viruses[index] = createVirus();
}

function ensureWorldPopulation() {
  while (sharedWorld.foods.length < FOOD_COUNT) sharedWorld.foods.push(createFood());
  while (sharedWorld.foods.length > FOOD_COUNT) sharedWorld.foods.pop();
  while (sharedWorld.bots.length < BOT_COUNT) sharedWorld.bots.push(createBot());
  while (sharedWorld.bots.length > BOT_COUNT) sharedWorld.bots.pop();
  while (sharedWorld.viruses.length < VIRUS_COUNT) sharedWorld.viruses.push(createVirus());
  while (sharedWorld.viruses.length > VIRUS_COUNT) sharedWorld.viruses.pop();
}

function getPlayerRadius(mass) {
  return Math.max(12, Math.sqrt(Math.max(1, mass)) * 5.1);
}

function getEntityRadius(entity) {
  return entity?.hitR || entity?.r || 8;
}

function moveTowardsEntity(bot, target, strength) {
  const dx = target.x - bot.x;
  const dy = target.y - bot.y;
  const length = Math.hypot(dx, dy) || 1;
  bot.dx = bot.dx * (1 - strength) + (dx / length) * strength;
  bot.dy = bot.dy * (1 - strength) + (dy / length) * strength;
}

function updateBot(bot) {
  bot.splitCooldown = Math.max(0, bot.splitCooldown - 1);
  bot.decisionTimer -= 1;

  const nearbyPlayers = Array.from(players.values())
    .filter((player) => player.room === ROOM_NAME)
    .sort((a, b) => {
      const da = Math.hypot(a.x - bot.x, a.y - bot.y);
      const db = Math.hypot(b.x - bot.x, b.y - bot.y);
      return da - db;
    });

  const closest = nearbyPlayers[0];
  if (closest) {
    const distance = Math.hypot(closest.x - bot.x, closest.y - bot.y);
    if (closest.mass > bot.mass * EAT_RATIO && distance < 700) {
      moveTowardsEntity(bot, { x: bot.x - (closest.x - bot.x), y: bot.y - (closest.y - bot.y) }, 0.12);
    } else if (bot.mass > closest.mass * EAT_RATIO && distance < 900) {
      moveTowardsEntity(bot, closest, 0.12);
    }
  }

  if (bot.decisionTimer <= 0 || Math.hypot(bot.dx, bot.dy) < 0.05) {
    bot.dx = random(-1, 1);
    bot.dy = random(-1, 1);
    bot.decisionTimer = Math.floor(random(18, 55));
  }

  const length = Math.hypot(bot.dx, bot.dy) || 1;
  const speed = 0.8 + Math.max(0, 70 - bot.mass) / 45;
  bot.x += (bot.dx / length) * speed;
  bot.y += (bot.dy / length) * speed;
  bot.vx *= 0.92;
  bot.vy *= 0.92;
  bot.x += bot.vx;
  bot.y += bot.vy;

  if (bot.x < 0 || bot.x > WORLD.width) {
    bot.dx *= -1;
    bot.x = clamp(bot.x, 0, WORLD.width);
  }
  if (bot.y < 0 || bot.y > WORLD.height) {
    bot.dy *= -1;
    bot.y = clamp(bot.y, 0, WORLD.height);
  }
}

function maintainWorldCounts() {
  ensureWorldPopulation();
}

function applyPlayerInteractions() {
  for (const player of players.values()) {
    if (player.room !== ROOM_NAME) continue;

    player.targetX = clamp(player.targetX, 0, WORLD.width);
    player.targetY = clamp(player.targetY, 0, WORLD.height);
    player.x = clamp(player.x, 0, WORLD.width);
    player.y = clamp(player.y, 0, WORLD.height);

    const playerRadius = getPlayerRadius(player.mass);

    for (let i = sharedWorld.foods.length - 1; i >= 0; i -= 1) {
      const food = sharedWorld.foods[i];
      if (!food) continue;
      const foodRadius = getEntityRadius(food);
      if (Math.hypot(player.x - food.x, player.y - food.y) < playerRadius + foodRadius) {
        player.targetMass += food.points || 1;
        player.mass += food.points || 1;
        respawnFood(i);
      }
    }

    for (let i = sharedWorld.bots.length - 1; i >= 0; i -= 1) {
      const bot = sharedWorld.bots[i];
      if (!bot) continue;
      const botRadius = getPlayerRadius(bot.mass);
      const distance = Math.hypot(player.x - bot.x, player.y - bot.y);
      if (distance >= playerRadius + botRadius * 0.72) continue;

      if (player.mass > bot.mass * EAT_RATIO) {
        player.targetMass += bot.mass * 0.55;
        player.mass += bot.mass * 0.55;
        respawnBot(i);
      }
    }
  }
}

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
    ts: Number.isFinite(Number(packet.ts)) ? Number(packet.ts) : Date.now(),
    targetX: clampX,
    targetY: clampY,
    targetMass: Number.isFinite(mass) ? mass : 20,
    lastSeen: Date.now()
  };
}

function createPublicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    mass: player.mass,
    color: player.color,
    nameColor: player.nameColor,
    fishType: player.fishType,
    mapId: player.mapId,
    dirX: player.dirX,
    dirY: player.dirY,
    skin: player.skin,
    room: player.room,
    ts: player.ts
  };
}

function smoothTowards(current, target, factor) {
  return current + (target - current) * factor;
}

function broadcastState() {
  const now = Date.now();
  for (const player of players.values()) {
    player.x = smoothTowards(player.x, player.targetX, SMOOTHING);
    player.y = smoothTowards(player.y, player.targetY, SMOOTHING);
    player.mass = smoothTowards(player.mass, player.targetMass, SMOOTHING);
    if (now - player.lastSeen > 1500) {
      player.targetX = player.x;
      player.targetY = player.y;
      player.targetMass = player.mass;
    }
  }

  const payload = JSON.stringify({
    type: "state",
    world: WORLD,
    room: ROOM_NAME,
    count: players.size,
    foods: sharedWorld.foods,
    bots: sharedWorld.bots,
    viruses: sharedWorld.viruses,
    players: Array.from(players.values())
      .filter((player) => player.room === ROOM_NAME)
      .map(createPublicPlayer)
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
      const existing = players.get(sessionId);
      if (existing) {
        existing.name = player.name;
        existing.color = player.color;
        existing.nameColor = player.nameColor;
        existing.fishType = player.fishType;
        existing.mapId = player.mapId;
        existing.skin = player.skin;
        existing.dirX = player.dirX;
        existing.dirY = player.dirY;
        existing.ts = player.ts;
        existing.room = ROOM_NAME;
        existing.targetX = player.x;
        existing.targetY = player.y;
        existing.targetMass = player.mass;
        existing.lastSeen = Date.now();
      } else {
        player.id = sessionId;
        player.room = ROOM_NAME;
        players.set(sessionId, player);
      }
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

ensureWorldPopulation();

setInterval(() => {
  maintainWorldCounts();
  for (const bot of sharedWorld.bots) {
    updateBot(bot);
  }
  applyPlayerInteractions();
  const cutoff = Date.now() - 8000;
  for (const [id, player] of players.entries()) {
    if (player.lastSeen < cutoff) {
      players.delete(id);
    }
  }
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
