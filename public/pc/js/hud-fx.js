// Effets visuels légers pour le HUD, indépendants de la logique de jeu.
// Observe simplement le texte affiché par game.js et ajoute une classe
// "is-boosting" quand la vitesse dépasse un seuil, pour un effet de glow.
document.addEventListener('DOMContentLoaded', () => {
  const BOOST_THRESHOLD_KMH = 140;

  const watchSpeed = (spanId, blockSelector) => {
    const span = document.getElementById(spanId);
    if (!span) return;
    const block = span.closest(blockSelector);
    if (!block) return;

    const update = () => {
      const value = parseFloat(span.textContent);
      block.classList.toggle('is-boosting', !Number.isNaN(value) && value >= BOOST_THRESHOLD_KMH);
    };

    update();
    new MutationObserver(update).observe(span, { childList: true, characterData: true, subtree: true });
  };

  watchSpeed('hud-speed-1', '.hud-speed-block');
  watchSpeed('hud-speed-2', '.hud-speed-block');
});