# Course 3D - Manette Smartphone (Prototype LAN)

Jeu de course 3D jouable sur PC (navigateur), contrôlé à distance par un
smartphone connecté au même réseau local (volant tactile + boutons GAZ/FREIN).

## Stack

- **Backend** : Node.js, Express, Socket.io, `qrcode`
- **Frontend PC (jeu)** : Three.js (hébergé en local, pas de CDN), physique arcade maison
- **Frontend Mobile (manette)** : HTML/JS pur, volant tactile (Pointer Events)

## Installation

```bash
npm install
```

`npm install` copie automatiquement les fichiers Three.js nécessaires vers
`public/pc/js/vendor/` (voir `scripts/copy-vendor.js`, exécuté en `postinstall`).

## Lancement

```bash
npm start
```

Le terminal affiche l'IP locale à utiliser :
```
========================================
  Serveur démarré sur le port 3000 (HTTP ou HTTPS)
  PC (jeu)     : http://localhost:3000
  Mobile (LAN) : http://192.168.x.x:3000/mobile
========================================
```

## HTTPS (optionnel mais recommandé)

Le volant est désormais 100% tactile (pas de gyroscope), donc **HTTPS n'est
plus obligatoire**. Tu peux rester en HTTP si tu préfères la simplicité.

Si tu veux quand même activer HTTPS (bonnes pratiques réseau, ou si tu
réintroduis le gyroscope plus tard) :

```bash
sudo pacman -S mkcert nss   # Arch Linux
mkcert -install
mkdir -p server/certs && cd server/certs
mkcert <TON_IP_LOCALE> localhost 127.0.0.1
cd ../..
cp "$(mkcert -CAROOT)/rootCA.pem" server/certs/rootCA.pem
```
Le serveur détecte automatiquement les certificats présents dans
`server/certs/` et bascule en HTTPS. Pour faire confiance au certificat sur
iPhone : ouvre `https://<IP>:3000/rootCA.pem` dans Safari, installe le profil
(Réglages > Profil téléchargé), puis active la confiance totale dans
Réglages > Général > Informations > Réglages de confiance des certificats.

## Comment jouer

1. Ouvre `http://<IP_LOCALE>:3000` sur le PC → un QR code s'affiche.
2. Scanne-le avec ton smartphone (même réseau Wi-Fi).
3. Tourne ton téléphone en mode paysage.
4. Utilise le volant tactile (glisse le doigt dessus pour tourner) et les
   boutons **FREIN** / **GAZ** à droite.
5. Dès que la manette est connectée, l'écran PC bascule automatiquement sur
   la scène 3D et la voiture apparaît sur le circuit.

## Architecture des fichiers

```
car-game-project/
├── package.json
├── scripts/
│   └── copy-vendor.js       # Copie Three.js en local après npm install
├── server/
│   ├── server.js            # Serveur Express + Socket.io + QR code + HTTP/HTTPS auto
│   ├── rooms.js              # Gestion des rooms (association PC <-> Mobile)
│   └── certs/                 # (optionnel) certificats mkcert pour HTTPS
├── public/
│   ├── pc/                   # Le jeu (écran PC)
│   │   ├── index.html
│   │   ├── css/style.css
│   │   └── js/
│   │       ├── network.js    # Connexion Socket.io, réception des inputs manette
│   │       ├── game.js       # Scène Three.js, circuit, voiture, physique, caméra
│   │       └── vendor/        # Three.js (copié automatiquement, pas de CDN)
│   └── mobile/                # La manette (écran smartphone)
│       ├── index.html
│       ├── css/controller.css
│       └── js/controller.js  # Volant tactile + boutons GAZ/FREIN
└── README.md
```

## Réglages de gameplay (dans `game.js`)

- `TRACK` : forme du circuit (longueur des lignes droites, rayon des virages, largeur de route)
- `PHYSICS_PARAMS` : vitesse max, accélération, freinage, sensibilité du braquage
- `cameraRig` : distance/hauteur/lissage de la caméra de suivi

## Debug

- `window.__debugPhysics` (console du navigateur PC) : état en temps réel de
  la position/vitesse/cap de la voiture.
- `window.carControls` (console du navigateur PC) : dernier état des inputs
  reçus de la manette (steerAngle, gasPressed, brakePressed).
- Route `/ping` : test de connectivité HTTP(S) basique, sans JS/CSS.

## Prochaines pistes d'amélioration

- Collisions avec les bords du circuit
- Chronomètre / tours de circuit
- Effets sonores (moteur, freinage)
- Plusieurs voitures / multijoueur
# course-f1
