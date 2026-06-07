// 纯内存存储，无需 Redis
const memoryStore = new Map();

const RoomStore = {
  async get(roomId) { return memoryStore.get(roomId) || null; },
  async set(roomId, room) { memoryStore.set(roomId, room); },
  async delete(roomId) { memoryStore.delete(roomId); }
};

const TokenStore = {
  async get(token) { return memoryStore.get(`token:${token}`) || null; },
  async set(token, info) { memoryStore.set(`token:${token}`, info); },
  async delete(token) { memoryStore.delete(`token:${token}`); }
};

// 兼容之前的导出
function serializeRoom(room) {
  const clone = { ...room };
  delete clone.phaseTimer;
  clone._players = Object.fromEntries(
    Object.entries(room.players || {}).map(([id, p]) => [id, {
      id: p.id, characterId: p.characterId, characterName: p.characterName,
      isReady: p.isReady, isOnline: false, isAI: p.isAI || false, joinedAt: p.joinedAt
    }])
  );
  clone.votes = room.votes || { round1: {}, round2: {} };
  clone.revealedClues = room.revealedClues || [];
  return clone;
}

function restoreRoom(raw) {
  const room = { ...raw, players: raw._players || {}, phaseTimer: null, phaseDeadline: raw.phaseDeadline || null };
  delete room._players;
  return room;
}

// redis 对象不再需要，但保留一个空对象防止引用报错
const redis = {
  scanStream() { return { on() {} }; },
  connect() { return Promise.reject(); }
};
global.REDIS_DOWN = true; // 直接标记为不可用

module.exports = { redis, RoomStore, TokenStore, serializeRoom, restoreRoom };