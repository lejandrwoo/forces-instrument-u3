import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import './styles.css';

import { createParameters, PRESET_LIST } from './simulation/parameters.js';
import { createSimulation } from './simulation/createSimulation.js';
import { createLabPanel } from './ui/labPanel.js';

// Más agentes = más detalle, más carga. Prueba: ?agents=131072 en GPUs modestas.
const COUNT = Number(new URLSearchParams(location.search).get('agents')) || 262144;
const GRID_H = 720;
const STEP = 1 / 60; // la simulación avanza a 60 Hz fijos, sea cual sea el monitor

async function main() {
  const mount = document.querySelector('#app');

  if (!WebGPU.isAvailable()) {
    mount.appendChild(WebGPU.getErrorMessage());
    throw new Error('Este proyecto requiere WebGPU.');
  }

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;

  const renderer = new THREE.WebGPURenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  mount.appendChild(renderer.domElement);
  await renderer.init();

  // El mapa de rastro respeta la proporción de la ventana
  const gridW = Math.min(2200, Math.max(640, Math.round(GRID_H * (innerWidth / innerHeight))));

  const params = createParameters();
  const simulation = createSimulation({
    renderer,
    scene,
    params,
    count: COUNT,
    gridWidth: gridW,
    gridHeight: GRID_H
  });

  // ---------------- AUDIO ----------------
  let audioContext, analyser, dataArray, audioEl;
  let isAudioPlaying = false;
  let panel;

  const toggleAudio = () => {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioEl = new Audio('/sea-of-voices-audio.mp3');
      audioEl.crossOrigin = 'anonymous';
      audioEl.loop = true;

      const source = audioContext.createMediaElementSource(audioEl);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024; // 512 bins de ~43 Hz: graves, medios y agudos bien separados
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      dataArray = new Uint8Array(analyser.frequencyBinCount);

      audioEl.addEventListener('timeupdate', () => {
        panel?.updateAudioTime(audioEl.currentTime, audioEl.duration);
      });
    }

    if (audioContext.state === 'suspended') audioContext.resume();

    if (audioEl.paused) {
      audioEl.play();
      isAudioPlaying = true;
      return true;
    }
    audioEl.pause();
    isAudioPlaying = false;
    return false;
  };

  const seekAudio = (percent) => {
    if (audioEl && audioEl.duration) audioEl.currentTime = (percent / 100) * audioEl.duration;
  };

  const bandAverage = (from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += dataArray[i];
    return sum / (to - from);
  };

  // Envolvente con ataque instantáneo y caída suave, para que no parpadee
  const env = { bass: 0, mid: 0, high: 0 };
  let bassSlow = 0;
  let lastBeat = 0;

  const analyseAudio = (delta, now) => {
    let bass = 0, mid = 0, high = 0;

    if (isAudioPlaying && analyser) {
      analyser.getByteFrequencyData(dataArray);
      bass = Math.min(bandAverage(1, 7) / 170, 1); //   ~45–300 Hz
      mid = Math.min(bandAverage(7, 60) / 150, 1); //   ~300 Hz–2.6 kHz
      high = Math.min(bandAverage(60, 250) / 120, 1); // ~2.6–10 kHz
    }

    const release = Math.exp(-delta * 6);
    env.bass = Math.max(bass, env.bass * release);
    env.mid = Math.max(mid, env.mid * release);
    env.high = Math.max(high, env.high * release);

    params.audioBass.value = env.bass;
    params.audioMid.value = env.mid;
    params.audioHigh.value = env.high;
    params.songEnergy.value = env.bass * 0.5 + env.mid * 0.3 + env.high * 0.2;

    // Golpe de bajo: el bajo supera su promedio reciente → pulso de onda
    bassSlow += (bass - bassSlow) * Math.min(delta * 1.5, 1);
    if (isAudioPlaying && bass > bassSlow * 1.3 + 0.08 && now - lastBeat > 0.28) {
      lastBeat = now;
      params.firePulse(0.5 + bass * 0.8);
    }
  };

  // ---------------- PUNTERO ----------------
  addEventListener('pointermove', (event) => {
    params.pointer.value.set(
      (event.clientX / innerWidth) * simulation.gridWidth,
      (1 - event.clientY / innerHeight) * simulation.gridHeight
    );
  });
  document.addEventListener('mouseleave', () => params.pointer.value.set(-10000, -10000));

  // ---------------- ESTADO / UI ----------------
  let paused = false;
  let mode = 'LAB';
  const hud = document.createElement('div');
  hud.className = 'hud';
  document.body.append(hud);

  const applyPreset = (index) => {
    params.applyPreset(index);
    panel?.refresh();
    panel?.setActivePreset(index);
  };

  const setMode = (next) => {
    mode = next;
    const lab = mode === 'LAB';
    panel.setVisible(lab);
    hud.innerHTML = lab
      ? '<b>PHYSARUM WAVES</b> · 1-6: visuales · W: caos · A: giro · S: pulso · D: remolino · Espacio: repeler'
      : '';
  };

  panel = createLabPanel({
    params,
    onReset: () => simulation.reset(),
    onPreset: applyPreset,
    onModeChange: () => setMode(mode === 'LAB' ? 'PERFORMANCE' : 'LAB'),
    onPauseChange: () => (paused = !paused),
    onToggleAudio: toggleAudio,
    onSeekAudio: seekAudio
  });
  panel.setActivePreset(params.getActivePreset());
  setMode('LAB');

  // ---------------- TECLADO ----------------
  addEventListener('keydown', (event) => {
    if (event.repeat) return;
    const code = event.code;

    if (code === 'KeyP') setMode(mode === 'LAB' ? 'PERFORMANCE' : 'LAB');
    if (code === 'KeyR') simulation.reset();

    // 1–6 → cada visual (teclado normal y numérico)
    const match = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (match) {
      const index = Number(match[1]) - 1;
      if (index < PRESET_LIST.length) applyPreset(index);
    }

    if (code === 'KeyW') params.keyboardChaos.value = 1.5; // sacudida de rumbo
    if (code === 'KeyA') params.keyboardRotation.value += 1.0; // gira el campo
    if (code === 'KeyS') params.firePulse(1.8); // pulso de onda expansiva
    if (code === 'KeyD') params.keyboardWarp.value = 1.5; // remolino

    if (code === 'Space') {
      event.preventDefault();
      params.brushSign.value = -1; // el puntero repele mientras se mantiene
    }
  });

  addEventListener('keyup', (event) => {
    if (event.code === 'Space') params.brushSign.value = 1;
  });

  addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight));

  // ---------------- LOOP ----------------
  simulation.reset();
  const clock = new THREE.Clock();
  let accumulator = 0;

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    const now = clock.elapsedTime;

    analyseAudio(delta, now);
    params.updateLerp(delta);

    if (!paused) {
      accumulator += delta;
      let steps = 0;
      while (accumulator >= STEP && steps < 3) {
        simulation.stepSimulation();
        accumulator -= STEP;
        steps++;
      }
      if (steps === 3) accumulator = 0;
    }

    renderer.render(scene, camera);
  });
}

main().catch((error) => {
  console.error(error);
});