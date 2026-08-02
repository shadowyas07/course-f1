/**
 * controller.js (Mobile) - Volant tactile + HUD stylé
 */

const socket = io();

// --- Éléments DOM ---
const startScreen = document.getElementById("start-screen");
const startStatus = document.getElementById("start-status");
const startError = document.getElementById("start-error");

const controllerScreen = document.getElementById("controller-screen");
const wheelEl = document.getElementById("wheel");
const wheelHint = document.getElementById("wheel-hint");
const tiltHint = document.getElementById("tilt-hint");
const tiltEnableBtn = document.getElementById("tilt-enable-btn");
const steerModeBtns = Array.from(document.querySelectorAll(".mode-btn"));
const buttonSteer = document.getElementById("button-steer");
const leftBtn = document.getElementById("left-btn");
const rightBtn = document.getElementById("right-btn");
const gasBtn = document.getElementById("gas-btn");
const brakeBtn = document.getElementById("brake-btn");
const pauseBtn = document.getElementById("pause-btn");

const roomIdDisplay = document.getElementById("room-id-display");
const statusLine = document.getElementById("status-line");

// --- Room ---
function getRoomIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("room");
}
function getPlayerFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const p = Number(params.get("player"));
  return p === 2 ? 2 : 1;
}
const roomId = getRoomIdFromUrl();
const requestedPlayer = getPlayerFromUrl();
const playerBadge = document.getElementById("player-badge");

let isPaused = false;
let lastSentSteer = 0;
let wheelSendTimer = null;
let steerMode = "wheel";
let tiltAvailable = false;
let tiltPermissionState = "unknown";
let tiltSmoothedGamma = 0;
let buttonLeftPressed = false;
let buttonRightPressed = false;

if (typeof window.DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission !== "function") {
  tiltAvailable = true;
  tiltPermissionState = "granted";
}

// ============================================================
// 1. Connexion à la room
// ============================================================

if (!roomId) {
  startStatus.textContent =
    "❌ Aucun code de room détecté. Rescanne le QR code depuis l'écran du jeu.";
} else {
  roomIdDisplay.textContent = roomId;
  playerBadge.textContent = `J${requestedPlayer}`;
  playerBadge.classList.add(requestedPlayer === 2 ? "player-2" : "player-1");

  socket.on("connect", () => {
    startStatus.textContent = `Connexion à la room ${roomId}...`;
    socket.emit("register-mobile", { roomId, player: requestedPlayer });
  });

  socket.on("joined-room", ({ success, message, player }) => {
    if (success) {
      if (player && player !== requestedPlayer) {
        // L'autre slot était pris, le serveur nous a basculés automatiquement
        playerBadge.textContent = `J${player}`;
        playerBadge.classList.remove("player-1", "player-2");
        playerBadge.classList.add(player === 2 ? "player-2" : "player-1");
      }
      startScreen.classList.add("hidden");
      controllerScreen.classList.remove("hidden");
      setStatus("connected", "🟢 CONNECTÉ");
      startWheelSending();
    } else {
      startStatus.textContent = `❌ ${message || "Impossible de rejoindre la room."}`;
    }
  });

  socket.on("pc-disconnected", () => {
    setStatus("error", "🔴 JEU FERMÉ");
    startStatus.textContent = "⚠️ L'écran du jeu a été fermé.";
    startScreen.classList.remove("hidden");
    controllerScreen.classList.add("hidden");
  });

  socket.on("disconnect", () => {
    setStatus("error", "🔴 DÉCONNECTÉ");
    startStatus.textContent = "🔌 Déconnecté du serveur.";
    startScreen.classList.remove("hidden");
    controllerScreen.classList.add("hidden");
  });
}

function setStatus(kind, text) {
  statusLine.textContent = text;
  statusLine.classList.remove("status-waiting", "status-connected", "status-error");
  statusLine.classList.add(`status-${kind}`);
}

function setSteerMode(mode) {
  steerMode = mode;
  steerModeBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.steerMode === mode));

  const useWheel = mode === "wheel";
  const useTilt = mode === "tilt";
  const useButtons = mode === "buttons";

  wheelEl.classList.toggle("inactive", !useWheel);
  wheelHint.classList.toggle("hidden", !useWheel);
  tiltHint.classList.toggle("hidden", !useTilt);
  buttonSteer.classList.toggle("hidden", !useButtons);

  const needsEnable = useTilt && !tiltAvailable;
  tiltEnableBtn.classList.toggle("hidden", !needsEnable);

  if (!useButtons) {
    buttonLeftPressed = false;
    buttonRightPressed = false;
    leftBtn.classList.remove("active");
    rightBtn.classList.remove("active");
  }
}

// ============================================================
// 2. Bouton pause (visuel : suspend l'envoi des contrôles)
// ============================================================

pauseBtn.addEventListener("click", () => {
  isPaused = !isPaused;
  controllerScreen.style.opacity = isPaused ? "0.45" : "1";
  pauseBtn.classList.toggle("active", isPaused);
  if (isPaused) {
    socket.emit("gas_release");
    socket.emit("brake_release");
    setStatus("error", "⏸️ PAUSE");
  } else {
    setStatus("connected", "🟢 CONNECTÉ");
  }
});

steerModeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    setSteerMode(btn.dataset.steerMode || "wheel");
  });
});

// ============================================================
// 3. Volant tactile
// ============================================================

const WHEEL_MAX_ROTATION = 135;
const STEER_EFFECTIVE_RANGE = 90;
const RETURN_TO_CENTER_SPEED = 0.18;

let currentRotation = 0;
let isDragging = false;
let dragStartAngle = 0;
let dragStartRotation = 0;
let returnAnimationId = null;
let hintFaded = false;

function angleFromCenter(clientX, clientY, rect) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function applyWheelRotation(deg) {
  currentRotation = deg;
  wheelEl.style.transform = `rotate(${deg}deg)`;
}

function fadeHintOnce() {
  if (hintFaded) return;
  hintFaded = true;
  wheelHint.classList.add("faded");
}

function onWheelPointerDown(e) {
  if (steerMode !== "wheel") return;
  if (isPaused) return;
  e.preventDefault();
  fadeHintOnce();
  cancelReturnAnimation();
  isDragging = true;
  wheelEl.setPointerCapture(e.pointerId);

  const rect = wheelEl.getBoundingClientRect();
  dragStartAngle = angleFromCenter(e.clientX, e.clientY, rect);
  dragStartRotation = currentRotation;
}

function onWheelPointerMove(e) {
  if (steerMode !== "wheel") return;
  if (!isDragging) return;
  e.preventDefault();

  const rect = wheelEl.getBoundingClientRect();
  const angle = angleFromCenter(e.clientX, e.clientY, rect);
  let delta = angle - dragStartAngle;

  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;

  let newRotation = dragStartRotation + delta;
  newRotation = Math.max(-WHEEL_MAX_ROTATION, Math.min(WHEEL_MAX_ROTATION, newRotation));

  applyWheelRotation(newRotation);
}

function onWheelPointerUp(e) {
  if (steerMode !== "wheel") return;
  if (!isDragging) return;
  isDragging = false;
  try {
    wheelEl.releasePointerCapture(e.pointerId);
  } catch (err) {
    /* ignore */
  }
  startReturnAnimation();
}

function startReturnAnimation() {
  cancelReturnAnimation();
  function step() {
    const next = currentRotation * (1 - RETURN_TO_CENTER_SPEED);
    if (Math.abs(next) < 0.5) {
      applyWheelRotation(0);
      returnAnimationId = null;
      return;
    }
    applyWheelRotation(next);
    returnAnimationId = requestAnimationFrame(step);
  }
  returnAnimationId = requestAnimationFrame(step);
}

function cancelReturnAnimation() {
  if (returnAnimationId !== null) {
    cancelAnimationFrame(returnAnimationId);
    returnAnimationId = null;
  }
}

wheelEl.addEventListener("pointerdown", onWheelPointerDown);
wheelEl.addEventListener("pointermove", onWheelPointerMove);
wheelEl.addEventListener("pointerup", onWheelPointerUp);
wheelEl.addEventListener("pointercancel", onWheelPointerUp);

function startWheelSending() {
  if (wheelSendTimer) clearInterval(wheelSendTimer);
  wheelSendTimer = setInterval(() => {
    if (isPaused) return;
    let steeringSource = currentRotation;

    if (steerMode === "tilt" && tiltAvailable) {
      steeringSource = tiltSmoothedGamma;
      if (!isDragging) {
        applyWheelRotation(steeringSource);
      }
    } else if (steerMode === "buttons") {
      const target = (buttonRightPressed ? 1 : 0) - (buttonLeftPressed ? 1 : 0);
      const targetRotation = target * STEER_EFFECTIVE_RANGE;
      const lerp = 0.3;
      const next = currentRotation + (targetRotation - currentRotation) * lerp;
      applyWheelRotation(next);
      steeringSource = next;
    }

    const clamped = Math.max(-STEER_EFFECTIVE_RANGE, Math.min(STEER_EFFECTIVE_RANGE, steeringSource));
    if (Math.abs(clamped - lastSentSteer) < 0.01) return;
    lastSentSteer = clamped;
    socket.emit("steer", { gamma: clamped, beta: 0 });
  }, 50);
}

function handleTiltEvent(event) {
  if (event.gamma == null) return;
  const raw = Math.max(-45, Math.min(45, event.gamma));
  const mapped = (raw / 45) * STEER_EFFECTIVE_RANGE;
  tiltSmoothedGamma = tiltSmoothedGamma * 0.78 + mapped * 0.22;
}

async function requestTiltPermission() {
  if (typeof DeviceOrientationEvent === "undefined") {
    setStatus("error", "⚠️ Inclinaison non supportée");
    return;
  }

  try {
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const result = await DeviceOrientationEvent.requestPermission();
      tiltPermissionState = result;
      tiltAvailable = result === "granted";
    } else {
      tiltAvailable = true;
      tiltPermissionState = "granted";
    }
  } catch (err) {
    tiltPermissionState = "denied";
    tiltAvailable = false;
  }

  tiltEnableBtn.classList.toggle("hidden", !(steerMode === "tilt" && !tiltAvailable));
  if (!tiltAvailable && steerMode === "tilt") {
    setStatus("error", "⚠️ Autorise le gyroscope");
  } else if (tiltAvailable && steerMode === "tilt") {
    setStatus("connected", "🟢 CONNECTÉ · INCLINAISON");
  }
}

if (typeof window.DeviceOrientationEvent !== "undefined") {
  window.addEventListener("deviceorientation", handleTiltEvent, { passive: true });
}

tiltEnableBtn.addEventListener("click", () => {
  requestTiltPermission();
});

bindSteerButton(leftBtn, "left");
bindSteerButton(rightBtn, "right");

function bindSteerButton(btnEl, side) {
  const press = (e) => {
    if (isPaused || steerMode !== "buttons") return;
    e.preventDefault();
    if (side === "left") buttonLeftPressed = true;
    else buttonRightPressed = true;
    btnEl.classList.add("active");
  };

  const release = (e) => {
    if (e) e.preventDefault();
    if (side === "left") buttonLeftPressed = false;
    else buttonRightPressed = false;
    btnEl.classList.remove("active");
  };

  btnEl.addEventListener("pointerdown", press);
  btnEl.addEventListener("pointerup", release);
  btnEl.addEventListener("pointercancel", release);
  btnEl.addEventListener("pointerleave", release);
}

// ============================================================
// 4. Boutons GAZ / FREIN
// ============================================================

bindPressRelease(gasBtn, "gas_press", "gas_release");
bindPressRelease(brakeBtn, "brake_press", "brake_release");

setSteerMode("wheel");

function bindPressRelease(btnEl, pressEvent, releaseEvent) {
  let isPressed = false;

  const press = (e) => {
    if (isPaused) return;
    e.preventDefault();
    if (isPressed) return;
    isPressed = true;
    btnEl.classList.add("active");
    socket.emit(pressEvent);
    if (navigator.vibrate) navigator.vibrate(15);
  };

  const release = (e) => {
    if (e) e.preventDefault();
    if (!isPressed) return;
    isPressed = false;
    btnEl.classList.remove("active");
    socket.emit(releaseEvent);
  };

  btnEl.addEventListener("pointerdown", press);
  btnEl.addEventListener("pointerup", release);
  btnEl.addEventListener("pointercancel", release);
  btnEl.addEventListener("pointerleave", release);
}
