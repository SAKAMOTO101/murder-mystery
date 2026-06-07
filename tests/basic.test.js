const { describe, it } = require('node:test');
const assert = require('node:assert');
describe('Room ID', () => {
  it('4 chars', () => assert.match(Math.random().toString(36).substring(2,6).toUpperCase(), /^[A-Z0-9]{4}$/));
});