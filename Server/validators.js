const { z } = require('zod');
const RoomCreateSchema = z.object({ scriptId: z.string().min(1).max(50).default('default') });
module.exports = { RoomCreateSchema };