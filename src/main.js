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
      // BASE_URL respeta la subcarpeta de GitHub Pages (/porter-robinson/) y también funciona en local
      audioEl = new Audio(import.meta.env.BASE_URL + 'sea-of-voices-audio.mp3');
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

  // Detector de golpes por banda: el valor actual supera su promedio reciente.
  const onsets = {
    bass: { avg: 0, last: 0, ratio: 1.25, floor: 0.06, cooldown: 0.22 },
    mid: { avg: 0, last: 0, ratio: 1.25, floor: 0.06, cooldown: 0.35 },
    high: { avg: 0, last: 0, ratio: 1.35, floor: 0.06, cooldown: 0.18 }
  };
  const detect = (key, value, delta, now) => {
    const st = onsets[key];
    const hit = value > st.avg * st.ratio + st.floor && now - st.last > st.cooldown;
    st.avg += (value - st.avg) * Math.min(delta * 1.5, 1);
    if (!hit) return 0;
    st.last = now;
    return Math.min(1, value - st.avg + 0.3); // fuerza del golpe, 0.3–1
  };

  // "Brillo" del sonido (centroide espectral): sube o baja según la melodía/armonía.
  let centroidFast = 0.5;
  let centroidSlow = 0.5;
  const spectralCentroid = () => {
    let num = 0, den = 0;
    for (let i = 1; i < 250; i++) {
      num += i * dataArray[i];
      den += dataArray[i];
    }
    return den > 0 ? Math.min(Math.log2(1 + num / den) / Math.log2(250), 1) : 0.5;
  };

  // Tempo: mediana del intervalo entre bombos → 70–180 BPM se mapea a 0.75–1.35
  const kickTimes = [];
  let tempoSmooth = 1;
  const updateTempo = (delta, now, playing) => {
    while (kickTimes.length && now - kickTimes[0] > 6) kickTimes.shift();
    let target = 1;
    if (playing && kickTimes.length >= 4) {
      const gaps = [];
      for (let i = 1; i < kickTimes.length; i++) gaps.push(kickTimes[i] - kickTimes[i - 1]);
      gaps.sort((a, b) => a - b);
      let bpm = 60 / Math.max(gaps[Math.floor(gaps.length / 2)], 0.05);
      while (bpm > 180) bpm /= 2;
      while (bpm < 70) bpm *= 2;
      target = 0.75 + ((bpm - 70) / 110) * 0.6;
    }
    tempoSmooth += (target - tempoSmooth) * Math.min(delta * 0.5, 1); // cambia despacio (~2 s)
    params.tempo.value = tempoSmooth;
  };

  const analyseAudio = (delta, now) => {
    let bass = 0, mid = 0, high = 0;
    const playing = isAudioPlaying && analyser;

    if (playing) {
      analyser.getByteFrequencyData(dataArray);
      bass = Math.min(bandAverage(1, 7) / 160, 1); //    ~45–300 Hz
      mid = Math.min(bandAverage(7, 60) / 140, 1); //    ~300 Hz–2.6 kHz
      high = Math.min(bandAverage(60, 250) / 110, 1); // ~2.6–10 kHz
    }

    const release = Math.exp(-delta * 6);
    env.bass = Math.max(bass, env.bass * release);
    env.mid = Math.max(mid, env.mid * release);
    env.high = Math.max(high, env.high * release);

    params.audioBass.value = env.bass;
    params.audioMid.value = env.mid;
    params.audioHigh.value = env.high;
    params.songEnergy.value = env.bass * 0.5 + env.mid * 0.3 + env.high * 0.2;

    const kick = detect('bass', bass, delta, now);
    const melody = detect('mid', mid, delta, now);
    const hat = detect('high', high, delta, now);

    if (kick) kickTimes.push(now);
    updateTempo(delta, now, playing);

    if (!playing) return;

    // Los efectos que antes daban W A S D, ahora los da la canción (suaves):
    //   S · pulso de onda      ← golpe de bajo (bombo)
    //   W · sacudida de rumbo  ← transitorios agudos (hi-hat, caja) y bombos fuertes
    //   D · remolino           ← golpes en los medios (voz, melodía)
    //   A · giro del campo     ← movimiento del brillo del sonido (sube/baja la armonía)
    if (kick) {
      params.firePulse(0.5 + kick * 0.8);
      params.hitBeat(0.55 + kick * 0.6);
      params.keyboardChaos.value = Math.max(params.keyboardChaos.value, 0.12 + kick * 0.2);
    }
    if (hat) {
      params.keyboardChaos.value = Math.max(params.keyboardChaos.value, 0.15 + hat * 0.3);
      params.hitSnap(0.5 + hat * 0.5);
    }
    if (melody) {
      params.keyboardWarp.value = Math.max(params.keyboardWarp.value, 0.3 + melody * 0.5);
      params.hitSnap(0.35 + melody * 0.4);
    }

    centroidFast += (spectralCentroid() - centroidFast) * Math.min(delta * 6, 1);
    centroidSlow += (centroidFast - centroidSlow) * Math.min(delta * 0.8, 1);
    const drift = centroidFast - centroidSlow; // >0 el sonido se vuelve más agudo
    params.keyboardRotation.value += drift * delta * 14;
    if (melody) params.keyboardRotation.value += Math.sign(drift || 1) * (0.1 + melody * 0.25);
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
      ? '<b>PHYSARUM WAVES</b> · 1-6: visuales · P: performance · Espacio: repeler'
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