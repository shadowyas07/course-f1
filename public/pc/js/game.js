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
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { buildSpaTrack } from "./track-spa.js";

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
      grad.addColorStop(0, "#1f7131");
      grad.addColorStop(0.6, "#4ea93b");
      grad.addColorStop(1, "#7ddc52");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 3000; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const a = 0.08 + Math.random() * 0.14;
        ctx.fillStyle = `rgba(${42 + Math.random() * 28}, ${118 + Math.random() * 42}, ${36 + Math.random() * 28}, ${a})`;
        ctx.fillRect(x, y, 2 + Math.random() * 2, 2 + Math.random() * 2);
      }
      makeNoise(ctx, size, 24);
    },
    24,
    24
  );

  const asphaltTexture = makeRepeatingCanvasTexture(
    512,
    (ctx, size) => {
      ctx.fillStyle = "#171923";
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 5200; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const v = 58 + Math.random() * 36;
        const a = 0.09 + Math.random() * 0.18;
        ctx.fillStyle = `rgba(${v}, ${v}, ${v + 6}, ${a})`;
        const r = Math.random() * 1.7 + 0.4;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      makeNoise(ctx, size, 30);
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
// Configuration du circuit (layout inspire de Spa-Francorchamps)
// ============================================================
const TRACK = {
  roadHalfWidth: 8.1,
  curbWidth: 1.15,
  perimeter: 0,
};
const WALL_BOUNDARY = TRACK.roadHalfWidth + TRACK.curbWidth;
const TRACK_SAMPLES = 800;
const centerPoints = [];

function buildTrackArcLengths(points) {
  const lengths = [0];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.z - a.z);
    lengths.push(total);
  }
  return { lengths, total };
}

let trackArc = { lengths: [0], total: 1 };

function trackPointAt(distance) {
  const perimeter = TRACK.perimeter;
  let s = ((distance % perimeter) + perimeter) % perimeter;
  const lengths = trackArc.lengths;
  const n = centerPoints.length;

  let seg = 0;
  while (seg < n && lengths[seg + 1] < s) seg += 1;
  const a = centerPoints[seg % n];
  const b = centerPoints[(seg + 1) % n];
  const segStart = lengths[seg];
  const segLen = Math.max(0.0001, lengths[seg + 1] - segStart);
  const t = (s - segStart) / segLen;
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function trackFrameAt(distance) {
  const p = trackPointAt(distance);
  const p2 = trackPointAt(distance + 0.9);
  const tx = p2.x - p.x;
  const tz = p2.z - p.z;
  const len = Math.hypot(tx, tz) || 1;
  const dirX = tx / len;
  const dirZ = tz / len;
  return {
    x: p.x,
    z: p.z,
    tx: dirX,
    tz: dirZ,
    nx: -dirZ,
    nz: dirX,
  };
}

function computeTrackBounds(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    centerX: (minX + maxX) * 0.5,
    centerZ: (minZ + maxZ) * 0.5,
    halfExtent: Math.max(maxX - minX, maxZ - minZ) * 0.5,
  };
}

let TRACK_BOUNDS = {
  minX: -40,
  maxX: 40,
  minZ: -40,
  maxZ: 40,
  centerX: 0,
  centerZ: 0,
  halfExtent: 40,
};
let START_DISTANCE = 0;

function buildStartGrid() {
  const laneOffset = 2.6;
  const frame1 = trackFrameAt(START_DISTANCE - 4.8);
  const frame2 = trackFrameAt(START_DISTANCE - 7.2);
  const heading = Math.atan2(frame1.tx, frame1.tz);
  return {
    car1: { x: frame1.x + frame1.nx * laneOffset, z: frame1.z + frame1.nz * laneOffset, heading },
    car2: { x: frame2.x - frame2.nx * laneOffset, z: frame2.z - frame2.nz * laneOffset, heading },
  };
}

let START_GRID = {
  car1: { x: -2.6, z: 0, heading: 0 },
  car2: { x: 2.6, z: -4, heading: 0 },
};

function initializeSpaTrack(sceneRef) {
  const spaTrack = buildSpaTrack(sceneRef, THREE, {
    roadWidth: TRACK.roadHalfWidth * 2,
    addGround: false,
  });

  // On garde la piste procedurale pour la physique/laps, mais on masque son visuel
  // pour afficher uniquement le vrai circuit GLB.
  if (spaTrack.roadMesh) spaTrack.roadMesh.visible = false;
  if (spaTrack.curbMesh) spaTrack.curbMesh.visible = false;
  if (spaTrack.startLine) spaTrack.startLine.visible = false;

  centerPoints.length = 0;
  for (const p of spaTrack.centerPoints) {
    centerPoints.push({ x: p.x, z: p.z });
  }

  trackArc = buildTrackArcLengths(centerPoints);
  TRACK.perimeter = trackArc.total;
  TRACK_BOUNDS = computeTrackBounds(centerPoints);
  START_DISTANCE = TRACK.perimeter * 0.012;

  START_GRID = {
    car1: { x: spaTrack.startPositions[0].x, z: spaTrack.startPositions[0].z, heading: spaTrack.startRotation },
    car2: { x: spaTrack.startPositions[1].x, z: spaTrack.startPositions[1].z, heading: spaTrack.startRotation },
  };

  return spaTrack;
}

async function loadTrackGlbVisual(sceneRef, bounds) {
  const loader = new GLTFLoader();
  try {
    const gltf = await loader.loadAsync("assets/tracks/race-track-23mb/source/track.glb");
    const model = gltf.scene;

    model.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = true;
      if (obj.material) {
        obj.material.side = THREE.DoubleSide;
      }
    });

    // Certains GLB arrivent avec un axe different (piste verticale). On cherche
    // automatiquement l'orientation la plus "plate".
    const xCandidates = [0, -Math.PI / 2, Math.PI / 2, Math.PI];
    const zCandidates = [0, -Math.PI / 2, Math.PI / 2, Math.PI];
    let best = { rx: 0, rz: 0, score: Infinity };
    const testBox = new THREE.Box3();
    const testSize = new THREE.Vector3();

    for (const rx of xCandidates) {
      for (const rz of zCandidates) {
        model.rotation.set(rx, 0, rz);
        model.updateMatrixWorld(true);
        testBox.setFromObject(model);
        testBox.getSize(testSize);
        const flatScore = testSize.y / Math.max(1e-3, testSize.x + testSize.z);
        if (flatScore < best.score) {
          best = { rx, rz, score: flatScore };
        }
      }
    }

    model.rotation.set(best.rx, 0, best.rz);
    model.updateMatrixWorld(true);

    let box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const targetX = Math.max(10, bounds.maxX - bounds.minX);
    const targetZ = Math.max(10, bounds.maxZ - bounds.minZ);
    const sx = targetX / Math.max(0.001, size.x);
    const sz = targetZ / Math.max(0.001, size.z);
    const scale = Math.min(sx, sz);
    model.scale.setScalar(scale);

    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    box.getCenter(center);

    model.position.x = bounds.centerX - center.x;
    model.position.z = bounds.centerZ - center.z;
    model.position.y += 0.03 - box.min.y;

    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    const ySpan = box.max.y - box.min.y;
    console.log("[track] GLB orientation/fit:", {
      rx: best.rx,
      rz: best.rz,
      scale,
      minY: box.min.y,
      maxY: box.max.y,
      ySpan,
    });

    sceneRef.add(model);
    console.log("[track] GLB piste chargee:", "assets/tracks/race-track-23mb/source/track.glb");
  } catch (error) {
    console.warn("[track] Echec chargement GLB, fallback piste procedurale.", error);
  }
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
  group.add(buildTrackCenterLine());
  group.add(buildTrackDecorations());
  group.add(buildStartLine());
  return group;
}

function buildTrackCenterLine() {
  const points = centerPoints.map((p) => new THREE.Vector3(p.x, 0.045, p.z));
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: 0xffdd99,
    transparent: true,
    opacity: 0.72,
  });
  const line = new THREE.LineLoop(geometry, material);
  line.renderOrder = 2;
  line.frustumCulled = false;
  return line;
}

function buildTrackDecorations() {
  const group = new THREE.Group();
  const markerCount = 24;
  for (let i = 0; i < markerCount; i++) {
    const s = (i / markerCount) * TRACK.perimeter + 3.4;
    const p = trackPointAt(s);
    const s2 = trackPointAt(s + 0.8);
    const tx = s2.x - p.x;
    const tz = s2.z - p.z;
    const len = Math.hypot(tx, tz) || 1;
    const nx = -tz / len;
    const nz = tx / len;
    const side = i % 2 === 0 ? 1 : -1;
    const dist = TRACK.roadHalfWidth + TRACK.curbWidth + 4.8 + (i % 3) * 1.2;

    const marker = new THREE.Group();
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x704427, roughness: 0.95 });
    const headMat = new THREE.MeshStandardMaterial({
      color: i % 2 === 0 ? 0xff7d2b : 0xf4efe8,
      emissive: i % 2 === 0 ? 0x552200 : 0x2a2a2a,
      emissiveIntensity: 0.7,
      roughness: 0.35,
    });
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.9, 0.16), baseMat);
    base.position.y = 0.45;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.24, 0.22), headMat);
    head.position.y = 1.06;
    marker.add(base);
    marker.add(head);
    marker.position.set(p.x + nx * dist * side, 0, p.z + nz * dist * side);
    marker.rotation.y = Math.atan2(nx, nz) + Math.PI / 2;
    group.add(marker);
  }
  return group;
}

function buildStartLine() {
  const group = new THREE.Group();
  const frame = trackFrameAt(START_DISTANCE);
  const cols = 10;
  const tileW = (TRACK.roadHalfWidth * 2) / cols;
  const tileD = 1.6;
  for (let i = 0; i < cols; i++) {
    const even = i % 2 === 0;
    const mat = new THREE.MeshStandardMaterial({ color: even ? 0xffffff : 0x111111, roughness: 0.8 });
    const tile = new THREE.Mesh(new THREE.PlaneGeometry(tileW, tileD), mat);
    tile.rotation.x = -Math.PI / 2;
    const lateral = -TRACK.roadHalfWidth + tileW * i + tileW / 2;
    tile.position.set(frame.x + frame.nx * lateral, 0.03, frame.z + frame.nz * lateral);
    tile.rotation.y = Math.atan2(frame.tx, frame.tz);
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
  mesh.castShadow = surface !== "road";
  mesh.receiveShadow = true;
  return mesh;
}

// ============================================================
// Décor
// ============================================================

function buildScenery() {
  const group = new THREE.Group();
  const minClear = TRACK.roadHalfWidth + TRACK.curbWidth + 6;
  const count = 90;
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.32, 1.6, 6);
  const leafGeo = new THREE.ConeGeometry(1.2, 1.6, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6c3f22, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({
    color: 0x4bae4d,
    emissive: 0x10240d,
    emissiveIntensity: 0.16,
    roughness: 0.82,
  });

  const trunkInstanced = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  trunkInstanced.castShadow = true;
  trunkInstanced.receiveShadow = true;
  const leafInstanced = new THREE.InstancedMesh(leafGeo, leafMat, count);
  leafInstanced.castShadow = true;
  leafInstanced.receiveShadow = true;

  const trunkDummy = new THREE.Object3D();
  const leafDummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const s = (i / count) * TRACK.perimeter + (Math.random() - 0.5) * 4;
    const frame = trackFrameAt(s);
    const side = i % 2 === 0 ? 1 : -1;
    const dist = minClear + Math.random() * 22;
    const scale = 0.8 + Math.random() * 0.7;

    trunkDummy.position.set(frame.x + frame.nx * dist * side, 0, frame.z + frame.nz * dist * side);
    trunkDummy.scale.set(scale, scale, scale);
    trunkDummy.rotation.y = Math.random() * Math.PI * 2;
    trunkDummy.updateMatrix();
    trunkInstanced.setMatrixAt(i, trunkDummy.matrix);

    leafDummy.position.set(frame.x + frame.nx * dist * side, 1.8 * scale, frame.z + frame.nz * dist * side);
    leafDummy.scale.set(scale, scale, scale);
    leafDummy.rotation.y = trunkDummy.rotation.y;
    leafDummy.updateMatrix();
    leafInstanced.setMatrixAt(i, leafDummy.matrix);
  }

  trunkInstanced.instanceMatrix.needsUpdate = true;
  leafInstanced.instanceMatrix.needsUpdate = true;
  group.add(trunkInstanced);
  group.add(leafInstanced);
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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
if ("physicallyCorrectLights" in renderer) renderer.physicallyCorrectLights = true;
if ("useLegacyLights" in renderer) renderer.useLegacyLights = false;
if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;
renderer.setScissorTest(true);
renderer.sortObjects = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x243753);
scene.fog = new THREE.Fog(0xb96f3d, 70, 260);

function buildSkyDome() {
  const skyGeo = new THREE.SphereGeometry(900, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x0f2346) },
      horizonColor: { value: new THREE.Color(0xf28b4b) },
      groundColor: { value: new THREE.Color(0x7a4424) },
      sunColor: { value: new THREE.Color(0xffd06e) },
      sunDirection: { value: new THREE.Vector3(0.22, 0.74, 0.64).normalize() },
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
        vec3 sky = mix(horizonColor, topColor, smoothstep(0.18, 1.0, y));
        sky = mix(groundColor, sky, smoothstep(0.0, 0.28, y));
        float sunDot = max(dot(normalize(vWorldDir), normalize(sunDirection)), 0.0);
        float sunGlow = pow(sunDot, 320.0) + pow(sunDot, 18.0) * 0.55;
        float horizonGlow = smoothstep(0.0, 0.16, max(0.0, 1.0 - abs(vWorldDir.y)));
        vec3 col = sky + sunColor * sunGlow + vec3(0.08, 0.04, 0.0) * horizonGlow;
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
  return Math.min(window.devicePixelRatio || 1, 2);
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
scene.add(new THREE.HemisphereLight(0x9cc5ff, 0x5a8d3d, 1.12));
const sunLight = new THREE.DirectionalLight(0xffd38d, 3.0);
sunLight.position.set(70, 140, -40);
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

const fillLight = new THREE.DirectionalLight(0x6ab9ff, 0.82);
fillLight.position.set(-110, 70, 70);
scene.add(fillLight);

const warmRimLight = new THREE.DirectionalLight(0xff6a2b, 0.58);
warmRimLight.position.set(-40, 40, -100);
scene.add(warmRimLight);

const accentLight = new THREE.PointLight(0xffb45b, 8, 120, 2);
accentLight.position.set(20, 18, 30);
scene.add(accentLight);

function applyQualitySettings() {
  const q = currentQuality();
  PERF.hudInterval = q.hudInterval;
  PERF.minimapInterval = q.minimapInterval;
  skyDome.visible = q.showSky;

  renderer.shadowMap.enabled = true;
  sunLight.castShadow = true;
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
    color: 0x7ddc52,
    roughness: 0.88,
    metalness: 0.02,
  })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
initializeSpaTrack(scene);
loadTrackGlbVisual(scene, TRACK_BOUNDS);
scene.add(buildScenery());

const skidMarksGroup = new THREE.Group();
scene.add(skidMarksGroup);
const skidMarks = [];
const MAX_SKIDMARKS = 220;
const skidMaterial = new THREE.LineBasicMaterial({ color: 0x171717, transparent: true, opacity: 0.82 });

function createSkidmark(from, to) {
  const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geometry, skidMaterial.clone());
  line.renderOrder = 1;
  line.frustumCulled = false;
  skidMarksGroup.add(line);
  skidMarks.push(line);
  if (skidMarks.length > MAX_SKIDMARKS) {
    const old = skidMarks.shift();
    skidMarksGroup.remove(old);
    old.geometry.dispose();
    old.material.dispose();
  }
}

function updateSkidmarks(state, dt) {
  const controls = getControls(state.playerId);
  const physics = state.physics;
  const speed = Math.abs(physics.speed);
  const shouldSkid = !!controls.handbrakePressed || (!!controls.brakePressed && speed > 16) || (Math.abs(controls.steerAngle || 0) > 0.55 && speed > 18 && Math.abs(physics.driftYaw) > 0.12);
  const rearOffset = 1.35;
  const worldPoint = new THREE.Vector3(
    physics.x - Math.sin(physics.heading) * rearOffset,
    0.05,
    physics.z - Math.cos(physics.heading) * rearOffset
  );

  if (!state.skidState.lastPoint) {
    state.skidState.lastPoint = worldPoint.clone();
    state.skidState.cooldown = 0;
    state.skidState.active = false;
    return;
  }

  if (shouldSkid && speed > 8) {
    state.skidState.cooldown -= dt;
    if (state.skidState.cooldown <= 0) {
      createSkidmark(state.skidState.lastPoint, worldPoint);
      spawnSmoke(worldPoint.x, worldPoint.z, 5 + Math.floor(speed / 10));
      state.skidState.cooldown = 0.045;
    }
  } else {
    state.skidState.cooldown = 0;
  }

  state.skidState.lastPoint.copy(worldPoint);
  state.skidState.active = shouldSkid && speed > 8;
}

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
const dustPoints = new THREE.Points(dustGeo, dustMat);
dustPoints.frustumCulled = false;
scene.add(dustPoints);

const grassCount = 120;
const grassGeo = new THREE.BufferGeometry();
const grassPositions = new Float32Array(grassCount * 3);
const grassVelocities = new Array(grassCount).fill(null).map(() => new THREE.Vector3());
const grassLife = new Float32Array(grassCount);
let grassNeedsUpload = false;
for (let i = 0; i < grassCount; i++) grassPositions[i * 3 + 1] = -100;
grassGeo.setAttribute("position", new THREE.BufferAttribute(grassPositions, 3));
const grassMat = new THREE.PointsMaterial({ color: 0x9f8a63, size: 0.22, transparent: true, opacity: 0.9, depthWrite: false });
const grassPoints = new THREE.Points(grassGeo, grassMat);
grassPoints.frustumCulled = false;
scene.add(grassPoints);

const smokeCount = 520;
const smokeGeo = new THREE.BufferGeometry();
const smokePositions = new Float32Array(smokeCount * 3);
const smokeVelocities = new Array(smokeCount).fill(null).map(() => new THREE.Vector3());
const smokeLife = new Float32Array(smokeCount);
let smokeNeedsUpload = false;
for (let i = 0; i < smokeCount; i++) smokePositions[i * 3 + 1] = -100;
smokeGeo.setAttribute("position", new THREE.BufferAttribute(smokePositions, 3));
const smokeMat = new THREE.PointsMaterial({
  color: 0xffffff,
  size: 1.25,
  transparent: true,
  opacity: 0.98,
  depthWrite: false,
  depthTest: false,
});
const smokePoints = new THREE.Points(smokeGeo, smokeMat);
smokePoints.frustumCulled = false;
smokePoints.renderOrder = 20;
scene.add(smokePoints);

const SPARK_COUNT = 140;
const sparkGeo = new THREE.BufferGeometry();
const sparkPositions = new Float32Array(SPARK_COUNT * 3);
const sparkVelocities = new Array(SPARK_COUNT).fill(null).map(() => new THREE.Vector3());
const sparkLife = new Float32Array(SPARK_COUNT);
let sparkNeedsUpload = false;
for (let i = 0; i < SPARK_COUNT; i++) sparkPositions[i * 3 + 1] = -100;
sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPositions, 3));
const sparkMat = new THREE.PointsMaterial({ color: 0xfef2bf, size: 0.18, transparent: true, opacity: 0.95, depthWrite: false });
const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
sparkPoints.frustumCulled = false;
scene.add(sparkPoints);

let dustCursor = 0;
let sparkCursor = 0;
let grassCursor = 0;
let smokeCursor = 0;

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

function spawnSparks(x, z, count) {
  const spawnCount = Math.max(1, Math.floor(count * dustSpawnScale));
  for (let n = 0; n < spawnCount; n++) {
    const i = sparkCursor;
    sparkCursor = (sparkCursor + 1) % SPARK_COUNT;
    sparkPositions[i * 3] = x + (Math.random() - 0.5) * 0.5;
    sparkPositions[i * 3 + 1] = 0.16;
    sparkPositions[i * 3 + 2] = z + (Math.random() - 0.5) * 0.5;
    sparkVelocities[i].set((Math.random() - 0.5) * 2.2, 1.4 + Math.random() * 1.6, (Math.random() - 0.5) * 2.2);
    sparkLife[i] = 0.35 + Math.random() * 0.25;
  }
  sparkNeedsUpload = true;
}

function spawnGrassDebris(x, z, count) {
  const spawnCount = Math.max(1, Math.floor(count * dustSpawnScale));
  for (let n = 0; n < spawnCount; n++) {
    const i = grassCursor;
    grassCursor = (grassCursor + 1) % grassCount;
    grassPositions[i * 3] = x + (Math.random() - 0.5) * 0.8;
    grassPositions[i * 3 + 1] = 0.08;
    grassPositions[i * 3 + 2] = z + (Math.random() - 0.5) * 0.8;
    grassVelocities[i].set((Math.random() - 0.5) * 1.9, 0.8 + Math.random() * 1.2, (Math.random() - 0.5) * 1.9);
    grassLife[i] = 0.45 + Math.random() * 0.35;
  }
  grassNeedsUpload = true;
}

function spawnSmoke(x, z, count) {
  const spawnCount = Math.max(1, Math.floor(count * dustSpawnScale));
  for (let n = 0; n < spawnCount; n++) {
    const i = smokeCursor;
    smokeCursor = (smokeCursor + 1) % smokeCount;
    smokePositions[i * 3] = x + (Math.random() - 0.5) * 1.35;
    smokePositions[i * 3 + 1] = 0.22;
    smokePositions[i * 3 + 2] = z + (Math.random() - 0.5) * 1.35;
    smokeVelocities[i].set((Math.random() - 0.5) * 1.0, 1.05 + Math.random() * 1.1, (Math.random() - 0.5) * 1.0);
    smokeLife[i] = 0.28 + Math.random() * 0.32;
  }
  smokeNeedsUpload = true;
}

function spawnDriftSmokeFromRearWheels(state, speedAbs) {
  const heading = state.physics.heading;
  const rearZ = -1.4;
  const rearX = 1.05;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const leftX = state.physics.x + (-rearX) * cos + rearZ * sin;
  const leftZ = state.physics.z - (-rearX) * sin + rearZ * cos;
  const rightX = state.physics.x + rearX * cos + rearZ * sin;
  const rightZ = state.physics.z - rearX * sin + rearZ * cos;

  const smokeBurst = 3 + Math.floor(speedAbs / 6);
  spawnSmoke(leftX, leftZ, smokeBurst);
  spawnSmoke(rightX, rightZ, smokeBurst);
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

function updateSparks(dt) {
  let dirty = false;
  for (let i = 0; i < SPARK_COUNT; i++) {
    if (sparkLife[i] <= 0) continue;
    sparkLife[i] -= dt;
    if (sparkLife[i] <= 0) {
      sparkPositions[i * 3 + 1] = -100;
      dirty = true;
      continue;
    }
    sparkPositions[i * 3] += sparkVelocities[i].x * dt;
    sparkPositions[i * 3 + 1] += sparkVelocities[i].y * dt;
    sparkPositions[i * 3 + 2] += sparkVelocities[i].z * dt;
    sparkVelocities[i].y -= 3.2 * dt;
    sparkVelocities[i].x *= 0.94;
    sparkVelocities[i].z *= 0.94;
    dirty = true;
  }
  if (dirty || sparkNeedsUpload) {
    sparkGeo.attributes.position.needsUpdate = true;
    sparkNeedsUpload = false;
  }
}

function updateGrassDebris(dt) {
  let dirty = false;
  for (let i = 0; i < grassCount; i++) {
    if (grassLife[i] <= 0) continue;
    grassLife[i] -= dt;
    if (grassLife[i] <= 0) {
      grassPositions[i * 3 + 1] = -100;
      dirty = true;
      continue;
    }
    grassPositions[i * 3] += grassVelocities[i].x * dt;
    grassPositions[i * 3 + 1] += grassVelocities[i].y * dt;
    grassPositions[i * 3 + 2] += grassVelocities[i].z * dt;
    grassVelocities[i].y -= 2.8 * dt;
    dirty = true;
  }
  if (dirty || grassNeedsUpload) {
    grassGeo.attributes.position.needsUpdate = true;
    grassNeedsUpload = false;
  }
}

function updateSmoke(dt) {
  let dirty = false;
  for (let i = 0; i < smokeCount; i++) {
    if (smokeLife[i] <= 0) continue;
    smokeLife[i] -= dt * 1.95;
    if (smokeLife[i] <= 0) {
      smokePositions[i * 3 + 1] = -100;
      dirty = true;
      continue;
    }
    smokePositions[i * 3] += smokeVelocities[i].x * dt;
    smokePositions[i * 3 + 1] += smokeVelocities[i].y * dt;
    smokePositions[i * 3 + 2] += smokeVelocities[i].z * dt;
    smokeVelocities[i].y += 0.45 * dt;
    smokeVelocities[i].x *= 0.965;
    smokeVelocities[i].z *= 0.965;
    dirty = true;
  }
  if (dirty || smokeNeedsUpload) {
    smokeGeo.attributes.position.needsUpdate = true;
    smokeNeedsUpload = false;
  }
}

function clearSmokeImmediate() {
  let dirty = false;
  for (let i = 0; i < smokeCount; i++) {
    if (smokeLife[i] <= 0) continue;
    smokeLife[i] = 0;
    smokePositions[i * 3 + 1] = -200;
    dirty = true;
  }
  if (dirty || smokeNeedsUpload) {
    smokeGeo.attributes.position.needsUpdate = true;
    smokeNeedsUpload = false;
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
  maxSteerRate: 2.55,
  minSteerRate: 1.1,
  grassMaxSpeedFactor: 0.45,
  grassFriction: 26,
  wallImpactFactor: 0.35,
  handbrakeDeceleration: 7.2,
  handbrakeSteerBoost: 1.9,
  handbrakeMinSpeed: 4.2,
  handbrakeSlipBoost: 1.7,
  driftBuildRate: 6.6,
  driftRecoverRate: 1.05,
  driftSustainRecoverRate: 0.32,
  driftMinSteer: 0.06,
  driftMaxAngle: 1.35,
  driftHeadingFactor: 0.7,
  driftCounterSteerAssist: 0.28,
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
    physics: { x: startX, z: startZ, heading: 0, speed: 0, driftYaw: 0, velocity: new THREE.Vector3() },
    skidState: { lastPoint: null, active: false, cooldown: 0 },
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

const car1 = createCarState(1, 0xff4f3c, START_GRID.car1.x, START_GRID.car1.z);
const car2 = createCarState(2, 0x2f7dff, START_GRID.car2.x, START_GRID.car2.z);
const cars = [car1, car2];
const soloCars = [car1];

car1.physics.heading = START_GRID.car1.heading;
car2.physics.heading = START_GRID.car2.heading;

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

function createMotionTrail(color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.08,
    depthWrite: false,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.5, 4.3), mat);
  body.position.y = 0.5;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.42, 1.85), mat.clone());
  cabin.material.opacity = 0.05;
  cabin.position.set(0, 0.95, -0.15);
  group.add(body);
  group.add(cabin);
  group.visible = false;
  return group;
}

for (const state of cars) {
  state.parts.shadowBlob = createShadowBlob();
  scene.add(state.parts.shadowBlob);
  state.parts.motionTrail = createMotionTrail(state.playerId === 1 ? 0xff8a6f : 0x79b5ff);
  state.parts.motionTrail.scale.set(1.02, 1.02, 1.02);
  scene.add(state.parts.motionTrail);
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

const DRIFT_CONFIG = {
  normalTurnSpeed: 0.03,
  driftTurnSpeed: 0.075,
  normalGrip: 0.25,
  driftGrip: 0.025,
  driftSlideForce: 0.35,
};

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
  const steerInput = -Math.max(-1, Math.min(1, controls.steerAngle || 0));
  const speedAbs = Math.abs(physics.speed);
  const steerAbs = Math.abs(steerInput);

  if (Math.abs(physics.speed) > 0.3) {
    const direction = physics.speed >= 0 ? 1 : -1;
    const headingFactor = handbrakeActive ? PHYSICS_PARAMS.driftHeadingFactor : 1;
    physics.heading += steerInput * steerRate * dt * direction * headingFactor;
  }

  if (handbrakeActive) {
    const hb = PHYSICS_PARAMS.handbrakeDeceleration * dt;
    if (physics.speed > 0) physics.speed = Math.max(0, physics.speed - hb);
    else if (physics.speed < 0) physics.speed = Math.min(0, physics.speed + hb);
  }

  const canDrift = handbrakeActive
    && speedAbs > PHYSICS_PARAMS.handbrakeMinSpeed
    && steerAbs > PHYSICS_PARAMS.driftMinSteer;
  if (canDrift) {
    const driftSpeedRatio = Math.min(1, speedAbs / (PHYSICS_PARAMS.maxSpeed * 0.9));
    const driftTarget = steerInput
      * PHYSICS_PARAMS.driftMaxAngle
      * (0.55 + driftSpeedRatio * 0.95)
      * PHYSICS_PARAMS.handbrakeSlipBoost;
    const counterSteer = Math.sign(steerInput) === -Math.sign(physics.driftYaw) ? steerInput * PHYSICS_PARAMS.driftCounterSteerAssist : 0;
    const driftTargetWithCounter = driftTarget + counterSteer;
    physics.driftYaw += (driftTargetWithCounter - physics.driftYaw) * Math.min(1, dt * PHYSICS_PARAMS.driftBuildRate);
  } else {
    const sustainDrift = speedAbs > PHYSICS_PARAMS.handbrakeMinSpeed * 0.75 && steerAbs > 0.22;
    const recoverRate = sustainDrift
      ? PHYSICS_PARAMS.driftSustainRecoverRate
      : PHYSICS_PARAMS.driftRecoverRate;
    physics.driftYaw += (0 - physics.driftYaw) * Math.min(1, dt * recoverRate);
  }

  const driftSmokeActive =
    (handbrakeActive && speedAbs > 3.2 && steerAbs > 0.05)
    || (Math.abs(physics.driftYaw) > 0.1 && speedAbs > 6);

  if (driftSmokeActive) {
    spawnDriftSmokeFromRearWheels(state, speedAbs);
  }

  const forwardDir = new THREE.Vector3(Math.sin(physics.heading), 0, Math.cos(physics.heading));
  const sideDir = new THREE.Vector3(Math.cos(physics.heading), 0, -Math.sin(physics.heading));
  const targetVelocity = forwardDir.clone().multiplyScalar(physics.speed);
  const grip = canDrift ? DRIFT_CONFIG.driftGrip : DRIFT_CONFIG.normalGrip;
  physics.velocity.lerp(targetVelocity, grip);
  if (canDrift) {
    const slideIntensity = -steerInput * Math.abs(physics.speed) * DRIFT_CONFIG.driftSlideForce * 0.05;
    physics.velocity.addScaledVector(sideDir, slideIntensity);
  }
  physics.x += physics.velocity.x * dt;
  physics.z += physics.velocity.z * dt;

  // --- Limites de terrain ---
  if (wallMode) {
    const info2 = analyzeTrackPositionFast(physics.x, physics.z, trackInfo.index);
    if (Math.abs(info2.lateral) > WALL_BOUNDARY) {
      const clamped = Math.sign(info2.lateral) * WALL_BOUNDARY;
      physics.x = info2.px + info2.nx * clamped;
      physics.z = info2.pz + info2.nz * clamped;
      if (Math.abs(physics.speed) > 4) {
        spawnDust(physics.x, physics.z, 5);
        spawnSparks(physics.x, physics.z, 6);
        if (typeof window.emitGameHaptic === "function") {
          window.emitGameHaptic(state.playerId, Math.min(1, Math.abs(physics.speed) / PHYSICS_PARAMS.maxSpeed));
        }
      }
      physics.speed *= PHYSICS_PARAMS.wallImpactFactor;
      trackInfo = { ...info2, offTrack: false };
    } else {
      trackInfo = info2;
    }
  } else if (trackInfo.offTrack && Math.abs(physics.speed) > 2) {
    spawnDust(physics.x, physics.z, 2);
    spawnSparks(physics.x, physics.z, 2);
    spawnGrassDebris(physics.x, physics.z, 4);
  } else if (canDrift && Math.abs(steerInput) > 0.2) {
    spawnDust(physics.x, physics.z, 2);
  } else if (controls.brakePressed && Math.abs(physics.speed) > PHYSICS_PARAMS.maxSpeed * 0.5) {
    spawnDust(physics.x, physics.z, 1);
  }

  return { steerInput, trackInfo, handbrakeActive, driftSmokeActive };
}

// ============================================================
// Tours de circuit / chronomètre / victoire
// ============================================================

const raceState = {
  running: false,
  paused: false,
  elapsed: 0,
  laps: 3,
  wallMode: false,
};

const pauseOverlay = document.getElementById("pause-overlay");
const pauseResumeBtn = document.getElementById("pause-resume-btn");
const pauseRestartBtn = document.getElementById("pause-restart-btn");
const pauseQuitBtn = document.getElementById("pause-quit-btn");

function setPauseOverlay(visible) {
  if (!pauseOverlay) return;
  pauseOverlay.classList.toggle("hidden", !visible);
  pauseOverlay.setAttribute("aria-hidden", visible ? "false" : "true");
}

function togglePauseMenu(force) {
  if (!raceState.running || raceState.finished || raceLocked) {
    if (force === false) setPauseOverlay(false);
    return;
  }
  const next = force ?? !raceState.paused;
  raceState.paused = next;
  setPauseOverlay(next);
}

window.setGamePaused = function setGamePaused(paused, source = "remote") {
  if (source === "mobile" && (!raceState.running || raceState.finished || raceLocked)) {
    return;
  }
  togglePauseMenu(!!paused);
};

if (pauseResumeBtn) {
  pauseResumeBtn.addEventListener("click", () => togglePauseMenu(false));
}

if (pauseRestartBtn) {
  pauseRestartBtn.addEventListener("click", () => {
    setPauseOverlay(false);
    window.startRace();
  });
}

if (pauseQuitBtn) {
  pauseQuitBtn.addEventListener("click", () => {
    setPauseOverlay(false);
    window.location.reload();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    togglePauseMenu();
  }
});

// ============================================================
// Audio runtime (moteur + countdown + victoire)
// ============================================================

const audioState = {
  ctx: null,
  masterGain: null,
  unlocked: false,
  carSounds: {
    1: { osc: null, gain: null, driftOsc: null, driftGain: null },
    2: { osc: null, gain: null, driftOsc: null, driftGain: null },
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

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 240;
  filter.Q.value = 0.8;

  const tone = ctx.createOscillator();
  tone.type = "sawtooth";
  tone.frequency.value = 85;

  const rumble = ctx.createOscillator();
  rumble.type = "square";
  rumble.frequency.value = 42;
  rumble.detune.value = -6;

  const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;

  const engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  const driftOsc = ctx.createOscillator();
  driftOsc.type = "triangle";
  driftOsc.frequency.value = 760;
  const driftGain = ctx.createGain();
  driftGain.gain.value = 0;

  tone.connect(filter);
  rumble.connect(filter);
  filter.connect(engineGain);
  noise.connect(noiseGain);
  driftOsc.connect(driftGain);
  engineGain.connect(audioState.masterGain);
  noiseGain.connect(audioState.masterGain);
  driftGain.connect(audioState.masterGain);

  tone.start();
  rumble.start();
  noise.start();
  driftOsc.start();

  slot.osc = tone;
  slot.rumble = rumble;
  slot.noise = noise;
  slot.filter = filter;
  slot.gain = engineGain;
  slot.noiseGain = noiseGain;
  slot.driftOsc = driftOsc;
  slot.driftGain = driftGain;
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
  if (!slot || !slot.osc || !slot.gain || !slot.rumble || !slot.noiseGain || !slot.filter || !slot.driftOsc || !slot.driftGain || !audioState.ctx) return;

  const speedRatio = Math.min(1, Math.abs(state.physics.speed) / PHYSICS_PARAMS.maxSpeed);
  const controls = getControls(state.playerId);
  const throttleBoost = controls.gasPressed ? 0.18 : 0;
  const slipFactor = Math.min(1, Math.abs(state.physics.driftYaw) * 0.9 + (controls.handbrakePressed ? 0.3 : 0));
  const driftFactor = controls.handbrakePressed && speedRatio > 0.25 ? Math.min(1, slipFactor * 1.25) : 0;
  const targetFreq = 70 + speedRatio * 210 + throttleBoost * 130 + slipFactor * 45;
  const targetGain = raceLocked ? 0.0001 : 0.02 + speedRatio * 0.1 + throttleBoost * 0.06;
  const targetNoiseGain = raceLocked ? 0.0001 : 0.008 + speedRatio * 0.02 + slipFactor * 0.02;
  const targetDriftGain = raceLocked ? 0.0001 : driftFactor * (0.03 + speedRatio * 0.05);
  const smooth = Math.min(1, dt * 8);
  const rumbleFreq = 34 + speedRatio * 28;
  const driftFreq = 620 + speedRatio * 320 + slipFactor * 140;

  const currentFreq = slot.osc.frequency.value;
  const currentGain = slot.gain.gain.value;
  const currentNoiseGain = slot.noiseGain.gain.value;
  const currentDriftGain = slot.driftGain.gain.value;
  slot.osc.frequency.setValueAtTime(currentFreq + (targetFreq - currentFreq) * smooth, audioState.ctx.currentTime);
  slot.rumble.frequency.setValueAtTime(rumbleFreq, audioState.ctx.currentTime);
  slot.driftOsc.frequency.setValueAtTime(driftFreq, audioState.ctx.currentTime);
  slot.gain.gain.setValueAtTime(currentGain + (targetGain - currentGain) * smooth, audioState.ctx.currentTime);
  slot.noiseGain.gain.setValueAtTime(currentNoiseGain + (targetNoiseGain - currentNoiseGain) * smooth, audioState.ctx.currentTime);
  slot.driftGain.gain.setValueAtTime(currentDriftGain + (targetDriftGain - currentDriftGain) * smooth, audioState.ctx.currentTime);
  slot.filter.frequency.setValueAtTime(180 + speedRatio * 320 + slipFactor * 100, audioState.ctx.currentTime);
}

function updateMotionTrail(state) {
  const trail = state.parts.motionTrail;
  if (!trail) return;
  const speedRatio = Math.min(1, Math.abs(state.physics.speed) / PHYSICS_PARAMS.maxSpeed);
  const slipRatio = Math.min(1, Math.abs(state.physics.driftYaw) * 0.8 + speedRatio * 0.3);
  trail.visible = speedRatio > 0.2;
  trail.position.set(state.physics.x, 0, state.physics.z);
  trail.rotation.y = state.physics.heading;
  trail.children[0].material.opacity = 0.04 + slipRatio * 0.08;
  trail.children[1].material.opacity = 0.03 + slipRatio * 0.06;
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
let cameraShakePhase = 0;

function updateCarCamera(state, dt) {
  const physics = state.physics;
  cameraShakePhase += dt * 34;
  const speedRatio = Math.min(1, Math.abs(physics.speed) / PHYSICS_PARAMS.maxSpeed);
  const shakeBlend = Math.max(0, (speedRatio - 0.92) / 0.08);
  const shakeAmp = 0.085 * shakeBlend;
  const shakeX = Math.sin(cameraShakePhase * 2.3 + state.playerId) * shakeAmp;
  const shakeY = Math.cos(cameraShakePhase * 3.1 + state.playerId * 0.7) * shakeAmp * 0.6;
  const shakeZ = Math.sin(cameraShakePhase * 1.9 + state.playerId * 0.33) * shakeAmp * 0.45;

  _desiredCamPos.set(
    physics.x - Math.sin(physics.heading) * cameraRig.distance + shakeX,
    cameraRig.height + shakeY,
    physics.z - Math.cos(physics.heading) * cameraRig.distance + shakeZ
  );
  const lerpFactor = 1 - Math.exp(-cameraRig.smoothing * dt);
  state.currentCamPos.lerp(_desiredCamPos, lerpFactor);

  state.camera.position.copy(state.currentCamPos);
  state.camera.lookAt(physics.x, cameraRig.lookAtHeight, physics.z);

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
  const x = cx + (physics.x - TRACK_BOUNDS.centerX) * scale;
  const y = cy + (physics.z - TRACK_BOUNDS.centerZ) * scale;
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
  const extent = TRACK_BOUNDS.halfExtent + 20;
  const scale = Math.min(w, h) / 2 / extent - margin / extent;
  const cx = w / 2;
  const cy = h / 2;

  minimapCtx.beginPath();
  centerPoints.forEach((p, i) => {
    const px = cx + (p.x - TRACK_BOUNDS.centerX) * scale;
    const py = cy + (p.z - TRACK_BOUNDS.centerZ) * scale;
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

function resetCarState(state, startX, startZ, startHeading = 0) {
  state.physics.x = startX;
  state.physics.z = startZ;
  state.physics.heading = startHeading;
  state.physics.speed = 0;
  state.physics.driftYaw = 0;
  state.physics.velocity.set(0, 0, 0);
  state.race.lap = 1;
  state.race.lapStartTime = 0;
  state.race.lastLapTime = null;
  state.race.bestLapTime = null;
  state.race.prevSampleIndex = 0;
  state.race.finished = false;
  state.currentCamPos.set(
    startX - Math.sin(startHeading) * cameraRig.distance,
    cameraRig.height,
    startZ - Math.cos(startHeading) * cameraRig.distance
  );
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
  raceState.paused = false;
  setPauseOverlay(false);

  resetCarState(car1, START_GRID.car1.x, START_GRID.car1.z, START_GRID.car1.heading);
  if (!solo) {
    resetCarState(car2, START_GRID.car2.x, START_GRID.car2.z, START_GRID.car2.heading);
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
  raceState.paused = false;
  raceLocked = true;
  setPauseOverlay(false);
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

let lastFrameTime = performance.now();
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
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;
  const rawDt = dt;
  const activeCars = getActiveCars();

  if (!raceState.paused && !raceLocked) {
    raceState.elapsed += dt;
    let anyDriftSmokeActive = false;
    for (const state of activeCars) {
      const { steerInput, trackInfo, handbrakeActive, driftSmokeActive } = updateCarPhysics(state, dt, raceState.wallMode);
      if (driftSmokeActive) anyDriftSmokeActive = true;
      updateLapTracking(state, trackInfo.index);
      updateSkidmarks(state, dt);
      applyVisuals(state, steerInput, dt, handbrakeActive);
      updateMotionTrail(state);
    }
    if (!anyDriftSmokeActive) {
      clearSmokeImmediate();
    }
  } else {
    for (const state of activeCars) {
      applyVisuals(state, 0, dt, false);
      updateMotionTrail(state);
    }
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
  updateSparks(dt);
  updateGrassDebris(dt);
  updateSmoke(dt);
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

  state.parts.group.children.forEach((child) => {
    if (child && child.castShadow !== undefined) child.castShadow = true;
    if (child && child.receiveShadow !== undefined) child.receiveShadow = true;
  });

  const visualSteerAngle = steerInput * 0.5;
  frontWheelPivots.forEach((pivot) => (pivot.rotation.y = visualSteerAngle));
  const wheelSpin = (state.physics.speed / 0.42) * dt;
  rollingWheels.forEach((wheel) => (wheel.rotation.x += wheelSpin));

  const braking = !!getControls(state.playerId).brakePressed;
  brakeLights.forEach((bl) => {
    bl.material.emissiveIntensity = braking || handbrakeActive ? 1.6 : 0.4;
  });
}

animate();
