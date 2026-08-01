/**
 * game.js
 * Scène 3D du jeu de course en 1 vs 1 : circuit, 2 voitures, physique arcade,
 * caméras de suivi en écran splitté, limites de terrain (herbe ou mur),
 * tours/chrono par joueur, mini-carte et HUD.
 *
 * Lit les inputs de chaque manette via `window.carControls1` / `window.carControls2`
 * (remplis par network.js) :
 *   - steerAngle : -1 (à fond à gauche) à +1 (à fond à droite)
 *   - gasPressed : bool
 *   - brakePressed : bool
 *
 * Réglages de course lus dans `window.raceSettings` :
 *   - laps : nombre de tours pour gagner
 *   - wallMode : true = mur dur, false = herbe qui ralentit
 */

import * as THREE from "./vendor/three.module.min.js";

// ============================================================
// Configuration du circuit (forme "stade" : 2 lignes droites + 2 virages)
// ============================================================
const TRACK = {
  straightLength: 70,
  turnRadius: 28,
  roadHalfWidth: 9,
  curbWidth: 1.2,
};
TRACK.perimeter = 2 * TRACK.straightLength + 2 * Math.PI * TRACK.turnRadius;
const WALL_BOUNDARY = TRACK.roadHalfWidth + TRACK.curbWidth;

function trackPointAt(s) {
  const { straightLength: L, turnRadius: R, perimeter } = TRACK;
  s = ((s % perimeter) + perimeter) % perimeter;

  if (s < L) return { x: R, z: -L / 2 + s };
  s -= L;

  if (s < Math.PI * R) {
    const theta = s / R;
    return { x: R * Math.cos(theta), z: L / 2 + R * Math.sin(theta) };
  }
  s -= Math.PI * R;

  if (s < L) return { x: -R, z: L / 2 - s };
  s -= L;

  const theta = s / R;
  return { x: -R * Math.cos(theta), z: -L / 2 - R * Math.sin(theta) };
}

const TRACK_SAMPLES = 220;
const centerPoints = [];
for (let i = 0; i < TRACK_SAMPLES; i++) {
  centerPoints.push(trackPointAt((i / TRACK_SAMPLES) * TRACK.perimeter));
}

// ============================================================
// Géométrie du circuit
// ============================================================

function buildTrackMeshes() {
  const road = buildRibbon(centerPoints, TRACK.roadHalfWidth, () => [0.16, 0.16, 0.19]);
  const curbHalf = TRACK.roadHalfWidth + TRACK.curbWidth;
  const curbColorFn = (i) => (i % 2 === 0 ? [0.85, 0.1, 0.1] : [0.9, 0.9, 0.9]);
  const outerCurb = buildRibbon(centerPoints, curbHalf, curbColorFn, TRACK.roadHalfWidth);
  const innerCurb = buildRibbon(centerPoints, -TRACK.roadHalfWidth, curbColorFn, -curbHalf);

  const group = new THREE.Group();
  group.add(meshFromRibbon(road));
  group.add(meshFromRibbon(outerCurb));
  group.add(meshFromRibbon(innerCurb));
  group.add(buildStartLine());
  return group;
}

function buildStartLine() {
  const group = new THREE.Group();
  const cols = 10;
  const tileW = (TRACK.roadHalfWidth * 2) / cols;
  const tileD = 1.6;
  for (let i = 0; i < cols; i++) {
    const even = i % 2 === 0;
    const mat = new THREE.MeshStandardMaterial({ color: even ? 0xffffff : 0x111111, roughness: 0.8 });
    const tile = new THREE.Mesh(new THREE.PlaneGeometry(tileW, tileD), mat);
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(TRACK.turnRadius - TRACK.roadHalfWidth + tileW * i + tileW / 2, 0.03, -TRACK.straightLength / 2 + 0.05);
    tile.receiveShadow = true;
    group.add(tile);
  }
  return group;
}

function buildRibbon(points, outerOffset, colorFn, innerOffset = null) {
  if (innerOffset === null) innerOffset = -outerOffset;
  const n = points.length;
  const positions = [];
  const colors = [];
  const indices = [];

  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const next = points[(i + 1) % n];
    const prev = points[(i - 1 + n) % n];
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    const nx = -tz / len;
    const nz = tx / len;

    positions.push(curr.x + nx * innerOffset, 0.02, curr.z + nz * innerOffset);
    positions.push(curr.x + nx * outerOffset, 0.02, curr.z + nz * outerOffset);
    const c = colorFn(i);
    colors.push(...c, ...c);
  }

  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = ((i + 1) % n) * 2;
    const d = ((i + 1) % n) * 2 + 1;
    indices.push(a, b, c, b, d, c);
  }

  return { positions, colors, indices };
}

function meshFromRibbon({ positions, colors, indices }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

// ============================================================
// Décor
// ============================================================

function buildTree() {
  const tree = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1 });
  const leavesMat = new THREE.MeshStandardMaterial({ color: 0x2d6a2d, roughness: 0.9 });
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.32, 1.6, 6), trunkMat);
  trunk.position.y = 0.8;
  trunk.castShadow = true;
  tree.add(trunk);
  [1.6, 1.2, 0.8].forEach((r, i) => {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(r, 1.6, 7), leavesMat);
    leaf.position.y = 1.6 + i * 1.05;
    leaf.castShadow = true;
    tree.add(leaf);
  });
  return tree;
}

function buildScenery() {
  const group = new THREE.Group();
  const minClear = TRACK.roadHalfWidth + TRACK.curbWidth + 6;
  const count = 90;
  for (let i = 0; i < count; i++) {
    const s = (i / count) * TRACK.perimeter + (Math.random() - 0.5) * 4;
    const p = trackPointAt(s);
    const s2 = trackPointAt(s + 0.5);
    const tx = s2.x - p.x;
    const tz = s2.z - p.z;
    const len = Math.hypot(tx, tz) || 1;
    const nx = -tz / len;
    const nz = tx / len;
    const side = i % 2 === 0 ? 1 : -1;
    const dist = minClear + Math.random() * 22;

    const tree = buildTree();
    tree.position.set(p.x + nx * dist * side, 0, p.z + nz * dist * side);
    const scale = 0.8 + Math.random() * 0.7;
    tree.scale.set(scale, scale, scale);
    tree.rotation.y = Math.random() * Math.PI * 2;
    group.add(tree);
  }
  return group;
}

// ============================================================
// Voiture low-poly (paramétrable en couleur pour distinguer J1/J2)
// ============================================================

function buildCar(bodyColor) {
  const car = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.4, metalness: 0.3 });
  const cabinMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2a, roughness: 0.3, metalness: 0.2 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff6cc, emissive: 0xfff2a0, emissiveIntensity: 1.2 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0x220000, emissiveIntensity: 0.4 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.55, 4.2), bodyMat);
  body.position.y = 0.5;
  body.castShadow = true;
  car.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 2.0), cabinMat);
  cabin.position.set(0, 0.95, -0.2);
  cabin.castShadow = true;
  car.add(cabin);

  const headlightGeo = new THREE.BoxGeometry(0.32, 0.16, 0.08);
  for (const x of [-0.7, 0.7]) {
    const hl = new THREE.Mesh(headlightGeo, headlightMat);
    hl.position.set(x, 0.55, 2.12);
    car.add(hl);
  }

  const brakeGeo = new THREE.BoxGeometry(0.32, 0.16, 0.06);
  const brakeLights = [];
  for (const x of [-0.75, 0.75]) {
    const bl = new THREE.Mesh(brakeGeo, brakeMat.clone());
    bl.position.set(x, 0.55, -2.11);
    car.add(bl);
    brakeLights.push(bl);
  }

  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 16);
  function makeWheel() {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.castShadow = true;
    return w;
  }

  const frontLeft = new THREE.Group();
  const frontLeftWheel = makeWheel();
  frontLeft.add(frontLeftWheel);
  frontLeft.position.set(-1.05, 0.42, 1.4);
  car.add(frontLeft);

  const frontRight = new THREE.Group();
  const frontRightWheel = makeWheel();
  frontRight.add(frontRightWheel);
  frontRight.position.set(1.05, 0.42, 1.4);
  car.add(frontRight);

  const rearLeft = makeWheel();
  rearLeft.position.set(-1.05, 0.42, -1.4);
  car.add(rearLeft);

  const rearRight = makeWheel();
  rearRight.position.set(1.05, 0.42, -1.4);
  car.add(rearRight);

  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.4), cabinMat);
  spoiler.position.set(0, 0.95, -2.1);
  car.add(spoiler);

  return {
    group: car,
    frontWheelPivots: [frontLeft, frontRight],
    rollingWheels: [frontLeftWheel, frontRightWheel, rearLeft, rearRight],
    brakeLights,
  };
}

// ============================================================
// Scène / rendu
// ============================================================

const canvas = document.getElementById("game-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setScissorTest(true);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x86c5e8);
scene.fog = new THREE.Fog(0x86c5e8, 120, 320);

const BASE_FOV = 65;
const camera1 = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1000);
const camera2 = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1000);

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const halfW = w / 2;
  camera1.aspect = halfW / h;
  camera1.updateProjectionMatrix();
  camera2.aspect = halfW / h;
  camera2.updateProjectionMatrix();
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}
window.addEventListener("resize", onResize);
onResize();

// --- Lumières ---
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a5a2a, 0.7));
const sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
sunLight.position.set(80, 120, 40);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -140;
sunLight.shadow.camera.right = 140;
sunLight.shadow.camera.top = 140;
sunLight.shadow.camera.bottom = -140;
sunLight.shadow.camera.far = 400;
scene.add(sunLight);

// --- Sol ---
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x3a7d33, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

scene.add(buildTrackMeshes());
scene.add(buildScenery());

// ============================================================
// Particules de poussière / impact (partagées entre les 2 voitures)
// ============================================================

const DUST_COUNT = 220;
const dustGeo = new THREE.BufferGeometry();
const dustPositions = new Float32Array(DUST_COUNT * 3);
const dustVelocities = new Array(DUST_COUNT).fill(null).map(() => new THREE.Vector3());
const dustLife = new Float32Array(DUST_COUNT);
for (let i = 0; i < DUST_COUNT; i++) dustPositions[i * 3 + 1] = -100;
dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
const dustMat = new THREE.PointsMaterial({ color: 0xcabf9a, size: 0.35, transparent: true, opacity: 0.8, depthWrite: false });
scene.add(new THREE.Points(dustGeo, dustMat));
let dustCursor = 0;

function spawnDust(x, z, count) {
  for (let n = 0; n < count; n++) {
    const i = dustCursor;
    dustCursor = (dustCursor + 1) % DUST_COUNT;
    dustPositions[i * 3] = x + (Math.random() - 0.5) * 0.6;
    dustPositions[i * 3 + 1] = 0.1;
    dustPositions[i * 3 + 2] = z + (Math.random() - 0.5) * 0.6;
    dustVelocities[i].set((Math.random() - 0.5) * 1.5, 1 + Math.random() * 1.2, (Math.random() - 0.5) * 1.5);
    dustLife[i] = 0.6 + Math.random() * 0.4;
  }
}

function updateDust(dt) {
  for (let i = 0; i < DUST_COUNT; i++) {
    if (dustLife[i] <= 0) continue;
    dustLife[i] -= dt;
    if (dustLife[i] <= 0) {
      dustPositions[i * 3 + 1] = -100;
      continue;
    }
    dustPositions[i * 3] += dustVelocities[i].x * dt;
    dustPositions[i * 3 + 1] += dustVelocities[i].y * dt;
    dustPositions[i * 3 + 2] += dustVelocities[i].z * dt;
    dustVelocities[i].y -= 2.5 * dt;
  }
  dustGeo.attributes.position.needsUpdate = true;
}

// ============================================================
// Physique arcade
// ============================================================

const PHYSICS_PARAMS = {
  maxSpeed: 34,
  acceleration: 22,
  brakeDeceleration: 40,
  naturalFriction: 8,
  maxSteerRate: 2.6,
  minSteerRate: 1.1,
  grassMaxSpeedFactor: 0.45,
  grassFriction: 26,
  wallImpactFactor: 0.35, // vitesse conservée après un choc contre le mur
};

/**
 * Trouve le point le plus proche de la ligne centrale, la distance latérale
 * signée, la normale au circuit à cet endroit, et si on est hors piste.
 */
function analyzeTrackPosition(x, z) {
  let bestIndex = 0;
  let bestDistSq = Infinity;
  for (let i = 0; i < centerPoints.length; i++) {
    const p = centerPoints[i];
    const dx = x - p.x;
    const dz = z - p.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIndex = i;
    }
  }
  const p = centerPoints[bestIndex];
  const next = centerPoints[(bestIndex + 1) % centerPoints.length];
  const prev = centerPoints[(bestIndex - 1 + centerPoints.length) % centerPoints.length];
  const tx = next.x - prev.x;
  const tz = next.z - prev.z;
  const len = Math.hypot(tx, tz) || 1;
  const nx = -tz / len;
  const nz = tx / len;
  const lateral = (x - p.x) * nx + (z - p.z) * nz;
  const offTrack = Math.abs(lateral) > WALL_BOUNDARY;
  return { index: bestIndex, lateral, offTrack, nx, nz, px: p.x, pz: p.z };
}

/**
 * Crée l'état complet d'une voiture (physique + mesh + suivi de tours).
 */
function createCarState(playerId, bodyColor, startX, startZ) {
  const parts = buildCar(bodyColor);
  scene.add(parts.group);

  return {
    playerId,
    parts,
    physics: { x: startX, z: startZ, heading: 0, speed: 0 },
    race: {
      lap: 1,
      lapStartTime: 0,
      lastLapTime: null,
      bestLapTime: null,
      prevSampleIndex: 0,
      finished: false,
    },
    camera: playerId === 1 ? camera1 : camera2,
    currentCamPos: new THREE.Vector3(startX, 3.6, startZ - 8),
  };
}

const car1 = createCarState(1, 0xff3b3b, TRACK.turnRadius - 2.6, -TRACK.straightLength / 2 + 6);
const car2 = createCarState(2, 0x3b7dff, TRACK.turnRadius + 2.6, -TRACK.straightLength / 2 + 2);
const cars = [car1, car2];

function getControls(playerId) {
  const fallback = { steerAngle: 0, gasPressed: false, brakePressed: false };
  if (playerId === 2) return window.carControls2 || fallback;
  return window.carControls1 || fallback;
}

function updateCarPhysics(state, dt, wallMode) {
  const controls = getControls(state.playerId);
  const physics = state.physics;

  let trackInfo = analyzeTrackPosition(physics.x, physics.z);
  let maxSpeedNow = PHYSICS_PARAMS.maxSpeed;
  if (!wallMode && trackInfo.offTrack) {
    maxSpeedNow = PHYSICS_PARAMS.maxSpeed * PHYSICS_PARAMS.grassMaxSpeedFactor;
  }

  if (controls.gasPressed) {
    physics.speed += PHYSICS_PARAMS.acceleration * dt;
  } else if (controls.brakePressed) {
    physics.speed -= PHYSICS_PARAMS.brakeDeceleration * dt;
  } else {
    const friction = PHYSICS_PARAMS.naturalFriction * dt;
    if (physics.speed > 0) physics.speed = Math.max(0, physics.speed - friction);
    else if (physics.speed < 0) physics.speed = Math.min(0, physics.speed + friction);
  }

  if (!wallMode && trackInfo.offTrack) {
    const grassFriction = PHYSICS_PARAMS.grassFriction * dt;
    if (physics.speed > maxSpeedNow) physics.speed = Math.max(maxSpeedNow, physics.speed - grassFriction);
    if (physics.speed < -maxSpeedNow) physics.speed = Math.min(-maxSpeedNow, physics.speed + grassFriction);
  }

  physics.speed = Math.max(-maxSpeedNow * 0.4, Math.min(maxSpeedNow, physics.speed));

  const speedRatio = Math.min(1, Math.abs(physics.speed) / PHYSICS_PARAMS.maxSpeed);
  const steerRate = PHYSICS_PARAMS.minSteerRate + speedRatio * (PHYSICS_PARAMS.maxSteerRate - PHYSICS_PARAMS.minSteerRate);
  const steerInput = Math.max(-1, Math.min(1, controls.steerAngle || 0));

  if (Math.abs(physics.speed) > 0.3) {
    const direction = physics.speed >= 0 ? 1 : -1;
    physics.heading -= steerInput * steerRate * dt * direction;
  }

  physics.x += Math.sin(physics.heading) * physics.speed * dt;
  physics.z += Math.cos(physics.heading) * physics.speed * dt;

  // --- Limites de terrain ---
  if (wallMode) {
    const info2 = analyzeTrackPosition(physics.x, physics.z);
    if (Math.abs(info2.lateral) > WALL_BOUNDARY) {
      const clamped = Math.sign(info2.lateral) * WALL_BOUNDARY;
      physics.x = info2.px + info2.nx * clamped;
      physics.z = info2.pz + info2.nz * clamped;
      if (Math.abs(physics.speed) > 4) spawnDust(physics.x, physics.z, 5);
      physics.speed *= PHYSICS_PARAMS.wallImpactFactor;
      trackInfo = { ...info2, offTrack: false };
    } else {
      trackInfo = info2;
    }
  } else if (trackInfo.offTrack && Math.abs(physics.speed) > 2) {
    spawnDust(physics.x, physics.z, 2);
  } else if (controls.brakePressed && Math.abs(physics.speed) > PHYSICS_PARAMS.maxSpeed * 0.5) {
    spawnDust(physics.x, physics.z, 1);
  }

  return { steerInput, trackInfo };
}

// ============================================================
// Tours de circuit / chronomètre / victoire
// ============================================================

const raceState = {
  running: false,
  elapsed: 0,
  laps: 3,
  wallMode: false,
};

function updateLapTracking(state) {
  const n = TRACK_SAMPLES;
  const idx = analyzeTrackPosition(state.physics.x, state.physics.z).index;
  const wasNearEnd = state.race.prevSampleIndex > n * 0.85;
  const isNearStart = idx < n * 0.15;
  if (wasNearEnd && isNearStart && state.physics.speed > 0) {
    const lapTime = raceState.elapsed - state.race.lapStartTime;
    if (state.race.lap > 1 || state.race.lapStartTime > 0) {
      state.race.lastLapTime = lapTime;
      if (!state.race.bestLapTime || lapTime < state.race.bestLapTime) {
        state.race.bestLapTime = lapTime;
        syncBestTime(state);
      }
    }
    state.race.lap += 1;
    state.race.lapStartTime = raceState.elapsed;

    if (state.race.lap > raceState.laps && !state.race.finished) {
      finishRace(state);
    }
  }
  state.race.prevSampleIndex = idx;
}

function formatTime(seconds) {
  if (seconds == null) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function syncBestTime(state) {
  if (window.selectedMode !== "solo-timed") return;
  if (state.race.bestLapTime != null && typeof window.saveBestTime === "function") {
    window.saveBestTime("solo-timed", state.race.bestLapTime);
  }
}

// ============================================================
// Caméra de suivi (par voiture)
// ============================================================

const cameraRig = { distance: 8, height: 3.6, lookAtHeight: 1.0, smoothing: 5.2 };
const _desiredCamPos = new THREE.Vector3();

function updateCarCamera(state, dt) {
  const physics = state.physics;
  _desiredCamPos.set(
    physics.x - Math.sin(physics.heading) * cameraRig.distance,
    cameraRig.height,
    physics.z - Math.cos(physics.heading) * cameraRig.distance
  );
  const lerpFactor = 1 - Math.exp(-cameraRig.smoothing * dt);
  state.currentCamPos.lerp(_desiredCamPos, lerpFactor);

  state.camera.position.copy(state.currentCamPos);
  state.camera.lookAt(physics.x, cameraRig.lookAtHeight, physics.z);

  const speedRatio = Math.min(1, Math.abs(physics.speed) / PHYSICS_PARAMS.maxSpeed);
  const targetFov = BASE_FOV + speedRatio * 12;
  state.camera.fov += (targetFov - state.camera.fov) * Math.min(1, dt * 3);
  state.camera.updateProjectionMatrix();
}

// ============================================================
// HUD + mini-carte
// ============================================================

const hudRefs = {
  1: {
    speed: document.getElementById("hud-speed-1"),
    lap: document.getElementById("hud-lap-1"),
    time: document.getElementById("hud-time-1"),
    best: document.getElementById("hud-best-1"),
  },
  2: {
    speed: document.getElementById("hud-speed-2"),
    lap: document.getElementById("hud-lap-2"),
    time: document.getElementById("hud-time-2"),
    best: document.getElementById("hud-best-2"),
  },
};

function updateHud(state) {
  const refs = hudRefs[state.playerId];
  if (!refs) return;
  refs.speed.textContent = String(Math.round(Math.abs(state.physics.speed) * 3.6));
  refs.lap.textContent = `${Math.min(state.race.lap, raceState.laps)}/${raceState.laps}`;
  refs.time.textContent = formatTime(raceState.elapsed - state.race.lapStartTime);
  refs.best.textContent = state.race.bestLapTime != null ? formatTime(state.race.bestLapTime) : "--:--.---";
}

const minimapCanvas = document.getElementById("minimap");
const minimapCtx = minimapCanvas ? minimapCanvas.getContext("2d") : null;

function drawCarDot(ctx, cx, cy, scale, physics, color) {
  const x = cx + physics.x * scale;
  const y = cy + physics.z * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(physics.heading);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(4, 5);
  ctx.lineTo(-4, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawMinimap() {
  if (!minimapCtx) return;
  const w = minimapCanvas.width;
  const h = minimapCanvas.height;
  minimapCtx.clearRect(0, 0, w, h);

  const margin = 14;
  const extent = TRACK.turnRadius + TRACK.straightLength / 2 + 20;
  const scale = Math.min(w, h) / 2 / extent - margin / extent;
  const cx = w / 2;
  const cy = h / 2;

  minimapCtx.beginPath();
  centerPoints.forEach((p, i) => {
    const px = cx + p.x * scale;
    const py = cy + p.z * scale;
    if (i === 0) minimapCtx.moveTo(px, py);
    else minimapCtx.lineTo(px, py);
  });
  minimapCtx.closePath();
  minimapCtx.strokeStyle = "rgba(255,255,255,0.55)";
  minimapCtx.lineWidth = 4;
  minimapCtx.stroke();

  drawCarDot(minimapCtx, cx, cy, scale, car1.physics, "#ff5c5c");
  drawCarDot(minimapCtx, cx, cy, scale, car2.physics, "#4fa3ff");
}

// ============================================================
// Compte à rebours + démarrage / fin de course
// ============================================================

const countdownEl = document.getElementById("countdown");
const finishScreen = document.getElementById("finish-screen");
const finishTitle = document.getElementById("finish-title");
const finishDetail = document.getElementById("finish-detail");
const rematchBtn = document.getElementById("rematch-btn");

let raceLocked = true;

function resetCarState(state, startX, startZ) {
  state.physics.x = startX;
  state.physics.z = startZ;
  state.physics.heading = 0;
  state.physics.speed = 0;
  state.race.lap = 1;
  state.race.lapStartTime = 0;
  state.race.lastLapTime = null;
  state.race.bestLapTime = null;
  state.race.prevSampleIndex = 0;
  state.race.finished = false;
  state.currentCamPos.set(startX, cameraRig.height, startZ - cameraRig.distance);
}

function runCountdown() {
  const steps = ["3", "2", "1", "GO !"];
  let i = 0;
  countdownEl.classList.remove("hidden");
  countdownEl.textContent = steps[i];
  const interval = setInterval(() => {
    i++;
    if (i >= steps.length) {
      clearInterval(interval);
      countdownEl.classList.add("hidden");
      raceLocked = false;
      return;
    }
    countdownEl.textContent = steps[i];
  }, 750);
}

/**
 * Point d'entrée appelé par network.js quand les 2 joueurs sont prêts
 * et que le bouton "Lancer la course" est cliqué.
 */
window.startRace = function startRace() {
  raceState.laps = window.raceSettings.laps || 3;
  raceState.wallMode = !!window.raceSettings.wallMode;
  raceState.elapsed = 0;
  raceState.running = true;

  resetCarState(car1, TRACK.turnRadius - 2.6, -TRACK.straightLength / 2 + 6);
  resetCarState(car2, TRACK.turnRadius + 2.6, -TRACK.straightLength / 2 + 2);

  finishScreen.classList.add("hidden");
  raceLocked = true;
  runCountdown();
};

function finishRace(winnerState) {
  winnerState.race.finished = true;
  raceState.running = false;
  raceLocked = true;

  const loser = winnerState.playerId === 1 ? car2 : car1;
  finishTitle.textContent = `🏁 Joueur ${winnerState.playerId} gagne !`;
  finishTitle.style.color = winnerState.playerId === 1 ? "#ff5c5c" : "#4fa3ff";
  const bestTimeLabel = window.selectedMode === "solo-timed" && typeof window.getBestTime === "function"
    ? `Meilleur chrono : ${formatTime(window.getBestTime("solo-timed"))}`
    : `Meilleur tour J${winnerState.playerId} : ${formatTime(winnerState.race.bestLapTime)}`;

  finishDetail.textContent =
    `Temps total : ${formatTime(raceState.elapsed)}\n` +
    `${bestTimeLabel}\n` +
    `Meilleur tour J${loser.playerId} : ${formatTime(loser.race.bestLapTime)}`;
  rematchBtn.textContent = "🔁 Rejouer";
  finishScreen.classList.remove("hidden");
}

/**
 * Abandon : si un joueur se déconnecte en pleine course, l'autre gagne par forfait.
 */
window.onPlayerLeftDuringRace = function onPlayerLeftDuringRace(player) {
  if (!raceState.running || raceLocked) return;
  const winner = player === 1 ? car2 : car1;
  raceState.running = false;
  raceLocked = true;
  finishTitle.textContent = `🏁 Joueur ${winner.playerId} gagne par forfait !`;
  finishTitle.style.color = winner.playerId === 1 ? "#ff5c5c" : "#4fa3ff";
  finishDetail.textContent = `Joueur ${player} s'est déconnecté.`;
  finishScreen.classList.remove("hidden");
};

rematchBtn.addEventListener("click", () => {
  window.location.reload();
});

// ============================================================
// Boucle d'animation
// ============================================================

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (!raceLocked) {
    raceState.elapsed += dt;
    for (const state of cars) {
      const { steerInput } = updateCarPhysics(state, dt, raceState.wallMode);
      updateLapTracking(state);
      applyVisuals(state, steerInput, dt);
    }
  } else {
    for (const state of cars) applyVisuals(state, 0, dt);
  }

  for (const state of cars) {
    updateCarCamera(state, dt);
    updateHud(state);
  }
  updateDust(dt);
  drawMinimap();

  renderer.setViewport(0, 0, window.innerWidth / 2, window.innerHeight);
  renderer.setScissor(0, 0, window.innerWidth / 2, window.innerHeight);
  renderer.render(scene, camera1);

  renderer.setViewport(window.innerWidth / 2, 0, window.innerWidth / 2, window.innerHeight);
  renderer.setScissor(window.innerWidth / 2, 0, window.innerWidth / 2, window.innerHeight);
  renderer.render(scene, camera2);
}

function applyVisuals(state, steerInput, dt) {
  const { group, frontWheelPivots, rollingWheels, brakeLights } = state.parts;
  group.position.set(state.physics.x, 0, state.physics.z);
  group.rotation.y = state.physics.heading;

  const visualSteerAngle = -steerInput * 0.5;
  frontWheelPivots.forEach((pivot) => (pivot.rotation.y = visualSteerAngle));
  const wheelSpin = (state.physics.speed / 0.42) * dt;
  rollingWheels.forEach((wheel) => (wheel.rotation.x += wheelSpin));

  const braking = !!getControls(state.playerId).brakePressed;
  brakeLights.forEach((bl) => {
    bl.material.emissiveIntensity = braking ? 1.6 : 0.4;
  });
}

animate();
