import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const TICK_RATE_MS = 50;
const WORLD = { width: 4200, height: 3600 };
const FOOD_COUNT = 700;
const BOT_COUNT = 40;
const VIRUS_COUNT = 18;
const START_MASS = 20;
const VIRUS_MASS = 60;
const EAT_RATIO = 1.15;
const HAZARD_RESPAWN_MARGIN = 180;
const SPLIT_TUNING = {
  MAX_PARTS: 16,
  MIN_MASS: 30,
  LAUNCH_SPEED: 14,
  LAUNCH_DISTANCE: 1.75,
  MERGE_TIMER: 300
};

const MAPS = {
  reef: {
    world: { width: 4200, height: 3600 },
    hazard: { kind: "urchin", color: "#22c55e", glow: "#bbf7d0" },
    botNames: ["Diver", "Manta", "Tide", "Breeze", "Shell", "Ripple", "Shore", "Glow"],
    botColors: ["#38bdf8", "#22c55e", "#fbbf24", "#a78bfa", "#f97316", "#f472b6"]
  },
  scrap: {
    world: { width: 4600, height: 3400 },
    hazard: { kind: "reefMine", color: "#ef4444", glow: "#fecaca" },
    botNames: ["Drone", "Rust", "Relay", "Spark", "Gauge", "Patch", "Grinder", "Node"],
    botColors: ["#fbbf24", "#38bdf8", "#f97316", "#9ca3af", "#ef4444", "#22c55e"]
  },
  ember: {
    world: { width: 4000, height: 4000 },
    hazard: { kind: "coralMine", color: "#f59e0b", glow: "#fed7aa" },
    botNames: ["Ash", "Cinder", "Flint", "Nova", "Pike", "Rune", "Echo", "Blaze"],
    botColors: ["#fb7185", "#f97316", "#facc15", "#ef4444", "#f8fafc", "#c084fc"]
  }
};

const FOOD_CHAIN = [
  { kind: "shrimp", points: 1, weight: 40, hitR: 8, drawScale: 1.0 },
  { kind: "mussle", points: 1, weight: 30, hitR: 8.5, drawScale: 0.95 },
  { kind: "crab", points: 2, weight: 20, hitR: 11, drawScale: 0.92 },
  { kind: "seahorse", points: 3, weight: 10, hitR: 13, drawScale: 0.9 }
];

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
const playersById = new Map();
const rooms = new Map();
const socketMeta = new Map();

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
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
    mapId,
    map,
    world: { ...map.world },
    players: new Map(),
    foods: [],
    bots: [],
    viruses: [],
    pellets: [],
    tick: 0
  };

  for (let i = 0; i < FOOD_COUNT; i++) room.foods.push(createFood(room));
  for (let i = 0; i < BOT_COUNT; i++) room.bots.push(createBot(room));
  for (let i = 0; i < VIRUS_COUNT; i++) room.viruses.push(createVirus(room));

  rooms.set(roomKey, room);
  return room;
}

function pickWeightedFood() {
  const total = FOOD_CHAIN.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of FOOD_CHAIN) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return FOOD_CHAIN[0];
}

function createFood(room) {
  const style = pickWeightedFood();
  return {
    kind: style.kind,
    x: rand(0, room.world.width),
    y: rand(0, room.world.height),
    r: rand(4, 6),
    hitR: style.hitR,
    points: style.points,
    drawScale: style.drawScale
  };
}

function createVirus(room) {
  return {
    kind: room.map.hazard.kind,
    x: rand(HAZARD_RESPAWN_MARGIN, room.world.width - HAZARD_RESPAWN_MARGIN),
    y: rand(HAZARD_RESPAWN_MARGIN, room.world.height - HAZARD_RESPAWN_MARGIN),
    mass: VIRUS_MASS,
    r: radiusFromMass(VIRUS_MASS),
    color: room.map.hazard.color,
    glow: room.map.hazard.glow,
    eaten: 0
  };
}

function createBot(room) {
  const mass = rand(20, 65);
  return {
    id: `bot-${Math.random().toString(36).slice(2, 10)}`,
    name: pick(room.map.botNames),
    x: rand(0, room.world.width),
    y: rand(0, room.world.height),
    mass,
    color: pick(room.map.botColors),
    fishType: "pufferfish",
    dx: rand(-1, 1),
    dy: rand(-1, 1),
    changeTimer: rand(40, 160),
    decisionTimer: rand(15, 45),
    splitCooldown: rand(120, 260),
    vx: 0,
    vy: 0
  };
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
    splitRequested: false,
    fireRequested: false,
    splitCooldown: 0,
    fireCooldown: 0
  };
}

function findSafeSpawn(room, spread = 220) {
  for (let i = 0; i < 40; i++) {
    const candidate = {
      x: rand(spread, room.world.width - spread),
      y: rand(spread, room.world.height - spread)
    };
    const tooClose = [...room.viruses, ...room.bots, ...room.players.values()].some((entity) => {
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

function firePellet(player, room) {
  if (player.dead) return false;
  const part = getMainPart(player);
  if (!part || part.mass < 24) return false;
  const move = normalize(player.moveX || player.dirX || 1, player.moveY || player.dirY || 0);
  part.mass -= 3;
  const radius = radiusFromMass(part.mass);
  room.pellets.push({
    x: part.x + move.x * (radius + 16),
    y: part.y + move.y * (radius + 16),
    vx: move.x * 12,
    vy: move.y * 12,
    mass: 3,
    life: 150,
    color: "#facc15"
  });
  updatePlayerCenter(player);
  return true;
}

function explodeOnVirus(player, part, virus) {
  if (player.dead) return false;
  if (part.mass <= VIRUS_MASS * EAT_RATIO || player.parts.length >= SPLIT_TUNING.MAX_PARTS) return false;
  const totalMass = part.mass;
  const amount = Math.min(
    SPLIT_TUNING.MAX_PARTS - player.parts.length + 1,
    Math.max(4, Math.floor(totalMass / 35))
  );
  const partMass = totalMass / amount;
  const index = player.parts.indexOf(part);
  if (index !== -1) player.parts.splice(index, 1);

  for (let i = 0; i < amount; i++) {
    const angle = (Math.PI * 2 * i) / amount;
    player.parts.push({
      x: part.x + Math.cos(angle) * 18,
      y: part.y + Math.sin(angle) * 18,
      mass: partMass,
      vx: Math.cos(angle) * 8,
      vy: Math.sin(angle) * 8,
      mergeTimer: 300
    });
  }

  virus.x = rand(HAZARD_RESPAWN_MARGIN, room.world.width - HAZARD_RESPAWN_MARGIN);
  virus.y = rand(HAZARD_RESPAWN_MARGIN, room.world.height - HAZARD_RESPAWN_MARGIN);
  virus.eaten = 0;
  updatePlayerCenter(player);
  return true;
}

function setBotDirection(bot, dx, dy, sharpness = 0.7) {
  const next = normalize(dx, dy);
  bot.dx = bot.dx * (1 - sharpness) + next.x * sharpness;
  bot.dy = bot.dy * (1 - sharpness) + next.y * sharpness;
}

function botSplitToward(bot, target, room) {
  const dx = target.x - bot.x;
  const dy = target.y - bot.y;
  const next = normalize(dx, dy);
  const splitMass = bot.mass / 2;
  bot.mass = splitMass;
  room.bots.push({
    id: `bot-${Math.random().toString(36).slice(2, 10)}`,
    name: bot.name,
    x: bot.x + next.x * 18,
    y: bot.y + next.y * 18,
    mass: splitMass,
    color: bot.color,
    fishType: bot.fishType,
    dx: next.x,
    dy: next.y,
    changeTimer: 60,
    decisionTimer: 20,
    splitCooldown: 220,
    vx: next.x * 12,
    vy: next.y * 12
  });
  bot.splitCooldown = 220;
}

function decideBotBehavior(bot, room) {
  let threat = null;
  let threatDistance = Infinity;
  let prey = null;
  let preyScore = -Infinity;

  const targets = [...room.players.values()].flatMap((player) =>
    player.parts.map((part) => ({ ...part, owner: player, type: "player" }))
  );

  for (const target of targets) {
    const distance = Math.hypot(target.x - bot.x, target.y - bot.y);
    if (target.mass > bot.mass * EAT_RATIO && distance < 520 && distance < threatDistance) {
      threat = target;
      threatDistance = distance;
    }
    if (bot.mass > target.mass * EAT_RATIO && distance < 850) {
      const score = target.mass - distance * 0.08;
      if (score > preyScore) {
        prey = target;
        preyScore = score;
      }
    }
  }

  let nearbyVirus = null;
  let nearbyVirusDistance = Infinity;
  if (bot.mass > VIRUS_MASS * EAT_RATIO) {
    for (const virus of room.viruses) {
      const distance = Math.hypot(virus.x - bot.x, virus.y - bot.y);
      if (distance < nearbyVirusDistance) {
        nearbyVirus = virus;
        nearbyVirusDistance = distance;
      }
    }
  }

  if (nearbyVirus && nearbyVirusDistance < 180) {
    setBotDirection(bot, bot.x - nearbyVirus.x, bot.y - nearbyVirus.y, 0.85);
    return;
  }
  if (threat && threatDistance < 520) {
    setBotDirection(bot, bot.x - threat.x, bot.y - threat.y, 0.9);
    return;
  }
  if (prey) {
    setBotDirection(bot, prey.x - bot.x, prey.y - bot.y, 0.75);
    const distance = Math.hypot(prey.x - bot.x, prey.y - bot.y);
    if (bot.splitCooldown <= 0 && bot.mass >= 45 && bot.mass / 2 > prey.mass * EAT_RATIO && distance < 340) {
      botSplitToward(bot, prey, room);
    }
    return;
  }

  let foodTarget = null;
  let foodDistance = Infinity;
  for (const food of room.foods) {
    const distance = Math.hypot(food.x - bot.x, food.y - bot.y);
    if (distance < foodDistance && distance < 480) {
      foodTarget = food;
      foodDistance = distance;
    }
  }
  if (foodTarget) {
    setBotDirection(bot, foodTarget.x - bot.x, foodTarget.y - bot.y, 0.6);
    return;
  }

  if (bot.changeTimer <= 0 || Math.random() < 0.25) {
    setBotDirection(bot, rand(-1, 1), rand(-1, 1), 0.35);
    bot.changeTimer = rand(50, 150);
  } else {
    bot.changeTimer--;
  }
}

function updateBots(room) {
  for (const bot of room.bots) {
    bot.splitCooldown--;
    bot.decisionTimer--;
    if (bot.decisionTimer <= 0) {
      decideBotBehavior(bot, room);
      bot.decisionTimer = rand(18, 55);
    }
    const length = Math.hypot(bot.dx, bot.dy) || 1;
    const speed = speedFromMass(bot.mass);
    bot.x += (bot.dx / length) * speed;
    bot.y += (bot.dy / length) * speed;
    bot.x += bot.vx || 0;
    bot.y += bot.vy || 0;
    bot.vx = (bot.vx || 0) * 0.92;
    bot.vy = (bot.vy || 0) * 0.92;
    if (bot.x < 0 || bot.x > room.world.width) bot.dx *= -1;
    if (bot.y < 0 || bot.y > room.world.height) bot.dy *= -1;
    bot.x = Math.max(0, Math.min(room.world.width, bot.x));
    bot.y = Math.max(0, Math.min(room.world.height, bot.y));
  }
}

function updatePellets(room) {
  for (let i = room.pellets.length - 1; i >= 0; i--) {
    const pellet = room.pellets[i];
    pellet.x += pellet.vx;
    pellet.y += pellet.vy;
    pellet.vx *= 0.96;
    pellet.vy *= 0.96;
    pellet.life--;
    pellet.x = Math.max(0, Math.min(room.world.width, pellet.x));
    pellet.y = Math.max(0, Math.min(room.world.height, pellet.y));

    let hit = false;
    for (const bot of room.bots) {
      if (Math.hypot(bot.x - pellet.x, bot.y - pellet.y) < radiusFromMass(bot.mass)) {
        bot.mass += pellet.mass;
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const player of room.players.values()) {
        for (const part of player.parts) {
          if (Math.hypot(part.x - pellet.x, part.y - pellet.y) < radiusFromMass(part.mass)) {
            part.mass += pellet.mass;
            updatePlayerCenter(player);
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
    }

    if (hit || pellet.life <= 0) room.pellets.splice(i, 1);
  }
}

function updateFoods(room) {
  for (const player of room.players.values()) {
    if (player.dead) continue;
    for (const part of player.parts) {
      const playerRadius = radiusFromMass(part.mass);
      for (let i = room.foods.length - 1; i >= 0; i--) {
        const food = room.foods[i];
        const foodRadius = food.hitR || food.r;
        if (Math.hypot(part.x - food.x, part.y - food.y) < playerRadius + foodRadius) {
          room.foods[i] = createFood(room);
          part.mass += food.points || 1;
        }
      }
    }
  }

  for (const bot of room.bots) {
    const botRadius = radiusFromMass(bot.mass);
    for (let i = room.foods.length - 1; i >= 0; i--) {
      const food = room.foods[i];
      const foodRadius = food.hitR || food.r;
      if (Math.hypot(bot.x - food.x, bot.y - food.y) < botRadius + foodRadius) {
        room.foods[i] = createFood(room);
        bot.mass += food.points || 1;
      }
    }
  }
}

function updateViruses(room) {
  for (const virus of room.viruses) {
    for (const player of room.players.values()) {
      for (const part of [...player.parts]) {
        if (Math.hypot(part.x - virus.x, part.y - virus.y) < radiusFromMass(part.mass) + virus.r && part.mass > VIRUS_MASS * EAT_RATIO) {
          virus.eaten += 0.5;
          if (virus.eaten >= VIRUS_MASS / 3) {
            explodeOnVirus(player, part, virus);
            break;
          }
        }
      }
    }
    for (const bot of room.bots) {
      if (Math.hypot(bot.x - virus.x, bot.y - virus.y) < radiusFromMass(bot.mass) + virus.r && bot.mass > VIRUS_MASS * EAT_RATIO) {
        virus.eaten += 0.5;
        if (virus.eaten >= VIRUS_MASS / 3) {
          bot.mass = Math.max(START_MASS, bot.mass / 2);
          bot.x = rand(HAZARD_RESPAWN_MARGIN, room.world.width - HAZARD_RESPAWN_MARGIN);
          bot.y = rand(HAZARD_RESPAWN_MARGIN, room.world.height - HAZARD_RESPAWN_MARGIN);
          virus.eaten = 0;
          break;
        }
      }
    }
  }
}

function resolveEntityCollisions(room) {
  for (const bot of room.bots) {
    for (const player of room.players.values()) {
      if (player.dead) continue;
      for (let j = player.parts.length - 1; j >= 0; j--) {
        const part = player.parts[j];
        const distance = Math.hypot(part.x - bot.x, part.y - bot.y);
        const botRadius = radiusFromMass(bot.mass);
        const playerRadius = radiusFromMass(part.mass);
        if (distance < Math.max(playerRadius, botRadius) * 0.75) {
          if (part.mass > bot.mass * EAT_RATIO) {
            part.mass += bot.mass * 0.55;
            bot.mass = rand(20, 65);
            bot.x = rand(0, room.world.width);
            bot.y = rand(0, room.world.height);
            updatePlayerCenter(player);
          } else if (bot.mass > part.mass * EAT_RATIO) {
            bot.mass += part.mass * 0.55;
            player.parts.splice(j, 1);
            if (!player.parts.length) {
              player.dead = true;
              player.parts = [];
              player.mass = 0;
            } else {
              updatePlayerCenter(player);
            }
          }
        }
      }
    }
  }

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
  for (const bot of room.bots) {
    const decay = apply(bot.mass) / 60;
    if (decay > 0) bot.mass = Math.max(START_MASS, bot.mass - decay);
  }
}

function maintainBotCount(room) {
  while (room.bots.length < BOT_COUNT) room.bots.push(createBot(room));
  while (room.bots.length > BOT_COUNT) room.bots.pop();
}

function serializeRoom(room) {
  return {
    type: "state",
    world: room.world,
    room: room.key,
    mapId: room.mapId,
    tick: room.tick,
    foods: room.foods,
    bots: room.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      x: bot.x,
      y: bot.y,
      mass: bot.mass,
      color: bot.color,
      fishType: bot.fishType,
      dx: bot.dx,
      dy: bot.dy
    })),
    viruses: room.viruses,
    pellets: room.pellets,
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

function stepRoom(room) {
  room.tick++;
  for (const player of room.players.values()) {
    player.splitCooldown = Math.max(0, player.splitCooldown - 1);
    player.fireCooldown = Math.max(0, player.fireCooldown - 1);
    if (player.splitRequested) {
      splitPlayer(player);
      player.splitRequested = false;
    }
    if (player.fireRequested) {
      firePellet(player, room);
      player.fireRequested = false;
    }
    movePlayer(player, room);
  }
  updateBots(room);
  updatePellets(room);
  updateFoods(room);
  updateViruses(room);
  resolveEntityCollisions(room);
  applyMassDecay(room);
  maintainBotCount(room);
}

wss.on("connection", (ws) => {
  const sessionId = `p-${Math.random().toString(36).slice(2, 10)}`;
  ws.isAlive = true;
  socketMeta.set(ws, { sessionId, roomKey: null });

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
        message: "Player registered."
      }));
      broadcastRoom(room);
      return;
    }

    if (packet.type === "action") {
      const player = playersById.get(sessionId);
      if (!player) return;
      const room = rooms.get(meta.roomKey);
      if (!room) return;
      if (packet.action === "split" && player.splitCooldown <= 0) {
        if (splitPlayer(player)) player.splitCooldown = 24;
      }
      if (packet.action === "fire" && player.fireCooldown <= 0) {
        if (firePellet(player, room)) player.fireCooldown = 6;
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
