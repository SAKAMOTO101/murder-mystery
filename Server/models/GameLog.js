const mongoose = require('mongoose');
const gameLogSchema = new mongoose.Schema({
  roomId: String, scriptId: String,
  players: [{ characterId: String, characterName: String, isAI: Boolean }],
  revealedClues: [{ id: String, openedBy: String }],
  votes: Object, duration: Number, createdAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('GameLog', gameLogSchema);