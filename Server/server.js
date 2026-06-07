const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const xss = require('xss');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 5000 });

app.use(express.static(path.join(__dirname, '../public')));

// ========== 数据库与工具加载 ==========
const { RoomStore, TokenStore, redis, serializeRoom, restoreRoom } = require('./redis');
const { AIPlayer } = require('./ai/AIPlayer');
const { RoomCreateSchema } = require('./validators');
const scriptRoutes = require('./routes/scripts');
const replayRoutes = require('./routes/replay');
const adminRoutes = require('./routes/admin');

require('./db');
const GameLog = require('./models/GameLog');

app.use('/api/scripts', scriptRoutes);
app.use('/api/replay', replayRoutes);
app.use('/api/admin', adminRoutes);

// ========== 剧本缓存（带TTL） ==========
const scriptCache = new Map();

function loadScript(scriptId) {
  const filePath = path.join(__dirname, 'scripts', `${scriptId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getScript(scriptId) {
  const cached = scriptCache.get(scriptId);
  const maxAge = 5 * 60 * 1000;
  if (cached && (Date.now() - cached.loadedAt < maxAge)) return cached.script;
  const script = loadScript(scriptId);
  if (script) scriptCache.set(scriptId, { script, loadedAt: Date.now() });
  return script;
}

function getCharacterNames(script) {
  if (!script) return {};
  const names = {};
  Object.entries(script.characters).forEach(([k, v]) => names[k] = v.name);
  return names;
}

// ========== 房间缓存 ==========
const roomsCache = new Map();

// 限流
const rateLimitMap = new Map();
function checkRate(socketId, event, maxPerSecond = 3) {
  const key = `${socketId}:${event}`;
  const now = Date.now();
  let window = rateLimitMap.get(key) || [];
  window = window.filter(t => now - t < 10000);
  const recent = window.filter(t => now - t < 1000);
  if (recent.length >= maxPerSecond) return false;
  recent.push(now);
  rateLimitMap.set(key, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of rateLimitMap.entries()) {
    if (w.length === 0 || now - w[w.length - 1] > 60000) rateLimitMap.delete(key);
  }
}, 300000);

// ========== 工具函数 ==========
function generateRoomId() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }
function generateToken() { return Math.random().toString(36).substring(2, 14); }

function getRoomState(room) {
  if (!room) return null;
  const playerList = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt);
  return {
    id: room.id, phase: room.phase, hostId: room.host, scriptId: room.scriptId,
    createdAt: room.createdAt,
    aiEnabled: room.aiEnabled || false,
    players: Object.fromEntries(playerList.map(p => [p.id, {
      id: p.id, characterId: p.characterId, characterName: p.characterName,
      isReady: p.isReady, isOnline: p.isOnline, isAI: p.isAI || false
    }])),
    revealedClues: room.revealedClues, phaseDeadline: room.phaseDeadline,
    voteCounts: room.phase === 'vote' ? {
      round1: Object.keys(room.votes.round1).length,
      round2: Object.keys(room.votes.round2).length,
      total: playerList.filter(p => p.isOnline).length
    } : null
  };
}

function advancePhase(room, currentPhase) {
  if (!roomsCache.has(room.id)) return;
  const script = getScript(room.scriptId);
  const durations = script?.phaseDurations || { reading: 10, investigate: 15, vote: 5 };

  switch (currentPhase) {
    case 'reading':
      room.phase = 'investigate';
      startPhaseTimer(room, 'investigate', durations.investigate);
      io.to(room.id).emit('phase:change', 'investigate');
      io.to(room.id).emit('clue:sync', room.revealedClues);
      break;
    case 'investigate':
      room.phase = 'vote';
      startPhaseTimer(room, 'vote', durations.vote);
      io.to(room.id).emit('phase:change', 'vote');
      break;
    case 'vote':
      room.phase = 'reveal';
      clearTimeout(room.phaseTimer);
      room.phaseDeadline = null;
      io.to(room.id).emit('phase:change', 'reveal');
      io.to(room.id).emit('reveal:results', tallyVotes(room));
      io.to(room.id).emit('timer:updated', null);
      saveGameLog(room);
      break;
  }
  io.to(room.id).emit('room:update', getRoomState(room));
  RoomStore.set(room.id, roomsCache.get(room.id)).catch(() => {});
}

function startPhaseTimer(room, phase, minutes) {
  clearTimeout(room.phaseTimer);
  room.phaseDeadline = Date.now() + (minutes || 10) * 60 * 1000;
  room.phaseTimer = setTimeout(() => advancePhase(room, phase), (minutes || 10) * 60 * 1000);
}

function ensureHost(room) {
  const onlinePlayers = Object.values(room.players)
    .filter(p => p.isOnline && !p.isAI)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  if (!room.host || !room.players[room.host] || !room.players[room.host].isOnline) {
    if (onlinePlayers.length > 0) {
      room.host = onlinePlayers[0].id;
      io.to(room.id).emit('host:changed', room.host);
      io.to(room.id).emit('room:update', getRoomState(room));
    }
  }
}

function tallyVotes(room) {
  const countVotes = (votes) => {
    const r = {};
    Object.values(votes).forEach(v => { r[v] = (r[v] || 0) + 1; });
    return r;
  };
  const getTop = (v) => {
    const max = Math.max(...Object.values(v), 0);
    return Object.keys(v).filter(k => v[k] === max);
  };
  const script = getScript(room.scriptId);
  const answers = script?.answers || { round1: '', round2: '' };
  const timeline = script?.timeline || [];

  return {
    round1: { votes: countVotes(room.votes.round1), correct: answers.round1, topVoted: getTop(countVotes(room.votes.round1)) },
    round2: { votes: countVotes(room.votes.round2), correct: answers.round2, topVoted: getTop(countVotes(room.votes.round2)) },
    timeline
  };
}

async function saveGameLog(room) {
  try {
    await GameLog.create({
      roomId: room.id, scriptId: room.scriptId,
      players: Object.values(room.players).map(p => ({
        characterId: p.characterId, characterName: p.characterName, isAI: p.isAI || false
      })),
      revealedClues: room.revealedClues, votes: room.votes,
      duration: Date.now() - (room.createdAt || Date.now())
    });
  } catch (e) { console.warn('游戏日志保存失败', e.message); }
}

// ========== 启动恢复 ==========
(async () => {
  try {
    await redis.connect();
    global.REDIS_DOWN = false;
    const stream = redis.scanStream({ match: 'murder:room:*', count: 100 });
    stream.on('data', async (keys) => {
      for (const key of keys) {
        const roomId = key.replace('murder:room:', '');
        const raw = await RoomStore.get(roomId);
        if (raw) {
          const room = restoreRoom(raw);
          if (room.phaseDeadline && room.phase !== 'lobby' && room.phase !== 'reveal') {
            const remaining = room.phaseDeadline - Date.now();
            if (remaining > 0) {
              room.phaseTimer = setTimeout(() => advancePhase(room, room.phase), remaining);
            } else {
              advancePhase(room, room.phase);
            }
          }
          ensureHost(room);
          roomsCache.set(roomId, room);
        }
      }
    });
    stream.on('end', () => console.log(`从 Redis 恢复了 ${roomsCache.size} 个房间`));
  } catch (e) {
    global.REDIS_DOWN = true;
    console.log('[Redis] 不可用，使用内存模式');
  }
})();

// ========== Socket处理 ==========
io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  socket.on('reconnect:try', async (token, callback) => {
    const info = await TokenStore.get(token);
    if (!info) return callback({ success: false });
    const room = roomsCache.get(info.roomId) || await RoomStore.get(info.roomId);
    if (!room) return callback({ success: false });
    const player = room.players[info.socketId];
    if (!player) return callback({ success: false });

    const oldId = info.socketId;
    room.players[socket.id] = { ...player, id: socket.id, isOnline: true };
    delete room.players[oldId];
    await TokenStore.set(token, { roomId: info.roomId, socketId: socket.id });
    roomsCache.set(info.roomId, room);

    ['round1', 'round2'].forEach(r => {
      if (room.votes[r][oldId]) { room.votes[r][socket.id] = room.votes[r][oldId]; delete room.votes[r][oldId]; }
    });

    if (room.host === oldId) { room.host = socket.id; io.to(info.roomId).emit('host:changed', socket.id); }
    ensureHost(room);

    socket.join(info.roomId);
    socket.data.roomId = info.roomId;
    socket.data.characterId = player.characterId;

    callback({
      success: true, characterId: player.characterId, phase: room.phase,
      myVotes: { round1: room.votes.round1[socket.id] || null, round2: room.votes.round2[socket.id] || null }
    });

    if (room.phase !== 'lobby' && room.phase !== 'reveal' && room.phaseDeadline) {
      const remaining = room.phaseDeadline - Date.now();
      clearTimeout(room.phaseTimer);
      if (remaining > 0) room.phaseTimer = setTimeout(() => advancePhase(room, room.phase), remaining);
      else advancePhase(room, room.phase);
    }

    io.to(info.roomId).emit('room:update', getRoomState(room));
    if (room.phase !== 'lobby') {
      socket.emit('phase:change', room.phase);
      if (!player.isAI) {
        const script = getScript(room.scriptId);
        socket.emit('secret:deliver', script?.secrets?.[player.characterId] || {});
      }
      socket.emit('clue:sync', room.revealedClues);
    }
  });

  // ==================== 创建房间（修复后） ====================
  socket.on('room:create', async (options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const parsed = RoomCreateSchema.safeParse(options);
    if (!parsed.success) return callback({ success: false, error: '参数无效' });

    const scriptId = parsed.data.scriptId || 'default';
    const script = getScript(scriptId);
    if (!script) return callback({ success: false, error: '剧本不存在' });

    const roomId = generateRoomId();
    const token = generateToken();
    const room = {
      id: roomId, host: socket.id, players: {}, phase: 'lobby', scriptId,
      revealedClues: [], votes: { round1: {}, round2: {} },
      phaseDeadline: null, aiEnabled: false, phaseTimer: null, createdAt: Date.now()
    };

    // 将创建者自动加入玩家列表
    room.players[socket.id] = {
      id: socket.id,
      characterId: null,
      characterName: '待选择',
      isReady: false,
      isOnline: true,
      joinedAt: Date.now(),
      isAI: false
    };

    roomsCache.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    await TokenStore.set(token, { roomId, socketId: socket.id });
    await RoomStore.set(roomId, room);

    // 创建房间后立即广播房间状态
    io.to(roomId).emit('room:update', getRoomState(room));

    callback({ success: true, roomId, token });
  });

  socket.on('room:join', async (roomId, callback) => {
    const room = roomsCache.get(roomId);
    if (!room) return callback({ success: false, error: '房间不存在' });
    if (Object.values(room.players).filter(p => p.isOnline).length >= 5) return callback({ success: false, error: '房间已满' });
    const token = generateToken();
    socket.join(roomId);
    socket.data.roomId = roomId;
    await TokenStore.set(token, { roomId, socketId: socket.id });
    callback({ success: true, token });
  });

  socket.on('player:select', (characterId) => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room) return;
    const script = getScript(room.scriptId);
    if (!script?.characters?.[characterId]) return socket.emit('error', '无效角色');
    if (Object.values(room.players).some(p => p.characterId === characterId && p.isOnline)) return socket.emit('error', '该角色已被选择');
    room.players[socket.id] = {
      id: socket.id, characterId, characterName: script.characters[characterId].name,
      isReady: false, isOnline: true, joinedAt: Date.now(), isAI: false
    };
    socket.data.characterId = characterId;
    io.to(socket.data.roomId).emit('room:update', getRoomState(room));
  });

  // ==================== 关键修复：player:ready 事件 ====================
  socket.on('player:ready', () => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room?.players[socket.id]) return;
    room.players[socket.id].isReady = true;

    const onlinePlayers = Object.values(room.players).filter(p => p.isOnline);
    const humanPlayers = onlinePlayers.filter(p => !p.isAI);
    const allHumansReady = humanPlayers.every(p => p.isReady);

    // 如果开启了AI补位，并且所有真人玩家都准备了，就先创建AI再开始游戏
    if (room.aiEnabled && allHumansReady && humanPlayers.length >= 1) {
      const script = getScript(room.scriptId);
      const takenChars = onlinePlayers.map(p => p.characterId).filter(Boolean);
      const availableChars = Object.keys(script.characters).filter(c => !takenChars.includes(c));

      // 用AI填充剩余角色
      availableChars.forEach(charId => {
        const ai = new AIPlayer(
          charId, room.id, roomsCache, io, getRoomState,
          getCharacterNames(script), script.secrets, script.hiddenClueContent,
          script.aiStrategies?.[charId] || {}
        );
        ai.start();
      });

      // 开始游戏
      startGame(room, script);
    } else if (!room.aiEnabled && allHumansReady && humanPlayers.length >= 3) {
      startGame(room, getScript(room.scriptId));
    }

    io.to(socket.data.roomId).emit('room:update', getRoomState(room));
  });

  function startGame(room, script) {
    room.phase = 'reading';
    Object.values(room.players).filter(p => p.isOnline).forEach(p => {
      if (!p.isAI) io.to(p.id).emit('secret:deliver', script.secrets[p.characterId]);
    });
    startPhaseTimer(room, 'reading', script.phaseDurations?.reading || 10);
    io.to(room.id).emit('phase:change', 'reading');
  }

  // ==================== 其余事件处理保持不变 ====================
  socket.on('secret:request', () => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room) return;
    const script = getScript(room.scriptId);
    const cid = socket.data.characterId;
    if (cid && script?.secrets?.[cid]) socket.emit('secret:deliver', script.secrets[cid]);
  });

  socket.on('phase:investigate', () => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    room.phase = 'investigate';
    const script = getScript(room.scriptId);
    startPhaseTimer(room, 'investigate', script?.phaseDurations?.investigate || 15);
    io.to(socket.data.roomId).emit('phase:change', 'investigate');
    io.to(socket.data.roomId).emit('clue:sync', room.revealedClues);
  });

  socket.on('clue:reveal', (clueId) => {
    if (!checkRate(socket.id, 'clue', 3)) return;
    const room = roomsCache.get(socket.data.roomId);
    if (!room) return;
    if (!room.revealedClues.find(c => c.id === clueId)) {
      room.revealedClues.push({ id: clueId, openedBy: socket.id, characterName: room.players[socket.id]?.characterName || '未知' });
      io.to(socket.data.roomId).emit('clue:revealed', room.revealedClues[room.revealedClues.length - 1]);
    }
  });

  socket.on('linqiang:crack', () => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || player.characterId !== 'lin_qiang') return;
    const script = getScript(room.scriptId);
    Object.keys(script?.hiddenClueContent || {}).forEach(id => {
      if (!room.revealedClues.find(c => c.id === id)) room.revealedClues.push({ id, openedBy: socket.id, characterName: '林强' });
    });
    io.to(socket.id).emit('hidden:content', script.hiddenClueContent);
    io.to(socket.data.roomId).emit('clue:sync', room.revealedClues);
  });

  socket.on('phase:vote', () => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    room.phase = 'vote';
    const script = getScript(room.scriptId);
    startPhaseTimer(room, 'vote', script?.phaseDurations?.vote || 5);
    io.to(socket.data.roomId).emit('phase:change', 'vote');
    io.to(socket.data.roomId).emit('room:update', getRoomState(room));
  });

  socket.on('vote:cast', (round, characterId) => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room) return;
    room.votes[round][socket.id] = characterId;
    io.to(socket.id).emit('vote:confirmed', { round, characterId });
    io.to(socket.data.roomId).emit('room:update', getRoomState(room));
  });

  socket.on('phase:reveal', () => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    room.phase = 'reveal';
    clearTimeout(room.phaseTimer);
    room.phaseDeadline = null;
    io.to(socket.data.roomId).emit('phase:change', 'reveal');
    io.to(socket.data.roomId).emit('reveal:results', tallyVotes(room));
    io.to(socket.data.roomId).emit('timer:updated', null);
    saveGameLog(room);
  });

  socket.on('timer:extend', (minutes) => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room || room.host !== socket.id || !room.phaseDeadline || room.phase === 'reveal') return;
    room.phaseDeadline += (minutes || 5) * 60 * 1000;
    clearTimeout(room.phaseTimer);
    room.phaseTimer = setTimeout(() => advancePhase(room, room.phase), room.phaseDeadline - Date.now());
    io.to(socket.data.roomId).emit('timer:updated', room.phaseDeadline);
  });

  socket.on('room:enableAI', (enabled) => {
    const room = roomsCache.get(socket.data.roomId);
    if (!room || room.host !== socket.id) return;
    room.aiEnabled = enabled;
    io.to(socket.data.roomId).emit('room:update', getRoomState(room));
  });

  socket.on('chat:public', (raw) => {
    if (!checkRate(socket.id, 'chat', 2)) return;
    const room = roomsCache.get(socket.data.roomId);
    if (!room) return;
    const message = xss(raw, { whiteList: {} });
    io.to(socket.data.roomId).emit('chat:public', { from: socket.id, characterName: room.players[socket.id]?.characterName || '未知', message });
  });

  socket.on('chat:private', (target, raw) => {
    if (!checkRate(socket.id, 'chat', 2)) return;
    const room = roomsCache.get(socket.data.roomId);
    if (!room?.players[target]) return;
    const message = xss(raw, { whiteList: {} });
    const sender = room.players[socket.id];
    [socket.id, target].forEach(id => io.to(id).emit('chat:private', { from: socket.id, to: target, message, characterName: sender?.characterName }));
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = roomsCache.get(roomId);
    if (!room?.players[socket.id]) return;
    room.players[socket.id].isOnline = false;
    io.to(roomId).emit('room:update', getRoomState(room));

    setTimeout(() => {
      const freshRoom = roomsCache.get(roomId);
      if (!freshRoom) return;
      const p = freshRoom.players[socket.id];
      if (p && !p.isOnline) {
        ['round1', 'round2'].forEach(r => delete freshRoom.votes[r][socket.id]);
        delete freshRoom.players[socket.id];
        ensureHost(freshRoom);
        if (Object.values(freshRoom.players).filter(x => x.isOnline).length === 0) {
          roomsCache.delete(roomId);
          RoomStore.delete(roomId);
        } else {
          io.to(roomId).emit('room:update', getRoomState(freshRoom));
        }
      }
    }, 30000);
  });
});

// ========== 定时快照与健康检查 ==========
setInterval(async () => {
  for (const [roomId, room] of roomsCache.entries()) {
    await RoomStore.set(roomId, room).catch(() => {});
  }
}, 30000);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', redis: !global.REDIS_DOWN, rooms: roomsCache.size, uptime: process.uptime() });
});

app.get('/api/stats', async (req, res) => {
  const totalGames = await GameLog.countDocuments().catch(() => 0);
  res.json({ activeRooms: roomsCache.size, totalGames, redisStatus: !global.REDIS_DOWN });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[服务器] http://localhost:${PORT}`));