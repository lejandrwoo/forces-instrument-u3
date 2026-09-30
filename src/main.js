import * as THREE from 'three/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import './styles.css';

import { createParameters } from './simulation/parameters.js';
import { createSimulation } from './simulation/createSimulation.js';
import { createLabPanel } from './ui/labPanel.js';

const COUNT = 2000; 

async function main() {
  const mount = document.querySelector('#app');

  if (!WebGPU.isAvailable()) {
    mount.appendChild(WebGPU.getErrorMessage());
    throw new Error('Este proyecto requiere WebGPU.');
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#030008');

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 100);
  camera.position.set(0, 0, 9);

  const renderer = new THREE.WebGPURenderer({ antialias: false }); 
  renderer.setPixelRatio(1); 
  renderer.setSize(innerWidth, innerHeight);
  mount.appendChild(renderer.domElement);
  await renderer.init();

  const params = createParameters();
  const simulation = createSimulation({ renderer, scene, params, count: COUNT });

  let audioContext, analyser, dataArray, audioEl;
  let isAudioPlaying = false;

  const toggleAudio = () => {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // SOLUCIÓN DE RUTA DE AUDIO PARA GITHUB PAGES / VITE:
      const audioPath = `${import.meta.env.BASE_URL}sea-of-voices-audio.mp3`.replace('//', '/');
      audioEl = new Audio(audioPath);
      audioEl.crossOrigin = "anonymous";
      audioEl.loop = true;
      
      const source = audioContext.createMediaElementSource(audioEl);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256; 
      
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      audioEl.addEventListener('timeupdate', () => {
        panel?.updateAudioTime(audioEl.currentTime, audioEl.duration);
      });
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    if (audioEl.paused) {
      audioEl.play();
      isAudioPlaying = true;
      return true;
    } else {
      audioEl.pause();
      isAudioPlaying = false;
      return false;
    }
  };

  const seekAudio = (percent) => {
    if (audioEl && audioEl.duration) {
      audioEl.currentTime = (percent / 100) * audioEl.duration;
    }
  };

  let paused = false;
  let mode = 'LAB';
  let panel;

  panel = createLabPanel({
    params,
    onReset: () => simulation.reset(),
    onPreset: () => {},
    onModeChange: () => setMode(mode === 'LAB' ? 'PERFORMANCE' : 'LAB'),
    onPauseChange: () => paused = !paused,
    onToggleAudio: toggleAudio,
    onSeekAudio: seekAudio
  });

  const hud = document.createElement('div');
  hud.className = 'hud';
  document.body.append(hud);

  simulation.reset();
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    params.updateLerp(delta);

    if (isAudioPlaying && analyser) {
      analyser.getByteFrequencyData(dataArray);
      let bass = 0, mid = 0, high = 0;
      for(let i = 0; i < 10; i++) bass += dataArray[i];
      for(let i = 10; i < 60; i++) mid += dataArray[i];
      for(let i = 60; i < 120; i++) high += dataArray[i];

      params.audioBass.value = Math.min((bass / 10) / 160.0, 1.0);
      params.audioMid.value = Math.min((mid / 50) / 150.0, 1.0);
      params.audioHigh.value = Math.min((high / 60) / 130.0, 1.0);
      params.songEnergy.value = (params.audioBass.value * 0.5) + (params.audioMid.value * 0.3) + (params.audioHigh.value * 0.2);
    }

    if (!paused) simulation.stepSimulation();
    renderer.render(scene, camera);
  });
}

main().catch((error) => {
  console.error(error);
});