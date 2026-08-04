/**
 * track-spa.js
 * Circuit Spa-Francorchamps stylise pour Three.js.
 */

export function buildSpaTrack(scene, THREE, options = {}) {
  const {
    roadWidth = 12,
    addGround = true,
    roadColor = 0x2b2b2f,
    groundColor = 0x1c3320,
    elevationScale = 0,
    baseHeight = 0.04,
  } = options;

  // ---------- 1. Trace ----------
  const pts = [
    { n: "Ligne droite d'arrivee", x: 0, z: 0, y: 4 },
    { n: "La Source", x: -18, z: 38, y: 3.4 },
    { n: "Eau Rouge", x: -10, z: 95, y: 0.8 },
    { n: "Raidillon", x: 5, z: 130, y: 3.8 },
    { n: "Ligne droite de Kemmel", x: 60, z: 200, y: 7 },
    { n: "Les Combes", x: 120, z: 230, y: 6.6 },
    { n: "Malmedy", x: 150, z: 210, y: 4.8 },
    { n: "Rivage", x: 165, z: 170, y: 2 },
    { n: "Pouhon", x: 200, z: 120, y: 5.2 },
    { n: "Fagnes", x: 230, z: 70, y: 6 },
    { n: "Campus", x: 245, z: 20, y: 5 },
    { n: "Stavelot", x: 230, z: -40, y: 3.4 },
    { n: "Blanchimont", x: 150, z: -95, y: 5.6 },
    { n: "Chicane Bruxelles", x: 60, z: -70, y: 4.4 },
    { n: "Approche ligne droite", x: 20, z: -30, y: 4.2 },
  ];

  const curvePoints = pts.map((p) => new THREE.Vector3(p.x, baseHeight + p.y * elevationScale, p.z));
  const curve = new THREE.CatmullRomCurve3(curvePoints, true, "catmullrom", 0.4);

  const SAMPLES = 800;
  const samples = curve.getSpacedPoints(SAMPLES);
  const tangents = samples.map((_, i) => curve.getTangentAt(i / SAMPLES).normalize());
  const up = new THREE.Vector3(0, 1, 0);

  // ---------- 2. Route ----------
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const t = tangents[i];
    const side = new THREE.Vector3().crossVectors(t, up).normalize().multiplyScalar(roadWidth / 2);
    const left = p.clone().sub(side);
    const right = p.clone().add(side);
    positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    uvs.push(0, (i / 10) % 1, 1, (i / 10) % 1);
  }

  for (let i = 0; i < samples.length - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = i * 2 + 2;
    const d = i * 2 + 3;
    indices.push(a, c, b, b, c, d);
  }

  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  roadGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  roadGeo.setIndex(indices);
  roadGeo.computeVertexNormals();

  const roadMat = new THREE.MeshStandardMaterial({ color: roadColor, roughness: 0.9, metalness: 0.05 });
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.name = "spa-road";
  scene.add(roadMesh);

  function buildEdge(sign) {
    const verts = [];
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const t = tangents[i];
      const side = new THREE.Vector3().crossVectors(t, up).normalize().multiplyScalar((roadWidth / 2 + 0.3) * sign);
      const pt = p.clone().add(side).add(new THREE.Vector3(0, 0.05, 0));
      verts.push(pt.x, pt.y, pt.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: 0xf2ede0 }));
    scene.add(line);
  }

  buildEdge(1);
  buildEdge(-1);

  // ---------- 3. Sol ----------
  if (addGround) {
    const groundGeo = new THREE.PlaneGeometry(1400, 1400);
    const groundMat = new THREE.MeshStandardMaterial({ color: groundColor, roughness: 1 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.6;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  // ---------- 4. Ligne depart/arrivee ----------
  const checkerCanvas = document.createElement("canvas");
  checkerCanvas.width = 64;
  checkerCanvas.height = 16;
  const cctx = checkerCanvas.getContext("2d");
  for (let x = 0; x < 8; x++) {
    cctx.fillStyle = x % 2 === 0 ? "#111" : "#f4f4f4";
    cctx.fillRect(x * 8, 0, 8, 16);
  }
  const checkerTex = new THREE.CanvasTexture(checkerCanvas);
  const checkerMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(roadWidth, 3),
    new THREE.MeshBasicMaterial({ map: checkerTex, side: THREE.DoubleSide })
  );
  checkerMesh.position.copy(samples[0]).add(new THREE.Vector3(0, 0.06, 0));
  const tan0 = tangents[0];
  checkerMesh.rotation.y = Math.atan2(tan0.x, tan0.z) + Math.PI / 2;
  checkerMesh.rotation.x = -Math.PI / 2 + 0.001;
  scene.add(checkerMesh);

  // ---------- 5. Grille depart ----------
  const startTangent = tangents[0];
  const startSide = new THREE.Vector3().crossVectors(startTangent, up).normalize();
  const startRotation = Math.atan2(startTangent.x, startTangent.z);
  const startPositions = [
    samples[0].clone().add(startSide.clone().multiplyScalar(-2.5)).add(new THREE.Vector3(0, 0.3, 0)),
    samples[0].clone().add(startSide.clone().multiplyScalar(2.5)).add(new THREE.Vector3(0, 0.3, 0)),
  ];

  // ---------- 6. Checkpoints ----------
  const CHECKPOINT_EVERY = 40;
  const checkpointIndices = [];
  for (let i = 0; i < samples.length; i += CHECKPOINT_EVERY) checkpointIndices.push(i);

  const checkpointRadius = roadWidth * 1.5;
  const playerProgress = {};

  function updateLap(carId, carPosition) {
    if (playerProgress[carId] === undefined) playerProgress[carId] = 0;
    const nextIdx = playerProgress[carId];
    const cpSampleIndex = checkpointIndices[nextIdx];
    const cpPos = samples[cpSampleIndex];
    const dist = Math.hypot(carPosition.x - cpPos.x, carPosition.z - cpPos.z);

    if (dist < checkpointRadius) {
      playerProgress[carId] = nextIdx + 1;
      if (playerProgress[carId] >= checkpointIndices.length) {
        playerProgress[carId] = 0;
        return { lapCompleted: true };
      }
    }
    return { lapCompleted: false, checkpointsDone: playerProgress[carId] };
  }

  // ---------- 7. Hauteur piste ----------
  function getTrackHeightAt(x, z) {
    let closest = samples[0];
    let minDist = Infinity;
    for (let i = 0; i < samples.length; i += 4) {
      const d = (samples[i].x - x) ** 2 + (samples[i].z - z) ** 2;
      if (d < minDist) {
        minDist = d;
        closest = samples[i];
      }
    }
    return closest.y;
  }

  return {
    curve,
    samples,
    roadMesh,
    startPositions,
    startRotation,
    corners: pts,
    updateLap,
    getTrackHeightAt,
  };
}
