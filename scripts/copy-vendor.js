/**
 * scripts/copy-vendor.js
 * Copie automatiquement three.module.min.js depuis node_modules vers
 * public/pc/js/vendor/, pour que le jeu fonctionne 100% en local
 * (aucune dépendance à un CDN, donc utilisable sans accès Internet).
 * Exécuté automatiquement après `npm install` (voir "postinstall" dans package.json).
 */
const fs = require("fs");
const path = require("path");

const filesToCopy = ["three.module.min.js", "three.core.min.js"];
const srcDir = path.join(__dirname, "..", "node_modules", "three", "build");
const destDir = path.join(__dirname, "..", "public", "pc", "js", "vendor");

fs.mkdirSync(destDir, { recursive: true });

for (const file of filesToCopy) {
  const src = path.join(srcDir, file);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-vendor] ${file} introuvable dans node_modules, skip.`);
    continue;
  }
  fs.copyFileSync(src, path.join(destDir, file));
  console.log(`[copy-vendor] ${file} copié vers public/pc/js/vendor/`);
}
