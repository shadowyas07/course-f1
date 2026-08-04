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
// Textures procedurales (aucun asset externe requis)
// ============================================================

function makeRepeatingCanvasTexture(size, painter, repeatX, repeatY) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  painter(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 2;
  tex.needsUpdate = true;
  return tex;
}

function makeNoise(ctx, size, amount = 1) {
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

function createSurfaceTextures() {
  const grassTexture = makeRepeatingCanvasTexture(
    512,
    (ctx, size) => {
      const grad = ctx.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, "#2f6f2e");
      grad.addColorStop(1, "#3d8839");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 3000; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const a = 0.06 + Math.random() * 0.12;
        ctx.fillStyle = `rgba(${40 + Math.random() * 30}, ${90 + Math.random() * 50}, ${35 + Math.random() * 25}, ${a})`;
        ctx.fillRect(x, y, 2 + Math.random() * 2, 2 + Math.random() * 2);
      }
      makeNoise(ctx, size, 20);
    },
    24,
    24
  );

  const asphaltTexture = makeRepeatingCanvasTexture(
    512,
    (ctx, size) => {
      ctx.fillStyle = "#2a2a30";
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 5200; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const v = 48 + Math.random() * 40;
        const a = 0.08 + Math.random() * 0.2;
        ctx.fillStyle = `rgba(${v}, ${v}, ${v + 4}, ${a})`;
        const r = Math.random() * 1.7 + 0.4;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      makeNoise(ctx, size, 26);
    },
    18,
    18
  );

  return {
    grassTexture,
    asphaltTexture,
  };
}

const SURFACE_TEXTURES = createSurfaceTextures();

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

const PERF = {
  hudInterval: 1 / 12,
  minimapInterval: 1 / 15,
  trackSearchRange: 28,
  fpsUpdateInterval: 0.5,
};

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
  group.add(meshFromRibbon(road, { surface: "road", vertexColors: false }));
  group.add(meshFromRibbon(outerCurb, { surface: "curb", vertexColors: true }));
  group.add(meshFromRibbon(innerCurb, { surface: "curb", vertexColors: true }));
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
  const uvs = [];
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
    const u = (i / n) * 16;
    uvs.push(0, u, 1, u);
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

  return { positions, colors, uvs, indices };
}

function meshFromRibbon({ positions, colors, uvs, indices }, options = {}) {
  const { surface = "road", vertexColors = true } = options;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshPhysicalMaterial({
    map: surface === "road" ? SURFACE_TEXTURES.asphaltTexture : null,
    vertexColors,
    roughness: surface === "road" ? 0.86 : 0.74,
    metalness: surface === "road" ? 0.06 : 0.04,
    clearcoat: surface === "road" ? 0.14 : 0.02,
    clearcoatRoughness: 0.45,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
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
  trunk.castShadow = false;
  tree.add(trunk);
  [1.6, 1.2, 0.8].forEach((r, i) => {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(r, 1.6, 7), leavesMat);
    leaf.position.y = 1.6 + i * 1.05;
    leaf.castShadow = false;
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
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: bodyColor,
    roughness: 0.22,
    metalness: 0.58,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
  });
  const accentMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0b11, roughness: 0.22, metalness: 0.82 });
  const cabinMat = new THREE.MeshPhysicalMaterial({
    color: 0x192133,
    roughness: 0.06,
    metalness: 0.28,
    transmission: 0.58,
    transparent: true,
    opacity: 0.9,
    thickness: 0.2,
  });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95, metalness: 0.05 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xc9d5df, roughness: 0.22, metalness: 1.0 });
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff6cc, emissive: 0xfff2a0, emissiveIntensity: 1.35 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0x220000, emissiveIntensity: 0.45 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.55, 4.2), bodyMat);
  body.position.y = 0.5;
  body.castShadow = true;
  car.add(body);

  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.24, 1.25), bodyMat);
  hood.position.set(0, 0.78, 1.18);
  hood.castShadow = true;
  car.add(hood);

  const frontLip = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.2, 0.3), accentMat);
  frontLip.position.set(0, 0.32, 2.13);
  frontLip.castShadow = true;
  car.add(frontLip);

  const rearDiffuser = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.16, 0.36), accentMat);
  rearDiffuser.position.set(0, 0.34, -2.13);
  rearDiffuser.castShadow = true;
  car.add(rearDiffuser);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 2.0), cabinMat);
  cabin.position.set(0, 0.95, -0.2);
  cabin.castShadow = true;
  car.add(cabin);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.1, 1.28), accentMat);
  roof.position.set(0, 1.25, -0.14);
  roof.castShadow = true;
  car.add(roof);

  for (const x of [-0.95, 0.95]) {
    const sideSkirt = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 2.5), accentMat);
    sideSkirt.position.set(x, 0.34, -0.08);
    sideSkirt.castShadow = true;
    car.add(sideSkirt);
  }

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

  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 22);
  function makeWheel() {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.castShadow = true;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.36, 18), rimMat);
    rim.rotation.z = Math.PI / 2;
    w.add(rim);
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

  const spoilerStandGeo = new THREE.BoxGeometry(0.12, 0.22, 0.1);
  for (const x of [-0.55, 0.55]) {
    const stand = new THREE.Mesh(spoilerStandGeo, accentMat);
    stand.position.set(x, 0.84, -1.99);
    stand.castShadow = true;
    car.add(stand);
  }

  for (const x of [-0.35, 0.35]) {
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.24, 12), rimMat);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(x, 0.34, -2.2);
    car.add(exhaust);
  }

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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
if ("physicallyCorrectLights" in renderer) renderer.physicallyCorrectLights = true;
if ("useLegacyLights" in renderer) renderer.useLegacyLights = false;
if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.setScissorTest(true);
renderer.sortObjects = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x86c5e8);
scene.fog = new THREE.Fog(0x8ec6e2, 130, 380);

function buildSkyDome() {
  const skyGeo = new THREE.SphereGeometry(900, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x87bfe8) },
      horizonColor: { value: new THREE.Color(0xd9f0ff) },
      groundColor: { value: new THREE.Color(0xcbe6ff) },
      sunColor: { value: new THREE.Color(0xffd7a0) },
      sunDirection: { value: new THREE.Vector3(0.53, 0.78, 0.33).normalize() },
    },
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(worldPos.xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      varying vec3 vWorldDir;
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 groundColor;
      uniform vec3 sunColor;
      uniform vec3 sunDirection;

      void main() {
        float y = clamp(vWorldDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 sky = mix(horizonColor, topColor, smoothstep(0.35, 1.0, y));
        sky = mix(groundColor, sky, smoothstep(0.0, 0.35, y));
        float sunDot = max(dot(normalize(vWorldDir), normalize(sunDirection)), 0.0);
        float sunGlow = pow(sunDot, 280.0) + pow(sunDot, 32.0) * 0.22;
        vec3 col = sky + sunColor * sunGlow;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return new THREE.Mesh(skyGeo, skyMat);
}

const skyDome = buildSkyDome();
scene.add(skyDome);

const BASE_FOV = 65;
const camera1 = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1000);
const camera2 = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 1000);

function getSelectedMode() {
  return window.raceSettings?.mode || window.selectedMode || "duel";
}

function isSoloMode() {
  const mode = getSelectedMode();
  return typeof mode === "string" && mode.startsWith("solo");
}

const QUALITY_LEVELS = [
  {
    name: "LOW",
    soloPixelRatio: 0.85,
    duelPixelRatio: 0.7,
    shadows: false,
    shadowMapSize: 1024,
    dustLimit: 100,
    dustSpawnScale: 0.5,
    hudInterval: 1 / 10,
    minimapInterval: 1 / 8,
    showSky: false,
  },
  {
    name: "MED",
    soloPixelRatio: 1.0,
    duelPixelRatio: 0.85,
    shadows: true,
    shadowMapSize: 1024,
    dustLimit: 150,
    dustSpawnScale: 0.72,
    hudInterval: 1 / 12,
    minimapInterval: 1 / 12,
    showSky: true,
  },
  {
    name: "HIGH",
    soloPixelRatio: 1.2,
    duelPixelRatio: 1.0,
    shadows: true,
    shadowMapSize: 1536,
    dustLimit: 220,
    dustSpawnScale: 1.0,
    hudInterval: 1 / 15,
    minimapInterval: 1 / 15,
    showSky: true,
  },
];

let qualityLevel = 1;
let qualityCooldown = 0;

function currentQuality() {
  return QUALITY_LEVELS[qualityLevel];
}

function targetPixelRatio() {
  const q = currentQuality();
  return Math.min(window.devicePixelRatio, isSoloMode() ? q.soloPixelRatio : q.duelPixelRatio);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const solo = isSoloMode();
  const viewW = solo ? w : w / 2;

  camera1.aspect = viewW / h;
  camera1.updateProjectionMatrix();

  if (!solo) {
    camera2.aspect = viewW / h;
    camera2.updateProjectionMatrix();
  }

  renderer.setSize(w, h);
  renderer.setPixelRatio(targetPixelRatio());
}
window.addEventListener("resize", onResize);
onResize();

// --- Lumières ---
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x6d9e5f, 0.95));
const sunLight = new THREE.DirectionalLight(0xfff0d0, 2.2);
sunLight.position.set(80, 120, 40);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1024, 1024);
sunLight.shadow.camera.left = -140;
sunLight.shadow.camera.right = 140;
sunLight.shadow.camera.top = 140;
sunLight.shadow.camera.bottom = -140;
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 400;
sunLight.shadow.normalBias = 0.028;
sunLight.shadow.bias = -0.00008;
scene.add(sunLight);

const fillLight = new THREE.DirectionalLight(0x9ec3ff, 0.38);
fillLight.position.set(-95, 52, -75);
scene.add(fillLight);

function applyQualitySettings() {
  const q = currentQuality();
  PERF.hudInterval = q.hudInterval;
  PERF.minimapInterval = q.minimapInterval;
  skyDome.visible = q.showSky;

  renderer.shadowMap.enabled = q.shadows;
  sunLight.castShadow = q.shadows;
  if (q.shadows) {
    sunLight.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    sunLight.shadow.needsUpdate = true;
  }

  activeDustLimit = q.dustLimit;
  dustSpawnScale = q.dustSpawnScale;

  renderer.setPixelRatio(targetPixelRatio());
}

// --- Sol ---
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshStandardMaterial({
    map: SURFACE_TEXTURES.grassTexture,
    color: 0xffffff,
    roughness: 0.93,
    metalness: 0.02,
  })
);
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
let dustNeedsUpload = false;
let activeDustLimit = DUST_COUNT;
let dustSpawnScale = 1;
for (let i = 0; i < DUST_COUNT; i++) dustPositions[i * 3 + 1] = -100;
dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
const dustMat = new THREE.PointsMaterial({ color: 0xcabf9a, size: 0.35, transparent: true, opacity: 0.8, depthWrite: false });
scene.add(new THREE.Points(dustGeo, dustMat));
let dustCursor = 0;

function spawnDust(x, z, count) {
  const spawnCount = Math.max(1, Math.floor(count * dustSpawnScale));
  for (let n = 0; n < spawnCount; n++) {
    const i = dustCursor;
    dustCursor = (dustCursor + 1) % activeDustLimit;
    dustPositions[i * 3] = x + (Math.random() - 0.5) * 0.6;
    dustPositions[i * 3 + 1] = 0.1;
    dustPositions[i * 3 + 2] = z + (Math.random() - 0.5) * 0.6;
    dustVelocities[i].set((Math.random() - 0.5) * 1.5, 1 + Math.random() * 1.2, (Math.random() - 0.5) * 1.5);
    dustLife[i] = 0.6 + Math.random() * 0.4;
  }
  dustNeedsUpload = true;
}

function updateDust(dt) {
  let dirty = false;
  for (let i = 0; i < activeDustLimit; i++) {
    if (dustLife[i] <= 0) continue;
    dustLife[i] -= dt;
    if (dustLife[i] <= 0) {
      dustPositions[i * 3 + 1] = -100;
      dirty = true;
      continue;
    }
    dustPositions[i * 3] += dustVelocities[i].x * dt;
    dustPositions[i * 3 + 1] += dustVelocities[i].y * dt;
    dustPositions[i * 3 + 2] += dustVelocities[i].z * dt;
    dustVelocities[i].y -= 2.5 * dt;
    dirty = true;
  }
  if (dirty || dustNeedsUpload) {
    dustGeo.attributes.position.needsUpdate = true;
    dustNeedsUpload = false;
  }
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
  handbrakeDeceleration: 16,
  handbrakeSteerBoost: 2.1,
  handbrakeMinSpeed: 7,
  handbrakeSlipBoost: 1.45,
  driftBuildRate: 4.4,
  driftRecoverRate: 2.2,
  driftSustainRecoverRate: 0.95,
  driftMinSteer: 0.12,
  driftMaxAngle: 0.7,
};

/**
 * Trouve le point le plus proche de la ligne centrale, la distance latérale
 * signée, la normale au circuit à cet endroit, et si on est hors piste.
 */
function analyzeTrackPositionFull(x, z) {
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

function analyzeTrackPositionFast(x, z, guessIndex = 0) {
  const n = centerPoints.length;
  const range = PERF.trackSearchRange;
  let bestIndex = ((guessIndex % n) + n) % n;
  let bestDistSq = Infinity;

  for (let k = -range; k <= range; k++) {
    const i = (bestIndex + k + n) % n;
    const p = centerPoints[i];
    const dx = x - p.x;
    const dz = z - p.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIndex = i;
    }
  }

  // Si la recherche locale échoue (ex: gros teleport), fallback robuste.
  if (bestDistSq > 900) {
    return analyzeTrackPositionFull(x, z);
  }

  const p = centerPoints[bestIndex];
  const next = centerPoints[(bestIndex + 1) % n];
  const prev = centerPoints[(bestIndex - 1 + n) % n];
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
    physics: { x: startX, z: startZ, heading: 0, speed: 0, driftYaw: 0 },
    race: {
      lap: 1,
      lapStartTime: 0,
      lastLapTime: null,
      bestLapTime: null,
      prevSampleIndex: 0,
      finished: false,
    },
    uiCache: { speed: "", lap: "", time: "", best: "" },
    camera: playerId === 1 ? camera1 : camera2,
    currentCamPos: new THREE.Vector3(startX, 3.6, startZ - 8),
  };
}

const car1 = createCarState(1, 0xff3b3b, TRACK.turnRadius - 2.6, -TRACK.straightLength / 2 + 6);
const car2 = createCarState(2, 0x3b7dff, TRACK.turnRadius + 2.6, -TRACK.straightLength / 2 + 2);
const cars = [car1, car2];
const soloCars = [car1];

function getActiveCars() {
  return isSoloMode() ? soloCars : cars;
}

function createShadowBlob() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(size / 2, size / 2, 10, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(0, 0, 0, 0.45)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;

  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 6.2), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 0.03;
  return plane;
}

for (const state of cars) {
  state.parts.shadowBlob = createShadowBlob();
  scene.add(state.parts.shadowBlob);
}

function applyModeVisualState() {
  const solo = isSoloMode();
  const splitDivider = document.getElementById("split-divider");
  const splitDividerChip = document.querySelector(".split-divider-chip");
  const hud2 = document.getElementById("hud-2");
  const minimapLegendP2 = document.querySelector("#minimap-wrap .legend-2");

  car2.parts.group.visible = !solo;
  if (car2.parts.shadowBlob) car2.parts.shadowBlob.visible = !solo;

  if (splitDivider) splitDivider.style.display = solo ? "none" : "block";
  if (splitDividerChip) splitDividerChip.style.display = solo ? "none" : "block";
  if (hud2) hud2.style.display = solo ? "none" : "block";
  if (minimapLegendP2) minimapLegendP2.style.display = solo ? "none" : "inline-flex";
}

window.addEventListener("mode-changed", () => {
  applyModeVisualState();
  onResize();
});
applyModeVisualState();

function getControls(playerId) {
  const fallback = { steerAngle: 0, gasPressed: false, brakePressed: false, handbrakePressed: false };
  if (playerId === 2) return window.carControls2 || fallback;
  return window.carControls1 || fallback;
}

function updateCarPhysics(state, dt, wallMode) {
  const controls = getControls(state.playerId);
  const physics = state.physics;

  let trackInfo = analyzeTrackPositionFast(physics.x, physics.z, state.race.prevSampleIndex);
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
  const handbrakeActive = !!controls.handbrakePressed;
  let steerRate = PHYSICS_PARAMS.minSteerRate + speedRatio * (PHYSICS_PARAMS.maxSteerRate - PHYSICS_PARAMS.minSteerRate);
  if (handbrakeActive) {
    steerRate *= PHYSICS_PARAMS.handbrakeSteerBoost;
  }
  const steerInput = Math.max(-1, Math.min(1, controls.steerAngle || 0));

  if (Math.abs(physics.speed) > 0.3) {
    const direction = physics.speed >= 0 ? 1 : -1;
    physics.heading -= steerInput * steerRate * dt * direction;
  }

  if (handbrakeActive) {
    const hb = PHYSICS_PARAMS.handbrakeDeceleration * dt;
    if (physics.speed > 0) physics.speed = Math.max(0, physics.speed - hb);
    else if (physics.speed < 0) physics.speed = Math.min(0, physics.speed + hb);
  }

  const speedAbs = Math.abs(physics.speed);
  const steerAbs = Math.abs(steerInput);
  const canDrift = handbrakeActive
    && speedAbs > PHYSICS_PARAMS.handbrakeMinSpeed
    && steerAbs > PHYSICS_PARAMS.driftMinSteer;
  if (canDrift) {
    const driftSpeedRatio = Math.min(1, speedAbs / (PHYSICS_PARAMS.maxSpeed * 0.9));
    const driftTarget = steerInput
      * PHYSICS_PARAMS.driftMaxAngle
      * (0.55 + driftSpeedRatio * 0.95)
      * PHYSICS_PARAMS.handbrakeSlipBoost;
    physics.driftYaw += (driftTarget - physics.driftYaw) * Math.min(1, dt * PHYSICS_PARAMS.driftBuildRate);
  } else {
    const sustainDrift = speedAbs > PHYSICS_PARAMS.handbrakeMinSpeed * 0.75 && steerAbs > 0.22;
    const recoverRate = sustainDrift
      ? PHYSICS_PARAMS.driftSustainRecoverRate
      : PHYSICS_PARAMS.driftRecoverRate;
    physics.driftYaw += (0 - physics.driftYaw) * Math.min(1, dt * recoverRate);
  }

  const motionHeading = physics.heading + physics.driftYaw;
  physics.x += Math.sin(motionHeading) * physics.speed * dt;
  physics.z += Math.cos(motionHeading) * physics.speed * dt;

  // --- Limites de terrain ---
  if (wallMode) {
    const info2 = analyzeTrackPositionFast(physics.x, physics.z, trackInfo.index);
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
  } else if (canDrift && Math.abs(steerInput) > 0.2) {
    spawnDust(physics.x, physics.z, 2);
  } else if (controls.brakePressed && Math.abs(physics.speed) > PHYSICS_PARAMS.maxSpeed * 0.5) {
    spawnDust(physics.x, physics.z, 1);
  }

  return { steerInput, trackInfo, handbrakeActive };
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

// ============================================================
// Audio runtime (moteur + countdown + victoire)
// ============================================================

const audioState = {
  ctx: null,
  masterGain: null,
  unlocked: false,
  carSounds: {
    1: { osc: null, gain: null },
    2: { osc: null, gain: null },
  },
};

function ensureAudioContext() {
  if (audioState.ctx) return audioState.ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  const master = ctx.createGain();
  master.gain.value = 0.18;
  master.connect(ctx.destination);
  audioState.ctx = ctx;
  audioState.masterGain = master;
  return ctx;
}

function initCarEngineAudio(playerId) {
  const ctx = ensureAudioContext();
  if (!ctx || !audioState.masterGain) return;
  const slot = audioState.carSounds[playerId];
  if (!slot || slot.osc) return;

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = 85;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 900;

  const gain = ctx.createGain();
  gain.gain.value = 0;

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(audioState.masterGain);
  osc.start();

  slot.osc = osc;
  slot.gain = gain;
}

function unlockAudio() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  initCarEngineAudio(1);
  initCarEngineAudio(2);
  audioState.unlocked = true;
}

window.enableGameAudio = unlockAudio;

function scheduleTone(freq, duration, type = "square", startAt = 0, volume = 0.16) {
  const ctx = ensureAudioContext();
  if (!ctx || !audioState.masterGain) return;
  const t0 = ctx.currentTime + startAt;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain);
  gain.connect(audioState.masterGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.04);
}

function playCountdownAudio(stepText) {
  if (!audioState.unlocked) return;
  if (stepText === "GO !") {
    scheduleTone(680, 0.2, "triangle", 0.0, 0.18);
    scheduleTone(980, 0.28, "triangle", 0.12, 0.16);
    return;
  }
  scheduleTone(480, 0.14, "square", 0, 0.12);
}

function playVictoryAudio(playerId) {
  if (!audioState.unlocked) return;
  const shift = playerId === 1 ? 0 : 30;
  scheduleTone(520 + shift, 0.16, "triangle", 0.0, 0.16);
  scheduleTone(650 + shift, 0.2, "triangle", 0.14, 0.15);
  scheduleTone(780 + shift, 0.26, "triangle", 0.32, 0.15);
}

function updateCarEngineAudio(state, dt) {
  if (!audioState.unlocked) return;
  const slot = audioState.carSounds[state.playerId];
  if (!slot || !slot.osc || !slot.gain || !audioState.ctx) return;

  const speedRatio = Math.min(1, Math.abs(state.physics.speed) / PHYSICS_PARAMS.maxSpeed);
  const controls = getControls(state.playerId);
  const throttleBoost = controls.gasPressed ? 0.18 : 0;
  const targetFreq = 90 + speedRatio * 220 + throttleBoost * 120;
  const targetGain = raceLocked ? 0.0001 : 0.03 + speedRatio * 0.08 + throttleBoost * 0.04;
  const smooth = Math.min(1, dt * 8);

  const currentFreq = slot.osc.frequency.value;
  const currentGain = slot.gain.gain.value;
  slot.osc.frequency.setValueAtTime(currentFreq + (targetFreq - currentFreq) * smooth, audioState.ctx.currentTime);
  slot.gain.gain.setValueAtTime(currentGain + (targetGain - currentGain) * smooth, audioState.ctx.currentTime);
}

function updateLapTracking(state, trackIndex = null) {
  const n = TRACK_SAMPLES;
  const idx = trackIndex == null ? analyzeTrackPositionFast(state.physics.x, state.physics.z, state.race.prevSampleIndex).index : trackIndex;
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
  const newFov = state.camera.fov + (targetFov - state.camera.fov) * Math.min(1, dt * 3);
  if (Math.abs(newFov - state.camera.fov) > 0.02) {
    state.camera.fov = newFov;
    state.camera.updateProjectionMatrix();
  }
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

  const speed = String(Math.round(Math.abs(state.physics.speed) * 3.6));
  const lap = `${Math.min(state.race.lap, raceState.laps)}/${raceState.laps}`;
  const time = formatTime(raceState.elapsed - state.race.lapStartTime);
  const best = state.race.bestLapTime != null ? formatTime(state.race.bestLapTime) : "--:--.---";

  if (state.uiCache.speed !== speed) {
    refs.speed.textContent = speed;
    state.uiCache.speed = speed;
  }
  if (state.uiCache.lap !== lap) {
    refs.lap.textContent = lap;
    state.uiCache.lap = lap;
  }
  if (state.uiCache.time !== time) {
    refs.time.textContent = time;
    state.uiCache.time = time;
  }
  if (state.uiCache.best !== best) {
    refs.best.textContent = best;
    state.uiCache.best = best;
  }
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
  if (!isSoloMode()) {
    drawCarDot(minimapCtx, cx, cy, scale, car2.physics, "#4fa3ff");
  }
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
  state.physics.driftYaw = 0;
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
  playCountdownAudio(steps[i]);
  const interval = setInterval(() => {
    i++;
    if (i >= steps.length) {
      clearInterval(interval);
      countdownEl.classList.add("hidden");
      raceLocked = false;
      return;
    }
    countdownEl.textContent = steps[i];
    playCountdownAudio(steps[i]);
  }, 750);
}

/**
 * Point d'entrée appelé par network.js quand les 2 joueurs sont prêts
 * et que le bouton "Lancer la course" est cliqué.
 */
window.startRace = function startRace() {
  const solo = isSoloMode();

  unlockAudio();
  raceState.laps = window.raceSettings.laps || 3;
  raceState.wallMode = !!window.raceSettings.wallMode;
  raceState.elapsed = 0;
  raceState.running = true;

  resetCarState(car1, TRACK.turnRadius - 2.6, -TRACK.straightLength / 2 + 6);
  if (!solo) {
    resetCarState(car2, TRACK.turnRadius + 2.6, -TRACK.straightLength / 2 + 2);
  }

  applyModeVisualState();
  onResize();

  finishScreen.classList.add("hidden");
  raceLocked = true;
  runCountdown();
};

function finishRace(winnerState) {
  const solo = isSoloMode();

  winnerState.race.finished = true;
  raceState.running = false;
  raceLocked = true;
  playVictoryAudio(winnerState.playerId);

  const loser = winnerState.playerId === 1 ? car2 : car1;
  finishTitle.textContent = solo ? "🏁 Run termine !" : `🏁 Joueur ${winnerState.playerId} gagne !`;
  finishTitle.style.color = winnerState.playerId === 1 ? "#ff5c5c" : "#4fa3ff";
  const bestTimeLabel = window.selectedMode === "solo-timed" && typeof window.getBestTime === "function"
    ? `Meilleur chrono : ${formatTime(window.getBestTime("solo-timed"))}`
    : `Meilleur tour J${winnerState.playerId} : ${formatTime(winnerState.race.bestLapTime)}`;

  finishDetail.textContent = solo
    ? `Temps total : ${formatTime(raceState.elapsed)}\n${bestTimeLabel}`
    :
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
  if (isSoloMode()) return;
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
  const mode = window.selectedMode || "duel";
  const isSolo = mode === "solo-timed" || mode === "solo-free";
  const canReplay = isSolo ? window.carControls1?.connected : window.carControls1?.connected && window.carControls2?.connected;
  if (!canReplay) {
    finishTitle.textContent = "Connexion manette requise";
    finishTitle.style.color = "#ffc93c";
    finishDetail.textContent = isSolo
      ? "Le pilote doit rester connecté pour rejouer."
      : "Les deux pilotes doivent rester connectés pour relancer immédiatement.";
    return;
  }
  rematchBtn.textContent = "🚦 Relance...";
  setTimeout(() => {
    rematchBtn.textContent = "🔁 Rejouer";
    window.startRace();
  }, 120);
});

// ============================================================
// Boucle d'animation
// ============================================================

const clock = new THREE.Clock();
let hudAccumulator = 0;
let minimapAccumulator = 0;
let fpsAccumulator = 0;
let fpsFrames = 0;
let lowFpsTime = 0;
let highFpsTime = 0;

const fpsBadge = document.createElement("div");
fpsBadge.style.position = "fixed";
fpsBadge.style.right = "14px";
fpsBadge.style.top = "14px";
fpsBadge.style.zIndex = "99";
fpsBadge.style.padding = "6px 10px";
fpsBadge.style.fontFamily = "monospace";
fpsBadge.style.fontSize = "12px";
fpsBadge.style.color = "#e9f9ff";
fpsBadge.style.background = "rgba(3, 10, 16, 0.58)";
fpsBadge.style.border = "1px solid rgba(90, 190, 220, 0.35)";
fpsBadge.style.borderRadius = "8px";
fpsBadge.style.backdropFilter = "blur(4px)";
fpsBadge.textContent = "FPS: -- | Q: MED";
document.body.appendChild(fpsBadge);

function maybeAdaptQuality(fps, dt) {
  if (qualityCooldown > 0) {
    qualityCooldown -= dt;
    return;
  }

  if (fps < 34) {
    lowFpsTime += dt;
    highFpsTime = 0;
  } else if (fps > 56) {
    highFpsTime += dt;
    lowFpsTime = 0;
  } else {
    lowFpsTime = 0;
    highFpsTime = 0;
  }

  if (lowFpsTime > 1.2 && qualityLevel > 0) {
    qualityLevel -= 1;
    applyQualitySettings();
    qualityCooldown = 2.2;
    lowFpsTime = 0;
    highFpsTime = 0;
  } else if (highFpsTime > 4 && qualityLevel < QUALITY_LEVELS.length - 1) {
    qualityLevel += 1;
    applyQualitySettings();
    qualityCooldown = 2.8;
    lowFpsTime = 0;
    highFpsTime = 0;
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const rawDt = clock.elapsedTime ? dt : dt;
  const activeCars = getActiveCars();

  if (!raceLocked) {
    raceState.elapsed += dt;
    for (const state of activeCars) {
      const { steerInput, trackInfo, handbrakeActive } = updateCarPhysics(state, dt, raceState.wallMode);
      updateLapTracking(state, trackInfo.index);
      applyVisuals(state, steerInput, dt, handbrakeActive);
    }
  } else {
    for (const state of activeCars) applyVisuals(state, 0, dt, false);
  }

  hudAccumulator += dt;
  minimapAccumulator += dt;

  for (const state of activeCars) {
    updateCarCamera(state, dt);
    if (hudAccumulator >= PERF.hudInterval) updateHud(state);
    updateCarEngineAudio(state, dt);
  }
  if (hudAccumulator >= PERF.hudInterval) hudAccumulator = 0;

  updateDust(dt);
  if (minimapAccumulator >= PERF.minimapInterval) {
    drawMinimap();
    minimapAccumulator = 0;
  }

  fpsFrames += 1;
  fpsAccumulator += rawDt;
  if (fpsAccumulator >= PERF.fpsUpdateInterval) {
    const fps = Math.round(fpsFrames / fpsAccumulator);
    maybeAdaptQuality(fps, fpsAccumulator);
    fpsBadge.textContent = `FPS: ${fps} | Q: ${currentQuality().name}`;
    fpsFrames = 0;
    fpsAccumulator = 0;
  }

  if (isSoloMode()) {
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.setScissor(0, 0, window.innerWidth, window.innerHeight);
    renderer.render(scene, camera1);
  } else {
    renderer.setViewport(0, 0, window.innerWidth / 2, window.innerHeight);
    renderer.setScissor(0, 0, window.innerWidth / 2, window.innerHeight);
    renderer.render(scene, camera1);

    renderer.setViewport(window.innerWidth / 2, 0, window.innerWidth / 2, window.innerHeight);
    renderer.setScissor(window.innerWidth / 2, 0, window.innerWidth / 2, window.innerHeight);
    renderer.render(scene, camera2);
  }
}

applyQualitySettings();

function applyVisuals(state, steerInput, dt, handbrakeActive) {
  const { group, frontWheelPivots, rollingWheels, brakeLights } = state.parts;
  group.position.set(state.physics.x, 0, state.physics.z);
  group.rotation.y = state.physics.heading;

  if (state.parts.shadowBlob) {
    state.parts.shadowBlob.position.set(state.physics.x, 0.03, state.physics.z);
    const speedFactor = Math.min(1, Math.abs(state.physics.speed) / PHYSICS_PARAMS.maxSpeed);
    state.parts.shadowBlob.material.opacity = 0.24 + speedFactor * 0.16;
  }

  const visualSteerAngle = -steerInput * 0.5;
  frontWheelPivots.forEach((pivot) => (pivot.rotation.y = visualSteerAngle));
  const wheelSpin = (state.physics.speed / 0.42) * dt;
  rollingWheels.forEach((wheel) => (wheel.rotation.x += wheelSpin));

  const braking = !!getControls(state.playerId).brakePressed;
  brakeLights.forEach((bl) => {
    bl.material.emissiveIntensity = braking || handbrakeActive ? 1.6 : 0.4;
  });
}

animate();
