// ============================================================
// track-spa.js
// Circuit procédural inspiré de Spa-Francorchamps pour Three.js.
// ES Module pur, zéro dépendance externe, zéro asset externe.
// ============================================================

// ---------- Config par défaut ----------
const DEFAULTS = {
  roadWidth: 12,
  curbWidth: 1.4,
  sampleCount: 600,
  addGround: true,
  elevationScale: 0,   // 0 = flat mode (recommandé pour la physique)
  baseHeight: 0.06,
  checkpointEvery: 20, // 1 checkpoint tous les N samples
  debug: false,
  layoutScale: 1.0,
  layoutOffsetX: 0,
  layoutOffsetZ: 0,
};

// ---------- Helpers ----------
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function resolveOptions(options) {
  const o = options || {};
  return {
    roadWidth: o.roadWidth > 0 ? o.roadWidth : DEFAULTS.roadWidth,
    curbWidth: o.curbWidth > 0 ? o.curbWidth : DEFAULTS.curbWidth,
    sampleCount: Number.isInteger(o.sampleCount) && o.sampleCount > 16 ? o.sampleCount : DEFAULTS.sampleCount,
    addGround: typeof o.addGround === 'boolean' ? o.addGround : DEFAULTS.addGround,
    elevationScale: typeof o.elevationScale === 'number' ? o.elevationScale : DEFAULTS.elevationScale,
    baseHeight: typeof o.baseHeight === 'number' ? o.baseHeight : DEFAULTS.baseHeight,
    checkpointEvery: Number.isInteger(o.checkpointEvery) && o.checkpointEvery > 2 ? o.checkpointEvery : DEFAULTS.checkpointEvery,
    debug: !!o.debug,
    layoutScale: typeof o.layoutScale === 'number' && o.layoutScale > 0 ? o.layoutScale : DEFAULTS.layoutScale,
    layoutOffsetX: typeof o.layoutOffsetX === 'number' ? o.layoutOffsetX : DEFAULTS.layoutOffsetX,
    layoutOffsetZ: typeof o.layoutOffsetZ === 'number' ? o.layoutOffsetZ : DEFAULTS.layoutOffsetZ,
  };
}

// ---------- Génération de la forme du tracé (Spa-like explicite) ----------
// Layout stylisé basé sur les virages emblématiques, pour éviter toute forme aléatoire.
const SPA_LAYOUT_POINTS = [
  { x: 0, z: 0 },
  { x: -18, z: 34 },
  { x: -9, z: 92 },
  { x: 7, z: 132 },
  { x: 64, z: 206 },
  { x: 126, z: 236 },
  { x: 154, z: 214 },
  { x: 168, z: 172 },
  { x: 204, z: 124 },
  { x: 232, z: 74 },
  { x: 246, z: 22 },
  { x: 232, z: -42 },
  { x: 152, z: -98 },
  { x: 60, z: -72 },
  { x: 20, z: -28 },
];

function generateControlPoints(layoutScale, offsetX, offsetZ) {
  return SPA_LAYOUT_POINTS.map((p) => ({
    x: p.x * layoutScale + offsetX,
    z: p.z * layoutScale + offsetZ,
  }));
}

// ---------- Relief (flat mode par défaut) ----------
function heightAt(t, baseHeight, elevationScale) {
  if (!elevationScale) return baseHeight;
  // périodique en t -> pas de "seam" (raccord) entre fin et début de boucle
  const h =
    Math.sin(t * Math.PI * 2 * 2) * 0.6 +
    Math.sin(t * Math.PI * 2 * 5 + 1.0) * 0.3 +
    Math.sin(t * Math.PI * 2 * 1 + 2.4) * 0.5;
  return baseHeight + h * elevationScale;
}

// ---------- Textures procédurales (canvas, aucun asset externe) ----------
function makeAsphaltTexture(THREE) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3a3a3d';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const shade = 40 + Math.random() * 40;
    ctx.fillStyle = `rgba(${shade},${shade},${shade},0.25)`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 40);
  return tex;
}

function makeStartLineTexture(THREE) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cell = size / 8;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#111111';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  return new THREE.CanvasTexture(canvas);
}

// ---------- Géométrie de la route (ruban de triangles) ----------
function buildRoadGeometry(THREE, centerPoints, roadWidth) {
  const N = centerPoints.length;
  const positions = new Float32Array(N * 2 * 3);
  const normals = new Float32Array(N * 2 * 3);
  const uvs = new Float32Array(N * 2 * 2);
  const half = roadWidth / 2;

  for (let i = 0; i < N; i++) {
    const c = centerPoints[i];
    const nextC = centerPoints[(i + 1) % N];
    const prevC = centerPoints[(i - 1 + N) % N];

    // direction lissée via voisins (plus stable que la tangente brute seule)
    const fx = nextC.x - prevC.x;
    const fz = nextC.z - prevC.z;
    const flen = Math.hypot(fx, fz) || 1;
    const fwdX = fx / flen, fwdZ = fz / flen;
    const rightX = fwdZ, rightZ = -fwdX; // perpendiculaire dans le plan XZ

    const lx = c.x - rightX * half, lz = c.z - rightZ * half;
    const rx = c.x + rightX * half, rz = c.z + rightZ * half;

    const li = i * 2, ri = i * 2 + 1;
    positions[li * 3] = lx; positions[li * 3 + 1] = c.y; positions[li * 3 + 2] = lz;
    positions[ri * 3] = rx; positions[ri * 3 + 1] = c.y; positions[ri * 3 + 2] = rz;

    normals[li * 3] = 0; normals[li * 3 + 1] = 1; normals[li * 3 + 2] = 0;
    normals[ri * 3] = 0; normals[ri * 3 + 1] = 1; normals[ri * 3 + 2] = 0;

    uvs[li * 2] = 0; uvs[li * 2 + 1] = i * 0.1;
    uvs[ri * 2] = 1; uvs[ri * 2 + 1] = i * 0.1;
  }

  const indices = [];
  for (let i = 0; i < N; i++) {
    const li = i * 2, ri = i * 2 + 1;
    const lni = ((i + 1) % N) * 2, rni = ((i + 1) % N) * 2 + 1;
    indices.push(li, ri, lni);
    indices.push(ri, rni, lni);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

// ---------- Géométrie des vibreurs (curbs rouge/blanc) ----------
function buildCurbGeometry(THREE, centerPoints, roadWidth, curbWidth) {
  const N = centerPoints.length;
  const halfRoad = roadWidth / 2;
  const positions = [];
  const colors = [];
  const indices = [];
  const stripe = 6; // samples par bande de couleur

  function pushSide(sign) {
    const base = positions.length / 3;
    for (let i = 0; i < N; i++) {
      const c = centerPoints[i];
      const nextC = centerPoints[(i + 1) % N];
      const prevC = centerPoints[(i - 1 + N) % N];
      const fx = nextC.x - prevC.x, fz = nextC.z - prevC.z;
      const flen = Math.hypot(fx, fz) || 1;
      const rightX = fz / flen, rightZ = -(fx / flen);

      const innerX = c.x + rightX * halfRoad * sign;
      const innerZ = c.z + rightZ * halfRoad * sign;
      const outerX = c.x + rightX * (halfRoad + curbWidth) * sign;
      const outerZ = c.z + rightZ * (halfRoad + curbWidth) * sign;

      positions.push(innerX, c.y + 0.02, innerZ, outerX, c.y + 0.02, outerZ);

      const band = Math.floor(i / stripe) % 2 === 0;
      const r = band ? 0.85 : 1.0, g = band ? 0.05 : 1.0, b = band ? 0.05 : 1.0;
      colors.push(r, g, b, r, g, b);
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2, b = base + i * 2 + 1;
      const na = base + ((i + 1) % N) * 2, nb = base + ((i + 1) % N) * 2 + 1;
      indices.push(a, b, na);
      indices.push(b, nb, na);
    }
  }

  pushSide(-1); // vibreur gauche
  pushSide(1);  // vibreur droit

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ---------- Ligne de départ ----------
function buildStartLine(THREE, centerPoints, roadWidth, startIndex) {
  const c = centerPoints[startIndex];
  const geo = new THREE.PlaneGeometry(roadWidth * 0.96, 2.5);
  const tex = makeStartLineTexture(THREE);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(geo, mat);
  plane.rotation.x = -Math.PI / 2;

  const group = new THREE.Group();
  group.add(plane);
  group.position.set(c.x, c.y + 0.03, c.z);
  group.rotation.y = c.heading; // alignement avec le cap de la piste
  return group;
}

// ---------- Sol ----------
function buildGround(THREE, bounds, baseHeight) {
  const w = bounds.maxX - bounds.minX;
  const d = bounds.maxZ - bounds.minZ;
  const geo = new THREE.PlaneGeometry(w * 1.4, d * 1.4);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2e6b34, roughness: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(bounds.centerX, baseHeight - 0.1, bounds.centerZ);
  mesh.receiveShadow = true;
  return mesh;
}

// ---------- Utilitaires géométriques exposés ----------
function computePerimeter(centerPoints) {
  let total = 0;
  const N = centerPoints.length;
  for (let i = 0; i < N; i++) {
    const a = centerPoints[i], b = centerPoints[(i + 1) % N];
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

function computeBounds(centerPoints, roadWidth) {
  const margin = roadWidth / 2 + 4;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of centerPoints) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  minX -= margin; maxX += margin; minZ -= margin; maxZ += margin;
  return {
    minX, maxX, minZ, maxZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    halfExtent: Math.max(maxX - minX, maxZ - minZ) / 2,
  };
}

function buildCheckpoints(centerPoints, checkpointEvery, roadWidth) {
  const checkpoints = [];
  for (let i = 0; i < centerPoints.length; i += checkpointEvery) {
    const c = centerPoints[i];
    checkpoints.push({
      index: c.index,
      x: c.x, y: c.y, z: c.z,
      heading: c.heading,
      radius: Math.max(roadWidth * 0.9, 8),
    });
  }
  // checkpoints[0] correspond toujours à la ligne de départ/arrivée (i=0 inclus)
  return checkpoints;
}

function computeStartPositions(centerPoints, roadWidth, startIndex) {
  const c = centerPoints[startIndex];
  const back = 6; // recul par rapport à la ligne (mètres)
  const fwdX = c.tangent.x, fwdZ = c.tangent.z;
  const rightX = fwdZ, rightZ = -fwdX;
  const lateral = roadWidth / 4;
  const bx = c.x - fwdX * back;
  const bz = c.z - fwdZ * back;
  return [
    { x: bx - rightX * lateral, y: c.y, z: bz - rightZ * lateral },
    { x: bx + rightX * lateral, y: c.y, z: bz + rightZ * lateral },
  ];
}

function getClosestTrackSample(centerPoints, x, z) {
  let best = null, bestDist = Infinity;
  for (let i = 0; i < centerPoints.length; i++) {
    const p = centerPoints[i];
    const dx = p.x - x, dz = p.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return {
    index: best.index,
    point: { x: best.x, y: best.y, z: best.z },
    distance: Math.sqrt(bestDist),
    heading: best.heading,
    tangent: best.tangent,
  };
}

function getTrackHeightAt(centerPoints, x, z) {
  return getClosestTrackSample(centerPoints, x, z).point.y;
}

// ---------- Validation de tour anti-triche (passage séquentiel obligatoire) ----------
function createLapTracker(checkpoints) {
  const state = new Map(); // carId -> { next, done }
  const M = checkpoints.length;

  return function updateLap(carId, carPosition) {
    if (!state.has(carId)) state.set(carId, { next: 0, done: 0 });
    const s = state.get(carId);
    const target = checkpoints[s.next];
    const dist = Math.hypot(carPosition.x - target.x, carPosition.z - target.z);

    let lapCompleted = false;
    if (dist <= target.radius) {
      s.next = (s.next + 1) % M;
      s.done += 1;
      if (s.next === 0) {
        lapCompleted = true;
        s.done = 0;
      }
    }
    return { lapCompleted, checkpointsDone: s.done };
  };
}

// ---------- Debug visuel ----------
function addDebugHelpers(scene, THREE, centerPoints, checkpoints) {
  const group = new THREE.Group();
  group.name = 'spa-track-debug';

  const linePts = centerPoints.map(p => new THREE.Vector3(p.x, p.y + 0.1, p.z));
  linePts.push(linePts[0]);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(linePts),
    new THREE.LineBasicMaterial({ color: 0x00ffff })
  );
  group.add(line);

  const sphereGeo = new THREE.SphereGeometry(1.2, 8, 8);
  checkpoints.forEach((cp, idx) => {
    const mat = new THREE.MeshBasicMaterial({ color: idx === 0 ? 0xffff00 : 0x00ff00, wireframe: true });
    const s = new THREE.Mesh(sphereGeo, mat);
    s.position.set(cp.x, cp.y + 1.2, cp.z);
    group.add(s);
  });

  for (let i = 0; i < centerPoints.length; i += 20) {
    const p = centerPoints[i];
    const dir = new THREE.Vector3(p.tangent.x, 0, p.tangent.z).normalize();
    const origin = new THREE.Vector3(p.x, p.y + 0.5, p.z);
    group.add(new THREE.ArrowHelper(dir, origin, 4, 0xff00ff));
  }

  scene.add(group);
  return group;
}

// ============================================================
// API publique
// ============================================================
export function buildSpaTrack(scene, THREE, options = {}) {
  const cfg = resolveOptions(options);

  // 1. Tracé Spa-like explicite
  const rawPts = generateControlPoints(cfg.layoutScale, cfg.layoutOffsetX, cfg.layoutOffsetZ);
  const curve = new THREE.CatmullRomCurve3(
    rawPts.map(p => new THREE.Vector3(p.x, 0, p.z)),
    true, 'catmullrom', 0.5
  );

  // 2. Échantillonnage de la ligne centrale
  const centerPoints = [];
  for (let i = 0; i < cfg.sampleCount; i++) {
    const t = i / cfg.sampleCount;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t).normalize();
    const y = heightAt(t, cfg.baseHeight, cfg.elevationScale);
    centerPoints.push({
      x: p.x, y, z: p.z, t, index: i,
      tangent: { x: tan.x, y: tan.y, z: tan.z },
      heading: Math.atan2(tan.x, tan.z),
    });
  }

  // 3. Route + vibreurs
  const roadGeo = buildRoadGeometry(THREE, centerPoints, cfg.roadWidth);
  const roadMat = new THREE.MeshStandardMaterial({
    map: makeAsphaltTexture(THREE),
    roughness: 0.95,
    metalness: 0.02,
  });
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.name = 'spa-road';
  scene.add(roadMesh);

  const curbGeo = buildCurbGeometry(THREE, centerPoints, cfg.roadWidth, cfg.curbWidth);
  const curbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  const curbMesh = new THREE.Mesh(curbGeo, curbMat);
  curbMesh.name = 'spa-curbs';
  scene.add(curbMesh);

  // 4. Ligne de départ
  const startLine = buildStartLine(THREE, centerPoints, cfg.roadWidth, 0);
  startLine.name = 'spa-start-line';
  scene.add(startLine);

  // 5. Sol
  const bounds = computeBounds(centerPoints, cfg.roadWidth);
  let groundMesh = null;
  if (cfg.addGround) {
    groundMesh = buildGround(THREE, bounds, cfg.baseHeight);
    groundMesh.name = 'spa-ground';
    scene.add(groundMesh);
  }

  // 6. Checkpoints + validation de tour
  const checkpoints = buildCheckpoints(centerPoints, cfg.checkpointEvery, cfg.roadWidth);
  const updateLap = createLapTracker(checkpoints);

  // 7. Divers utilitaires
  const perimeter = computePerimeter(centerPoints);
  const startPositions = computeStartPositions(centerPoints, cfg.roadWidth, 0);
  const startRotation = centerPoints[0].heading;

  let debugGroup = null;
  if (cfg.debug) {
    debugGroup = addDebugHelpers(scene, THREE, centerPoints, checkpoints);
  }

  return {
    centerPoints,
    roadMesh,
    curbMesh,
    groundMesh,
    startLine,
    perimeter,
    startPositions,
    startRotation,
    checkpoints,
    bounds,
    debugGroup,
    config: cfg,
    updateLap,
    getTrackHeightAt: (x, z) => getTrackHeightAt(centerPoints, x, z),
    getClosestTrackSample: (x, z) => getClosestTrackSample(centerPoints, x, z),
  };
}
