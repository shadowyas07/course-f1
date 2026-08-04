// ============================================================
// game.js — exemple d'intégration de track-spa.js
// ============================================================
import * as THREE from 'three';
import { buildSpaTrack } from './track-spa.js';

// ---------- Setup Three.js minimal ----------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x334422, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(200, 300, 100);
scene.add(sun);

// ---------- Création du circuit ----------
const track = buildSpaTrack(scene, THREE, {
  roadWidth: 12,
  curbWidth: 1.4,
  sampleCount: 600,
  addGround: true,
  elevationScale: 0,     // flat mode par défaut (physique stable)
  baseHeight: 0,
  checkpointEvery: 20,
  debug: false,
});

// ---------- Spawn des 2 voitures ----------
function makeCarMesh(color) {
  const geo = new THREE.BoxGeometry(1.8, 1, 3.6);
  const mat = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

const cars = [
  { id: 'player1', mesh: makeCarMesh(0xff2222), velocity: 0 },
  { id: 'player2', mesh: makeCarMesh(0x2266ff), velocity: 0 },
];

cars.forEach((car, i) => {
  const spawn = track.startPositions[i];
  car.mesh.position.set(spawn.x, spawn.y + 0.5, spawn.z);
  car.mesh.rotation.y = track.startRotation; // alignement cohérent avec la piste
  scene.add(car.mesh);
});

camera.position.set(0, 40, 60);
camera.lookAt(0, 0, 0);

// ---------- Boucle de jeu ----------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  cars.forEach((car) => {
    // TODO: remplacer par la logique de contrôle/physique réelle du jeu
    updateCarPhysics(car, dt);

    // Maintien de la voiture sur la hauteur du circuit
    const y = track.getTrackHeightAt(car.mesh.position.x, car.mesh.position.z);
    car.mesh.position.y = y + 0.5;

    // Validation de tour
    const result = track.updateLap(car.id, car.mesh.position);
    if (result.lapCompleted) {
      console.log(`${car.id} a complété un tour !`);
    }

    // Exemple d'usage IA / correction de trajectoire
    const sample = track.getClosestTrackSample(car.mesh.position.x, car.mesh.position.z);
    if (sample.distance > track.config.roadWidth / 2 + 3) {
      // la voiture sort de la piste -> ex: ralentir, remettre sur la trajectoire, etc.
    }
  });

  updateMinimap();
  renderer.render(scene, camera);
}

function updateCarPhysics(car, dt) {
  // Placeholder simple d'avancement (à remplacer par le vrai contrôleur)
  car.mesh.translateZ(20 * dt);
}

animate();

// ---------- Minimap : calcul scale/center à partir de bounds ----------
const minimapCanvas = document.createElement('canvas');
minimapCanvas.width = 200;
minimapCanvas.height = 200;
minimapCanvas.style.position = 'fixed';
minimapCanvas.style.right = '16px';
minimapCanvas.style.top = '16px';
document.body.appendChild(minimapCanvas);
const mmCtx = minimapCanvas.getContext('2d');

function worldToMinimap(x, z) {
  const b = track.bounds;
  const scale = minimapCanvas.width / (b.halfExtent * 2);
  return {
    x: (x - b.centerX) * scale + minimapCanvas.width / 2,
    y: (z - b.centerZ) * scale + minimapCanvas.height / 2,
  };
}

function updateMinimap() {
  mmCtx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  mmCtx.strokeStyle = '#ffffff';
  mmCtx.beginPath();
  track.centerPoints.forEach((p, i) => {
    const m = worldToMinimap(p.x, p.z);
    if (i === 0) mmCtx.moveTo(m.x, m.y); else mmCtx.lineTo(m.x, m.y);
  });
  mmCtx.closePath();
  mmCtx.stroke();

  const colors = ['#ff2222', '#2266ff'];
  cars.forEach((car, i) => {
    const m = worldToMinimap(car.mesh.position.x, car.mesh.position.z);
    mmCtx.fillStyle = colors[i] || '#ffffff';
    mmCtx.beginPath();
    mmCtx.arc(m.x, m.y, 3, 0, Math.PI * 2);
    mmCtx.fill();
  });
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
