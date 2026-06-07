const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const Script = require('../models/Script');
const SCRIPTS_DIR = path.join(__dirname, '../scripts');
if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

router.get('/list', async (req, res) => {
  try {
    const scripts = await Script.find({ status: 'approved' }).select('scriptId title subtitle minPlayers maxPlayers').sort({ createdAt: -1 }).lean();
    if (scripts.length > 0) return res.json({ success: true, scripts: scripts.map(s => ({ id: s.scriptId, title: s.title, subtitle: s.subtitle, minPlayers: s.minPlayers, maxPlayers: s.maxPlayers })) });
  } catch {}
  const files = fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.json'));
  res.json({ success: true, scripts: files.map(f => { const d = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8')); return { id: d.id, title: d.title, subtitle: d.subtitle, minPlayers: d.minPlayers, maxPlayers: d.maxPlayers }; }) });
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await Script.findOne({ scriptId: req.params.id, status: 'approved' });
    if (doc) { const safe = { ...doc.data }; delete safe.secrets; delete safe.hiddenClueContent; return res.json({ success: true, script: safe }); }
  } catch {}
  const fp = path.join(SCRIPTS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ success: false });
  const data = JSON.parse(fs.readFileSync(fp, 'utf8')); const safe = { ...data }; delete safe.secrets; delete safe.hiddenClueContent;
  res.json({ success: true, script: safe });
});

router.post('/upload', express.json({ limit: '2mb' }), async (req, res) => {
  const script = req.body;
  if (!script.id || !script.title || !script.characters || !script.clues || !script.voting) return res.status(400).json({ success: false, error: '缺少必要字段' });
  fs.writeFileSync(path.join(SCRIPTS_DIR, `${script.id}.json`), JSON.stringify(script, null, 2));
  try {
    await Script.findOneAndUpdate({ scriptId: script.id }, { scriptId: script.id, title: script.title, subtitle: script.subtitle || '', minPlayers: script.minPlayers || 3, maxPlayers: script.maxPlayers || 5, data: script, status: script.status || 'approved', updatedAt: Date.now() }, { upsert: true, new: true });
  } catch {}
  res.json({ success: true, id: script.id });
});

module.exports = router;