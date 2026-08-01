/**
 * rooms.js
 * Gestion en mémoire des rooms de jeu.
 * Chaque room associe UN écran PC à DEUX smartphones (joueurs 1 et 2).
 */

const rooms = new Map();
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 15 * 60 * 1000);

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;
  do {
    id = "";
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(id));
  return id;
}

function touchRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) {
    room.updatedAt = Date.now();
  }
  return room;
}

function createRoom(pcSocketId) {
  const roomId = generateRoomId();
  rooms.set(roomId, {
    roomId,
    pcSocketId,
    players: { 1: null, 2: null },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return roomId;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function joinRoom(roomId, requestedPlayer, mobileSocketId) {
  const room = rooms.get(roomId);
  if (!room) return { room: null, player: null };

  let player = requestedPlayer === 2 ? 2 : 1;
  if (room.players[player] && room.players[player] !== mobileSocketId) {
    const other = player === 1 ? 2 : 1;
    if (!room.players[other]) {
      player = other;
    } else {
      return { room: null, player: null };
    }
  }

  room.players[player] = mobileSocketId;
  room.updatedAt = Date.now();
  return { room, player };
}

function findRoomBySocketId(socketId) {
  for (const room of rooms.values()) {
    if (room.pcSocketId === socketId) return { room, role: "pc" };
    if (room.players[1] === socketId) return { room, role: 1 };
    if (room.players[2] === socketId) return { room, role: 2 };
  }
  return { room: null, role: null };
}

function leavePlayer(roomId, player) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.players[player] = null;
  room.updatedAt = Date.now();
}

function deleteRoom(roomId) {
  rooms.delete(roomId);
}

function cleanupExpiredRooms() {
  const now = Date.now();
  let removed = 0;

  for (const [roomId, room] of rooms.entries()) {
    if (now - room.updatedAt > ROOM_TTL_MS) {
      rooms.delete(roomId);
      removed += 1;
    }
  }

  return removed;
}

module.exports = {
  createRoom,
  getRoom,
  joinRoom,
  findRoomBySocketId,
  leavePlayer,
  deleteRoom,
  cleanupExpiredRooms,
  touchRoom,
};
