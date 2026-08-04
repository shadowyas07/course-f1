document.addEventListener('DOMContentLoaded', () => {
  const launchScreen = document.getElementById('launch-screen');
  const launchPcBtn = document.getElementById('launch-pc-btn');
  const launchControllerBtn = document.getElementById('launch-controller-btn');
  const modeCards = Array.from(document.querySelectorAll('.mode-card'));
  const modeBannerTitle = document.getElementById('mode-banner-title');
  const modeBannerDesc = document.getElementById('mode-banner-desc');
  const startBtn = document.getElementById('start-race-btn');
  const player2Card = document.querySelector('.player-card-2');
  const status2 = document.getElementById('status-2');
  const bootScreen = document.getElementById('boot-screen');
  const lobbyScreen = document.getElementById('lobby-screen');
  const enterBtn = document.getElementById('enter-lobby-btn');
  const bestTimeValue = document.getElementById('best-time-value');
  const bestTimeMode = document.getElementById('best-time-mode');

  const modeConfig = {
    duel: {
      title: 'Duel 1v1',
      desc: 'Deux joueurs sont connectés sur la même piste pour une confrontation directe.',
      buttonLabel: 'Lancer la course',
      showSecondPlayer: true,
      bestTimeLabel: 'Duel 1v1',
      storageKey: null,
    },
    'solo-timed': {
      title: 'Solo chronométré',
      desc: 'Un seul pilote, des tours à battre et un meilleur temps à viser.',
      buttonLabel: 'Lancer le chrono',
      showSecondPlayer: false,
      bestTimeLabel: 'Solo chronométré',
      storageKey: 'solo-timed',
    },
    'solo-free': {
      title: 'Solo libre',
      desc: 'Une session détendue pour s’entraîner sans pression.',
      buttonLabel: 'Démarrer le run',
      showSecondPlayer: false,
      bestTimeLabel: 'Solo libre',
      storageKey: null,
    },
  };

  let selectedMode = 'duel';
  let pcFlowStarted = false;

  function formatTime(seconds) {
    if (seconds == null) return '--:--.---';
    const minutes = Math.floor(seconds / 60);
    const secs = seconds - minutes * 60;
    return `${minutes}:${secs.toFixed(3).padStart(6, '0')}`;
  }

  function getModeConfig(mode = selectedMode) {
    return modeConfig[mode] || modeConfig.duel;
  }

  function readBestTime(mode) {
    const key = modeConfig[mode]?.storageKey;
    if (!key) return null;
    const raw = localStorage.getItem(`car-race-best-time:${key}`);
    return raw == null ? null : Number(raw);
  }

  function saveBestTime(mode, seconds) {
    const key = modeConfig[mode]?.storageKey;
    if (!key || seconds == null) return null;
    const previous = readBestTime(mode);
    if (previous == null || seconds < previous) {
      localStorage.setItem(`car-race-best-time:${key}`, String(seconds));
      updateBestTimeDisplay();
      return seconds;
    }
    return previous;
  }

  function updateBestTimeDisplay() {
    if (!bestTimeValue || !bestTimeMode) return;
    const config = getModeConfig(selectedMode);
    bestTimeMode.textContent = config.bestTimeLabel;
    const bestTime = readBestTime(selectedMode);
    if (selectedMode === 'solo-timed') {
      bestTimeValue.textContent = formatTime(bestTime);
    } else {
      bestTimeValue.textContent = '—';
    }
  }

  function applyMode(mode) {
    selectedMode = mode;
    window.selectedMode = mode;
    window.raceSettings = window.raceSettings || {};
    window.raceSettings.mode = mode;
    const config = getModeConfig(mode);
    if (modeBannerTitle) modeBannerTitle.textContent = config.title;
    if (modeBannerDesc) modeBannerDesc.textContent = config.desc;
    if (startBtn) startBtn.textContent = config.buttonLabel;

    modeCards.forEach((card) => card.classList.toggle('active', card.dataset.mode === mode));

    if (player2Card) {
      if (config.showSecondPlayer) {
        player2Card.classList.remove('is-hidden');
        if (status2) status2.textContent = status2.dataset.default || 'En attente…';
      } else {
        player2Card.classList.add('is-hidden');
        if (status2) status2.textContent = 'Mode solo';
      }
    }

    updateBestTimeDisplay();
    if (typeof window.refreshStartButton === 'function') {
      window.refreshStartButton();
    }
    window.dispatchEvent(new CustomEvent('mode-changed', { detail: mode }));
  }

  function revealLobby() {
    if (!bootScreen || !lobbyScreen) return;
    bootScreen.classList.add('is-transitioning');
    lobbyScreen.classList.remove('hidden');
    lobbyScreen.classList.add('is-ready');
    window.setTimeout(() => {
      bootScreen.classList.add('hidden');
    }, 220);
  }

  function startPcFlow() {
    if (pcFlowStarted) return;
    pcFlowStarted = true;
    window.appRole = 'pc';
    if (launchScreen) launchScreen.classList.add('hidden');
    if (bootScreen) bootScreen.classList.remove('hidden');
    if (typeof window.startPcSession === 'function') {
      window.startPcSession();
    }
    window.setTimeout(revealLobby, 1400);
  }

  function startControllerFlow() {
    window.appRole = 'controller';
    window.location.href = '/mobile';
  }

  modeCards.forEach((card) => {
    card.addEventListener('click', () => applyMode(card.dataset.mode));
  });

  if (enterBtn) {
    enterBtn.addEventListener('click', revealLobby);
  }

  if (launchPcBtn) {
    launchPcBtn.addEventListener('click', startPcFlow);
  }

  if (launchControllerBtn) {
    launchControllerBtn.addEventListener('click', startControllerFlow);
  }

  document.addEventListener('keydown', (event) => {
    if (launchScreen && !launchScreen.classList.contains('hidden') && event.key === 'Enter') {
      event.preventDefault();
      startPcFlow();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && bootScreen && !bootScreen.classList.contains('hidden')) {
      event.preventDefault();
      revealLobby();
    }
  });

  window.saveBestTime = saveBestTime;
  window.getBestTime = readBestTime;
  window.getSelectedModeConfig = getModeConfig;

  applyMode('duel');
  updateBestTimeDisplay();
});
