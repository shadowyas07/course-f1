const test = require('node:test');
const assert = require('node:assert/strict');

function loadRoomsModule(ttlMs) {
  process.env.ROOM_TTL_MS = String(ttlMs);
  delete require.cache[require.resolve('../server/rooms')];
  return require('../server/rooms');
}

test('joinRoom attribue le slot demandé quand il est libre', () => {
  const rooms = loadRoomsModule(1000);
  const roomId = rooms.createRoom('pc-1');
  const result = rooms.joinRoom(roomId, 2, 'mobile-1');

  assert.equal(result.room.players[2], 'mobile-1');
  assert.equal(result.player, 2);
});

test('cleanupExpiredRooms supprime les rooms trop anciennes', async () => {
  const rooms = loadRoomsModule(1);
  const roomId = rooms.createRoom('pc-1');

  await new Promise((resolve) => setTimeout(resolve, 10));

  const removed = rooms.cleanupExpiredRooms();
  assert.equal(removed, 1);
  assert.equal(rooms.getRoom(roomId), null);
});
