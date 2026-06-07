const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/murder', { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log('[MongoDB] 已连接'))
  .catch(() => console.warn('[MongoDB] 未连接，使用文件系统兜底'));
module.exports = mongoose;