/**
 * network.js (PC)
 * Gère la connexion Socket.io côté écran PC :
 *  - Enregistrement en tant que "pc" au chargement
 *  - Réception des 2 QR codes (joueur 1 / joueur 2) + room id
 *  - Réception des inputs de chaque manette, routés vers window.carControls[1|2]
 *  - Gestion du panneau de réglages de course + bouton de lancement
 *
 * Les inputs reçus sont exposés via `window.carControls1` / `window.carControls2`
 * afin que game.js puisse les consommer sans coupler ce fichier au moteur 3D.
 */

const socket = io();

function freshControls() {
  return { steerAngle: 0, gasPressed: false, brakePressed: false, connected: false };
}
window.carControls1 = freshControls();
window.carControls2 = freshControls();

// Réglages de course, modifiés par le panneau du lobby, lus par game.js au lancement.
window.raceSettings = {
  laps: 3,
  wallMode: false, // false = herbe (limites souples), true = mur (limites dures)
};

const qrImg1 = document.getElementById("qr-code-1");
const qrImg2 = document.getElementById("qr-code-2");
const roomIdEl = document.getElementById("room-id");
const status1 = document.getElementById("status-1");
const status2 = document.getElementById("status-2");
const startBtn = document.getElementById("start-race-btn");
const serverStatusEl = document.getElementById("server-status");

function setServerStatus(message, kind = "info") {
  if (!serverStatusEl) return;
  serverStatusEl.textContent = message;
  serverStatusEl.className = `server-status ${kind}`.trim();
}

function refreshStartButton() {
  const mode = window.selectedMode || "duel";
  const isSolo = mode === "solo-timed" || mode === "solo-free";
  const ready = isSolo ? window.carControls1.connected : window.carControls1.connected && window.carControls2.connected;
  startBtn.disabled = !ready;

  if (ready) {
    const config = typeof window.getSelectedModeConfig === "function" ? window.getSelectedModeConfig(mode) : null;
    startBtn.textContent = config ? config.buttonLabel : "🏁 Lancer la course";
  } else {
    startBtn.textContent = isSolo ? "En attente du pilote…" : "En attente des 2 joueurs...";
  }
}
window.refreshStartButton = refreshStartButton;

socket.on("connect", () => {
  console.log("[network] Connecté au serveur, id =", socket.id);
  setServerStatus("🟢 Connecté au serveur", "connected");
  socket.emit("register-pc");
});

socket.on("connect_error", () => {
  setServerStatus("🔴 Impossible de joindre le serveur", "error");
});

socket.on("disconnect", () => {
  setServerStatus("🔴 Déconnecté du serveur", "error");
});

socket.on("room-info", ({ roomId, players }) => {
  roomIdEl.textContent = roomId;
  qrImg1.src = players[1].qrCodeDataUrl;
  qrImg2.src = players[2].qrCodeDataUrl;
  setServerStatus("✅ Room prête — les joueurs peuvent se connecter", "connected");
});

socket.on("player-joined", ({ player }) => {
  const controls = player === 2 ? window.carControls2 : window.carControls1;
  const statusEl = player === 2 ? status2 : status1;
  controls.connected = true;
  statusEl.textContent = "✅ Connecté";
  statusEl.classList.remove("waiting");
  statusEl.classList.add("connected");
  setServerStatus(`🟢 Joueur ${player} prêt`, "connected");
  refreshStartButton();
});

document.addEventListener("mode-changed", refreshStartButton);

socket.on("player-left", ({ player }) => {
  const controls = player === 2 ? window.carControls2 : window.carControls1;
  const statusEl = player === 2 ? status2 : status1;
  controls.connected = false;
  controls.gasPressed = false;
  controls.brakePressed = false;
  statusEl.textContent = "⏳ En attente...";
  statusEl.classList.remove("connected");
  statusEl.classList.add("waiting");
  refreshStartButton();
  if (typeof window.onPlayerLeftDuringRace === "function") {
    window.onPlayerLeftDuringRace(player);
  }
});

socket.on("server-error", ({ message }) => {
  console.error("[network] Erreur serveur:", message);
  setServerStatus(`⚠️ ${message}`, "error");
});

// --- Réglages de course (panneau du lobby) ---

document.querySelectorAll('input[name="laps"]').forEach((el) => {
  el.addEventListener("change", () => {
    if (el.checked) window.raceSettings.laps = Number(el.value);
  });
});

document.querySelectorAll('input[name="wall-mode"]').forEach((el) => {
  el.addEventListener("change", () => {
    if (el.checked) window.raceSettings.wallMode = el.value === "wall";
  });
});

startBtn.addEventListener("click", () => {
  if (startBtn.disabled) return;
  if (typeof window.enableGameAudio === "function") window.enableGameAudio();
  startBtn.disabled = true;
  startBtn.textContent = "🚦 Démarrage…";
  document.getElementById("lobby-screen").classList.add("hidden");
  document.getElementById("game-screen").classList.remove("hidden");
  setServerStatus("🏁 Course lancée", "connected");
  if (typeof window.startRace === "function") window.startRace();
});

// --- Inputs manette, routés par joueur ---

function controlsFor(player) {
  return player === 2 ? window.carControls2 : window.carControls1;
}

socket.on("steer", ({ player, gamma }) => {
  const clamped = Math.max(-90, Math.min(90, gamma));
  controlsFor(player).steerAngle = clamped / 90; // normalisé entre -1 et 1
});

socket.on("gas_press", ({ player }) => {
  controlsFor(player).gasPressed = true;
});

socket.on("gas_release", ({ player }) => {
  controlsFor(player).gasPressed = false;
});

socket.on("brake_press", ({ player }) => {
  controlsFor(player).brakePressed = true;
});

socket.on("brake_release", ({ player }) => {
  controlsFor(player).brakePressed = false;
});
