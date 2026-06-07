const express = require('express');
const Script = require('../models/Script');
const router = express.Router();
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';

// 审核剧本
router.post('/scripts/:id/review', async (req, res) => {
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: '无权限' });
  }
  const { action } = req.body; // 'approve' | 'reject'
  if (!['approved', 'rejected'].includes(action)) {
    return res.status(400).json({ success: false, error: '无效的审核操作' });
  }
  await Script.updateOne({ scriptId: req.params.id }, { status: action });
  res.json({ success: true });
});

// 手动刷新剧本缓存（可选）
router.post('/refresh-script/:id', (req, res) => {
  res.json({ success: true, message: '缓存刷新需在 server.js 中实现' });
});

module.exports = router;