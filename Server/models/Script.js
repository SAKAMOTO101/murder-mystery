const mongoose = require('mongoose');
const scriptSchema = new mongoose.Schema({
  scriptId: { type: String, unique: true, required: true },
  title: String, subtitle: String, minPlayers: Number, maxPlayers: Number,
  data: Object,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
  createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('Script', scriptSchema);