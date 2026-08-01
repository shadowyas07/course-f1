/**
 * server.js
 * Serveur Express + Socket.io pour le jeu de course 3D controlé par smartphone.
 *
 * Rôles :
 *  - Sert les pages statiques PC (/) et Mobile (/mobile)
 *  - Gère la création de room quand le PC se connecte
 *  - Génère un QR code pointant vers l'IP locale + la room
 *  - Relaye les inputs (volant, accélérateur, frein) du mobile vers le PC
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const {
  createRoom,
  getRoom,
  joinRoom,
  leavePlayer,
  deleteRoom,
  cleanupExpiredRooms,
  touchRoom,
} = require("./rooms");

const PORT = process.env.PORT || 3000;

/**
 * Détection automatique d'un certificat mkcert dans server/certs/.
 * mkcert génère des fichiers nommés d'après l'IP, ex:
 *   192.168.1.6+2.pem       (certificat)
 *   192.168.1.6+2-key.pem   (clé privée)
 * On les retrouve sans dépendre du nom exact, juste du suffixe.
 */
function loadHttpsOptions() {
  const certsDir = path.join(__dirname, "certs");
  if (!fs.existsSync(certsDir)) return null;

  const files = fs.readdirSync(certsDir);
  const keyFile = files.find((f) => f.endsWith("-key.pem"));
  const certFile = files.find((f) => f.endsWith(".pem") && !f.endsWith("-key.pem") && f !== "rootCA.pem");

  if (!keyFile || !certFile) return null;

  return {
    key: fs.readFileSync(path.join(certsDir, keyFile)),
    cert: fs.readFileSync(path.join(certsDir, certFile)),
  };
}

const httpsOptions = loadHttpsOptions();
const PROTOCOL = httpsOptions ? "https" : "http";

const app = express();
app.set("trust proxy", 1);
const server = httpsOptions
  ? https.createServer(httpsOptions, app)
  : http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // ok pour un prototype en LAN
});

if (!httpsOptions) {
  console.warn(
    "[https] Aucun certificat trouvé dans server/certs/ -> le serveur tourne en HTTP.\n" +
    "         Le gyroscope (DeviceOrientationEvent) ne fonctionnera PAS sur iOS en HTTP.\n" +
    "         Génère un certificat avec mkcert pour activer HTTPS (voir README)."
  );
}

// --- Route de diagnostic (texte brut, aucun CSS/JS) ---
// Utile pour vérifier qu'une requête HTTP(S) basique passe bien jusqu'au téléphone,
// indépendamment de tout souci de rendu HTML/CSS/JS.
app.get("/ping", (req, res) => {
  res.type("text/plain").send(`OK - Le serveur répond bien. Heure serveur: ${new Date().toISOString()}`);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, protocol: PROTOCOL, port: PORT, rooms: cleanupExpiredRooms() });
});

// --- Téléchargement de l'autorité de certification mkcert (à installer sur le téléphone) ---
// Copie ton rootCA.pem (trouvable via `mkcert -CAROOT`) dans server/certs/rootCA.pem
// pour pouvoir le télécharger directement depuis le navigateur du téléphone.
app.get("/rootCA.pem", (req, res) => {
  const rootCaPath = path.join(__dirname, "certs", "rootCA.pem");
  if (!fs.existsSync(rootCaPath)) {
    res.status(404).type("text/plain").send(
      "rootCA.pem introuvable. Copie-le depuis `mkcert -CAROOT` vers server/certs/rootCA.pem"
    );
    return;
  }
  res.download(rootCaPath, "rootCA.pem");
});

// --- Fichiers statiques ---
app.use("/", express.static(path.join(__dirname, "..", "public", "pc")));
app.use("/mobile", express.static(path.join(__dirname, "..", "public", "mobile")));

/**
 * Récupère la première adresse IPv4 locale non-interne (ex: 192.168.1.23).
 * C'est cette IP que le smartphone doit pouvoir joindre sur le même réseau Wi-Fi.
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

const LOCAL_IP = getLocalIP();

function getPublicBaseUrl(req) {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
  }

  if (req?.headers) {
    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto || PROTOCOL;
    const host = req.headers.host;
    if (host) {
      return `${proto}://${host}`;
    }
  }

  return `${PROTOCOL}://${LOCAL_IP}:${PORT}`;
}

setInterval(() => {
  const removed = cleanupExpiredRooms();
  if (removed > 0) {
    console.log(`[room] ${removed} room(s) expirée(s) nettoyée(s)`);
  }
}, 60_000);

// --- Logique Socket.io ---
io.on("connection", (socket) => {
  console.log(`[socket] Nouvelle connexion: ${socket.id}`);

  /**
   * Le PC (le jeu) s'enregistre au chargement de la page.
   * On crée une room, on génère l'URL mobile + son QR code, et on renvoie
   * tout ça au PC pour affichage.
   */
  socket.on("register-pc", async () => {
    const roomId = createRoom(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "pc";
    touchRoom(roomId);

    const baseUrl = getPublicBaseUrl(socket.request);
    const urlFor = (player) => `${baseUrl}/mobile?room=${roomId}&player=${player}`;

    try {
      const [qr1, qr2] = await Promise.all([
        QRCode.toDataURL(urlFor(1), { margin: 1, width: 300 }),
        QRCode.toDataURL(urlFor(2), { margin: 1, width: 300 }),
      ]);

      socket.emit("room-info", {
        roomId,
        players: {
          1: { url: urlFor(1), qrCodeDataUrl: qr1 },
          2: { url: urlFor(2), qrCodeDataUrl: qr2 },
        },
      });

      console.log(`[room] Room créée: ${roomId} (PC=${socket.id})`);
    } catch (err) {
      console.error("[qrcode] Erreur de génération:", err);
      socket.emit("server-error", { message: "Impossible de générer le QR code." });
    }
  });

  /**
   * Le mobile s'enregistre en rejoignant une room existante, avec le slot
   * joueur (1 ou 2) indiqué dans l'URL scannée (?room=XXXX&player=1|2).
   */
  socket.on("register-mobile", ({ roomId, player } = {}) => {
    const existing = getRoom(roomId);
    if (!existing) {
      socket.emit("joined-room", {
        success: false,
        message: "Room introuvable ou expirée. Rescanne le QR code.",
      });
      return;
    }

    const { room, player: assignedPlayer } = joinRoom(roomId, Number(player) || 1, socket.id);

    if (!room) {
      socket.emit("joined-room", {
        success: false,
        message: "Les deux places sont déjà prises pour cette course.",
      });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role = "mobile";
    socket.data.player = assignedPlayer;
    touchRoom(roomId);

    socket.emit("joined-room", { success: true, roomId, player: assignedPlayer });

    // Informe le PC qu'un joueur est connecté
    io.to(room.pcSocketId).emit("player-joined", { player: assignedPlayer });

    console.log(`[room] Mobile ${socket.id} a rejoint la room ${roomId} en tant que joueur ${assignedPlayer}`);
  });

  /**
   * Relais des inputs manette -> PC, taggés avec le numéro du joueur.
   * On envoie uniquement au socket PC de la room (pas de broadcast large).
   */
  const forwardToPc = (eventName) => (payload) => {
    const roomId = socket.data.roomId;
    const player = socket.data.player;
    if (!roomId || !player) return;
    const room = getRoom(roomId);
    if (!room || !room.pcSocketId) return;
    touchRoom(roomId);
    io.to(room.pcSocketId).emit(eventName, { player, ...payload });
  };

  socket.on("steer", forwardToPc("steer"));           // { gamma, beta }
  socket.on("gas_press", forwardToPc("gas_press"));
  socket.on("gas_release", forwardToPc("gas_release"));
  socket.on("brake_press", forwardToPc("brake_press"));
  socket.on("brake_release", forwardToPc("brake_release"));

  /**
   * Nettoyage à la déconnexion.
   */
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room) return;

    if (socket.data.role === "pc") {
      // Le PC ferme le jeu -> on prévient les deux manettes et on supprime la room
      [room.players[1], room.players[2]].forEach((sid) => {
        if (sid) io.to(sid).emit("pc-disconnected");
      });
      deleteRoom(roomId);
      console.log(`[room] Room ${roomId} supprimée (PC déconnecté)`);
    } else if (socket.data.role === "mobile") {
      const player = socket.data.player;
      leavePlayer(roomId, player);
      if (room.pcSocketId) {
        io.to(room.pcSocketId).emit("player-left", { player });
      }
      console.log(`[room] Joueur ${player} déconnecté de la room ${roomId}`);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log(`  Serveur démarré sur le port ${PORT} (${PROTOCOL.toUpperCase()})`);
  console.log(`  PC (jeu)     : ${PROTOCOL}://localhost:${PORT}`);
  console.log(`  Mobile (LAN) : ${PROTOCOL}://${LOCAL_IP}:${PORT}/mobile`);
  console.log(`  Public URL   : ${getPublicBaseUrl()}`);
  console.log("========================================");
});
