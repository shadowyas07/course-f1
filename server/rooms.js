/**
 * rooms.js
 * Gestion en memoire des rooms de jeu.
 * Chaque room associe UN écran PC (pilote du jeu) à DEUX smartphones (manettes
 * joueur 1 et joueur 2), pour une course 1 vs 1.
 *
 * Structure d'une room :
 * {
 *   roomId: string,
 *   pcSocketId: string | null,
 *   players: { 1: string|null, 2: string|null },  // socketId de chaque manette
 *   createdAt: number
 * }
 */

const rooms = new Map();

/**
 * Génère un identifiant de room court et lisible (utile pour du debug),
 * ex: "7F3K9A"
 */
function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans caractères ambigus (0,O,1,I)
  let id;
  do {
    id = "";
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(id));
  return id;
}

/**
 * Crée une nouvelle room associée à un socket PC.
 */
function createRoom(pcSocketId) {
  const roomId = generateRoomId();
  rooms.set(roomId, {
    roomId,
    pcSocketId,
    players: { 1: null, 2: null },
    createdAt: Date.now(),
  });
  return roomId;
}

/**
 * Récupère une room par son id.
 */
function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

/**
 * Associe un socket mobile à un slot joueur (1 ou 2) d'une room existante.
 * - Si le slot demandé est libre, on l'attribue.
 * - S'il est déjà pris (ex: reconnexion ou lien copié par erreur), on bascule
 *   automatiquement sur l'autre slot s'il est libre.
 * Retourne { room, player } ou { room: null, player: null } si impossible.
 */
function joinRoom(roomId, requestedPlayer, mobileSocketId) {
  const room = rooms.get(roomId);
  if (!room) return { room: null, player: null };

  let player = requestedPlayer === 2 ? 2 : 1;
  if (room.players[player] && room.players[player] !== mobileSocketId) {
    const other = player === 1 ? 2 : 1;
    if (!room.players[other]) {
      player = other;
    } else {
      return { room: null, player: null }; // les deux slots sont occupés
    }
  }

  room.players[player] = mobileSocketId;
  return { room, player };
}

/**
 * Retrouve la room + le rôle ("pc" | 1 | 2) d'un socket donné.
 */
function findRoomBySocketId(socketId) {
  for (const room of rooms.values()) {
    if (room.pcSocketId === socketId) return { room, role: "pc" };
    if (room.players[1] === socketId) return { room, role: 1 };
    if (room.players[2] === socketId) return { room, role: 2 };
  }
  return { room: null, role: null };
}

/**
 * Libère le slot d'un joueur (déconnexion) sans supprimer la room.
 */
function leavePlayer(roomId, player) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.players[player] = null;
}

/**
 * Supprime une room (ex: quand le PC se déconnecte).
 */
function deleteRoom(roomId) {
  rooms.delete(roomId);
}

module.exports = {
  createRoom,
  getRoom,
  joinRoom,
  findRoomBySocketId,
  leavePlayer,
  deleteRoom,
};
