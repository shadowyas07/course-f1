/**
 * controller.js (Mobile) - Volant tactile + HUD stylé
 */

const isCapacitorApp = typeof window.Capacitor !== "undefined";
const SOCKET_URL = isCapacitorApp ? "https://votre-app.onrender.com" : window.location.origin;
const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });

// --- Éléments DOM ---
const startScreen = document.getElementById("start-screen");
const startStatus = document.getElementById("start-status");
const startError = document.getElementById("start-error");
const joinForm = document.getElementById("join-form");
const roomInput = document.getElementById("room-input");
const joinPlayerInputs = Array.from(document.querySelectorAll('input[name="join-player"]'));

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
const handbrakeBtn = document.getElementById("handbrake-btn");
const pauseBtn = document.getElementById("pause-btn");
const pauseMenu = document.getElementById("pause-menu");
const pauseResumeBtn = document.getElementById("pause-resume-btn");
const settingSensitivity = document.getElementById("setting-sensitivity");
const settingSensitivityValue = document.getElementById("setting-sensitivity-value");
const settingRate = document.getElementById("setting-rate");
const settingVibration = document.getElementById("setting-vibration");
const pauseModeButtons = Array.from(document.querySelectorAll("[data-pause-mode]"));

const roomIdDisplay = document.getElementById("room-id-display");
const statusLine = document.getElementById("status-line");

// --- Room ---
const playerBadge = document.getElementById("player-badge");

const searchParams = new URLSearchParams(window.location.search);
const hasRoomParams = searchParams.has("room") && searchParams.has("player");
const initialRoomId = hasRoomParams ? (searchParams.get("room") || "").trim().toUpperCase() : "";
const initialPlayer = hasRoomParams ? (Number(searchParams.get("player")) === 2 ? 2 : 1) : 1;
const autoJoinRequest = hasRoomParams && initialRoomId ? { roomId: initialRoomId, player: initialPlayer } : null;

let isPaused = false;
let lastSentSteer = 0;
let wheelSendTimer = null;
let lastPacketTs = 0;
let INPUT_THROTTLE_MS = 16;
let steerMode = "wheel";
let tiltAvailable = typeof window.DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission !== "function";
let tiltPermissionState = "unknown";
let tiltSmoothedGamma = 0;
let buttonLeftPressed = false;
let buttonRightPressed = false;
let activeGas = false;
let activeBrake = false;
let activeHandbrake = false;
let pendingJoinRequest = autoJoinRequest;
let wakeLockSentinel = null;
let steeringSensitivity = 1;
let vibrationEnabled = true;

if (tiltAvailable) {
  tiltPermissionState = "granted";
}

function normalizeRoomCode(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .toUpperCase()
    .slice(0, 6);
}

function getSelectedJoinPlayer() {
  const selected = joinPlayerInputs.find((input) => input.checked);
  return selected && Number(selected.value) === 2 ? 2 : 1;
}

function setStartError(message) {
  if (!startError) return;
  if (!message) {
    startError.textContent = "";
    startError.classList.add("hidden");
    return;
  }
  startError.textContent = message;
  startError.classList.remove("hidden");
}

function setStartMode({ message, showJoinForm }) {
  if (typeof message === "string") {
    startStatus.textContent = message;
  }
  if (joinForm) {
    joinForm.classList.toggle("hidden", !showJoinForm);
  }
}

async function requestOrientationPermissionIfNeeded() {
  if (typeof window.DeviceOrientationEvent === "undefined") return true;
  if (typeof DeviceOrientationEvent.requestPermission !== "function") {
    tiltAvailable = true;
    tiltPermissionState = "granted";
    return true;
  }

  try {
    const result = await DeviceOrientationEvent.requestPermission();
    tiltPermissionState = result;
    tiltAvailable = result === "granted";
    return tiltAvailable;
  } catch (error) {
    tiltPermissionState = "denied";
    tiltAvailable = false;
    return false;
  }
}

async function enableKeepAwake() {
  if (isCapacitorApp) {
    const plugin = window.Capacitor?.Plugins?.KeepAwake;
    if (plugin) {
      try {
        if (typeof plugin.keepAwake === "function") {
          await plugin.keepAwake();
          return;
        }
        if (typeof plugin.activate === "function") {
          await plugin.activate();
          return;
        }
      } catch (error) {
        // fallback below
      }
    }
  }

  if (navigator.wakeLock?.request) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel.addEventListener("release", () => {
        wakeLockSentinel = null;
      });
    } catch (error) {
      wakeLockSentinel = null;
    }
  }
}

async function releaseKeepAwake() {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch (error) {
      // ignore
    }
    wakeLockSentinel = null;
  }

  if (isCapacitorApp) {
    const plugin = window.Capacitor?.Plugins?.KeepAwake;
    if (plugin) {
      try {
        if (typeof plugin.allowSleepAgain === "function") {
          await plugin.allowSleepAgain();
        } else if (typeof plugin.deactivate === "function") {
          await plugin.deactivate();
        } else if (typeof plugin.release === "function") {
          await plugin.release();
        }
      } catch (error) {
        // ignore
      }
    }
  }
}

function queueJoinRequest(roomId, player) {
  const normalizedRoom = normalizeRoomCode(roomId);
  const requestedPlayer = Number(player) === 2 ? 2 : 1;
  if (!normalizedRoom) {
    setStartError("Saisis un code de room valide.");
    return false;
  }

  pendingJoinRequest = { roomId: normalizedRoom, player: requestedPlayer };
  setStartMode({ message: `Connexion à la room ${normalizedRoom}...`, showJoinForm: false });

  if (socket.connected) {
    socket.emit("register-mobile", pendingJoinRequest);
  }

  return true;
}

async function handleJoinSubmit(event) {
  event.preventDefault();
  const roomId = roomInput ? roomInput.value : "";
  const player = getSelectedJoinPlayer();

  setStartError("");
  const permissionOk = await requestOrientationPermissionIfNeeded();
  const queued = queueJoinRequest(roomId, player);
  if (queued && !permissionOk) {
    setStartError("Gyroscope non autorisé. Tu peux quand même rejoindre avec le volant ou les boutons.");
  }
}

// ============================================================
// 1. Connexion à la room
// ============================================================

if (autoJoinRequest) {
  roomIdDisplay.textContent = autoJoinRequest.roomId;
  playerBadge.textContent = `J${autoJoinRequest.player}`;
  playerBadge.classList.add(autoJoinRequest.player === 2 ? "player-2" : "player-1");
  setStartMode({ message: `Connexion à la room ${autoJoinRequest.roomId}...`, showJoinForm: false });
} else {
  setStartMode({ message: "Mode manette: entre le code room affiché sur le PC, puis choisis ton joueur.", showJoinForm: true });
  if (roomInput) {
    roomInput.focus();
  }
}

if (joinForm) {
  joinForm.addEventListener("submit", handleJoinSubmit);
}

if (roomInput) {
  roomInput.addEventListener("input", () => {
    const normalized = normalizeRoomCode(roomInput.value);
    if (roomInput.value !== normalized) {
      roomInput.value = normalized;
    }
  });
}

socket.on("connect", () => {
  console.log("[controller] socket connecté", socket.id, "->", SOCKET_URL);
  if (pendingJoinRequest) {
    socket.emit("register-mobile", pendingJoinRequest);
    setStartMode({ message: `Connexion à la room ${pendingJoinRequest.roomId}...`, showJoinForm: false });
  } else {
    setStartMode({ message: isCapacitorApp ? "Saisis le code de room pour rejoindre la course." : "Connexion au serveur établie.", showJoinForm: true });
  }
});

socket.on("joined-room", async ({ success, message, player }) => {
  if (success) {
    const activeRequest = pendingJoinRequest;
    const activePlayer = player || activeRequest?.player || 1;
    if (activeRequest?.roomId) {
      roomIdDisplay.textContent = activeRequest.roomId;
    }
    playerBadge.textContent = `J${activePlayer}`;
    playerBadge.classList.remove("player-1", "player-2");
    playerBadge.classList.add(activePlayer === 2 ? "player-2" : "player-1");

    startScreen.classList.add("hidden");
    controllerScreen.classList.remove("hidden");
    setStatus("connected", "🟢 CONNECTÉ");
    await enableKeepAwake();
    startWheelSending();
  } else {
    setStartError(`❌ ${message || "Impossible de rejoindre la room."}`);
    setStartMode({ message: "Connexion impossible. Vérifie le code et réessaie.", showJoinForm: true });
  }
});

socket.on("game-haptic", ({ intensity = 1 } = {}) => {
  if (vibrationEnabled && navigator.vibrate) {
    navigator.vibrate(Math.max(12, Math.round(Number(intensity) * 70)));
  }
});

socket.on("pc-disconnected", async () => {
  await releaseKeepAwake();
  setStatus("error", "🔴 JEU FERMÉ");
  setStartMode({ message: "⚠️ L'écran du jeu a été fermé.", showJoinForm: !!autoJoinRequest ? false : true });
  startScreen.classList.remove("hidden");
  controllerScreen.classList.add("hidden");
});

socket.on("disconnect", async () => {
  await releaseKeepAwake();
  setStatus("error", "🔴 DÉCONNECTÉ");
  setStartMode({ message: "🔌 Déconnecté du serveur.", showJoinForm: !autoJoinRequest });
  startScreen.classList.remove("hidden");
  controllerScreen.classList.add("hidden");
});

window.addEventListener("beforeunload", () => {
  releaseKeepAwake();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !controllerScreen.classList.contains("hidden")) {
    enableKeepAwake();
  }
});

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
  controllerScreen.style.opacity = isPaused ? "0.6" : "1";
  pauseBtn.classList.toggle("active", isPaused);
  if (pauseMenu) {
    pauseMenu.classList.toggle("hidden", !isPaused);
    pauseMenu.setAttribute("aria-hidden", isPaused ? "false" : "true");
  }
  if (isPaused) {
    socket.emit("gas_release");
    socket.emit("brake_release");
    socket.emit("handbrake_release");
    setStatus("error", "⏸️ PAUSE");
  } else {
    setStatus("connected", "🟢 CONNECTÉ");
  }
});

if (pauseResumeBtn) {
  pauseResumeBtn.addEventListener("click", () => {
    isPaused = false;
    controllerScreen.style.opacity = "1";
    pauseBtn.classList.remove("active");
    if (pauseMenu) {
      pauseMenu.classList.add("hidden");
      pauseMenu.setAttribute("aria-hidden", "true");
    }
    setStatus("connected", "🟢 CONNECTÉ");
  });
}

if (settingSensitivity && settingSensitivityValue) {
  const syncSensitivity = () => {
    steeringSensitivity = Number(settingSensitivity.value) / 100;
    settingSensitivityValue.textContent = `${settingSensitivity.value}%`;
  };
  settingSensitivity.addEventListener("input", syncSensitivity);
  syncSensitivity();
}

if (settingRate) {
  const syncRate = () => {
    const hz = Number(settingRate.value) || 60;
    INPUT_THROTTLE_MS = Math.max(8, Math.round(1000 / hz));
    startWheelSending();
  };
  settingRate.addEventListener("change", syncRate);
  syncRate();
}

if (settingVibration) {
  settingVibration.addEventListener("change", () => {
    vibrationEnabled = !!settingVibration.checked;
  });
}

pauseModeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setSteerMode(btn.dataset.pauseMode || "wheel");
  });
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

function sendCompactInput() {
  if (isPaused) return;
  const now = Date.now();
  if (now - lastPacketTs < INPUT_THROTTLE_MS) return;
  lastPacketTs = now;

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

  const clamped = Math.max(-STEER_EFFECTIVE_RANGE, Math.min(STEER_EFFECTIVE_RANGE, steeringSource * steeringSensitivity));
  const direction = Number((-clamped / STEER_EFFECTIVE_RANGE).toFixed(3));
  const payload = [direction, activeGas ? 1 : 0, activeBrake ? 1 : 0, activeHandbrake ? 1 : 0];
  if (Math.abs(direction - lastSentSteer) < 0.001 && payload[1] === 0 && payload[2] === 0 && payload[3] === 0) return;
  lastSentSteer = direction;
  socket.emit("steer", { payload });
}

function startWheelSending() {
  if (wheelSendTimer) clearInterval(wheelSendTimer);
  wheelSendTimer = setInterval(sendCompactInput, INPUT_THROTTLE_MS);
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
bindPressRelease(handbrakeBtn, "handbrake_press", "handbrake_release");

setSteerMode("wheel");

function emitCompactState() {
  const payload = [
    Number(lastSentSteer || 0),
    activeGas ? 1 : 0,
    activeBrake ? 1 : 0,
    activeHandbrake ? 1 : 0,
  ];
  socket.emit("steer", { payload });
}

function bindPressRelease(btnEl, pressEvent, releaseEvent) {
  let isPressed = false;

  const press = (e) => {
    if (isPaused) return;
    e.preventDefault();
    if (isPressed) return;
    isPressed = true;
    btnEl.classList.add("active");
    if (pressEvent === "gas_press") activeGas = true;
    if (pressEvent === "brake_press") activeBrake = true;
    if (pressEvent === "handbrake_press") activeHandbrake = true;
    emitCompactState();
    if (vibrationEnabled && navigator.vibrate) navigator.vibrate(15);
  };

  const release = (e) => {
    if (e) e.preventDefault();
    if (!isPressed) return;
    isPressed = false;
    btnEl.classList.remove("active");
    if (releaseEvent === "gas_release") activeGas = false;
    if (releaseEvent === "brake_release") activeBrake = false;
    if (releaseEvent === "handbrake_release") activeHandbrake = false;
    emitCompactState();
  };

  btnEl.addEventListener("pointerdown", press);
  btnEl.addEventListener("pointerup", release);
  btnEl.addEventListener("pointercancel", release);
  btnEl.addEventListener("pointerleave", release);
}
