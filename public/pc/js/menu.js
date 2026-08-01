document.addEventListener('DOMContentLoaded', () => {
  const modeCards = Array.from(document.querySelectorAll('.mode-card'));
  const modeBannerTitle = document.getElementById('mode-banner-title');
  const modeBannerDesc = document.getElementById('mode-banner-desc');
  const startBtn = document.getElementById('start-race-btn');
  const player2Card = document.querySelector('.player-card-2');
  const status2 = document.getElementById('status-2');

  const modeConfig = {
    'duel': {
      title: 'Duel 1v1',
      desc: 'Deux joueurs sont connectés sur la même piste pour une confrontation directe.',
      buttonLabel: 'Lancer la course',
      showSecondPlayer: true,
    },
    'solo-timed': {
      title: 'Solo chronométré',
      desc: 'Un seul pilote, des tours à battre et un meilleur temps à viser.',
      buttonLabel: 'Lancer le chrono',
      showSecondPlayer: false,
    },
    'solo-free': {
      title: 'Solo libre',
      desc: 'Une session détendue pour s’entraîner sans pression.',
      buttonLabel: 'Démarrer le run',
      showSecondPlayer: false,
    },
  };

  function applyMode(mode) {
    const config = modeConfig[mode] || modeConfig.duel;
    modeBannerTitle.textContent = config.title;
    modeBannerDesc.textContent = config.desc;
    startBtn.textContent = config.buttonLabel;

    modeCards.forEach((card) => card.classList.toggle('active', card.dataset.mode === mode));

    if (config.showSecondPlayer) {
      player2Card.classList.remove('is-hidden');
      status2.textContent = status2.dataset.default || 'En attente…';
    } else {
      player2Card.classList.add('is-hidden');
      status2.textContent = 'Mode solo';
    }
  }

  modeCards.forEach((card) => {
    card.addEventListener('click', () => applyMode(card.dataset.mode));
  });

  applyMode('duel');
});
