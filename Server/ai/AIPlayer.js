class AIPlayer {
  constructor(characterId, roomId, roomsCache, ioInstance, getRoomStateFn, CHARACTER_NAMES, CHARACTER_SECRETS, HIDDEN_CLUE_CONTENT, strategy) {
    this.id = 'AI_' + Math.random().toString(36).substring(2, 10);
    this.characterId = characterId; this.roomId = roomId; this.rooms = roomsCache;
    this.io = ioInstance; this.getRoomState = getRoomStateFn;
    this.name = CHARACTER_NAMES[characterId]; this.secrets = CHARACTER_SECRETS[characterId];
    this.lockedClues = ['clue_16', 'clue_17', 'clue_18', 'clue_19'];
    this.strategy = strategy || { cluePriority: [], vote: { round1: null, round2: null }, chat: ['...'] };
    this.timer = null; this._hasInvestigated = false; this._hasVoted = false; this.joinedAt = Date.now();
    this._joinRoom();
  }
  _joinRoom() {
    const room = this.rooms.get(this.roomId);
    if (!room) return;
    room.players[this.id] = { id: this.id, characterId: this.characterId, characterName: this.name, isReady: true, isOnline: true, joinedAt: this.joinedAt, isAI: true };
    this.io.to(this.roomId).emit('room:update', this.getRoomState(room));
  }
  start() { this.timer = setInterval(() => this._checkAndAct(), 3000); }
  _checkAndAct() {
    const room = this.rooms.get(this.roomId);
    if (!room?.players[this.id]) { this.destroy(); return; }
    if (room.phase === 'investigate' && !this._hasInvestigated) { this._hasInvestigated = true; setTimeout(() => this._doInvestigate(), 2000 + Math.random() * 5000); }
    if (room.phase === 'vote' && !this._hasVoted) { this._hasVoted = true; setTimeout(() => this._doVote(), 3000 + Math.random() * 8000); }
    if (room.phase === 'reveal') { this._hasInvestigated = false; this._hasVoted = false; }
  }
  _doInvestigate() {
    const room = this.rooms.get(this.roomId); if (!room) return;
    const revealedIds = room.revealedClues.map(c => c.id);
    const targetId = this.strategy.cluePriority?.find(id => !revealedIds.includes(id) && !(this.lockedClues.includes(id) && this.characterId !== 'lin_qiang'));
    if (!targetId) return;
    room.revealedClues.push({ id: targetId, openedBy: this.id, characterName: this.name });
    this.io.to(this.roomId).emit('clue:revealed', { id: targetId, openedBy: this.id, characterName: this.name });
    this._saySomething();
  }
  _doVote() {
    const room = this.rooms.get(this.roomId); if (!room) return;
    room.votes.round1[this.id] = this.strategy.vote?.round1; room.votes.round2[this.id] = this.strategy.vote?.round2;
    this.io.to(this.roomId).emit('room:update', this.getRoomState(room)); this._saySomething();
  }
  _saySomething() { if (Math.random() > 0.4) return; const msgs = this.strategy.chat || ['...']; this.io.to(this.roomId).emit('chat:public', { from: this.id, characterName: this.name, message: msgs[Math.floor(Math.random() * msgs.length)] }); }
  destroy() { if (this.timer) clearInterval(this.timer); const room = this.rooms.get(this.roomId); if (room?.players[this.id]) { delete room.players[this.id]; ['round1','round2'].forEach(r => delete room.votes[r][this.id]); this.io.to(this.roomId).emit('room:update', this.getRoomState(room)); } }
}
module.exports = { AIPlayer };