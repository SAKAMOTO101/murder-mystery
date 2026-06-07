const express = require('express');
const GameLog = require('../models/GameLog');
const router = express.Router();
router.get('/:roomId', async (req, res) => {
  try { const log = await GameLog.findOne({ roomId: req.params.roomId }); if (!log) return res.status(404).json({ error: '记录不存在' }); res.json({ success: true, replay: log }); }
  catch { res.json({ success: true, replay: null }); }
});
module.exports = router;