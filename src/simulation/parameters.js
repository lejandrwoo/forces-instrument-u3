import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// Un preset por imagen de referencia. Teclas 1-6.
//
// numbers  -> valores escalares que se interpolan (lerp) al cambiar de preset
// vectors  -> vec3/vec4 que se interpolan
// colors   -> paleta, también interpolada
//
// fieldWeights = [anillos, radial, ondas espejo, contornos]
//   anillos  : los agentes giran alrededor del centro (túnel, espirales)
//   radial   : los agentes salen del centro (iris, estrella)
//   ondas    : líneas horizontales onduladas y simétricas (horizonte)
//   contornos: siguen curvas de nivel de un campo suave (topografía, marea)
//
// Las tres especies de agentes (Sage Jenson / 36 Points) depositan en canales
// distintos (R,G,B del mapa de rastro). attractN es la fila de la matriz de
// interacción: cuánto atrae (+) o repele (-) el rastro de cada especie.

const base = {
  sensorDist: 16,
  sensorAngle: 0.5,
  rotateAngle: 0.4,
  stepSize: 1.0,
  deposit: 0.35,
  decay: 0.06,
  diffuse: 0.5,
  exposure: 1.4,
  fieldStrength: 0.3,
  fieldFreq: 1.0,
  velWobble: 0.25,
  voidRadius: 0.0,
  coreSoft: 0.0,
  audioTame: 0.0,
  bandAmount: 0.0,
  bandFreq: 8.0,
  glow: 0.5
};

const vecBase = {
  speciesSensor: [1.0, 1.5, 0.7],
  speciesStep: [1.0, 0.8, 1.25],
  attract0: [1.0, 0.25, -0.3],
  attract1: [0.2, 1.0, 0.2],
  attract2: [-0.4, 0.3, 1.0],
  fieldWeights: [0, 0, 0, 0]
};

const make = (name, numbers, vectors, colors) => ({
  name,
  numbers: { ...base, ...numbers },
  vectors: { ...vecBase, ...vectors },
  colors
});

export const PRESET_LIST = [
  // 1 · Horizonte espejo: ondas violetas simétricas, banda central blanco-verdosa
  make(
    'Horizonte',
    {
      sensorDist: 10, sensorAngle: 0.32, rotateAngle: 0.22, stepSize: 1.1,
      deposit: 0.4, decay: 0.09, diffuse: 0.4, exposure: 1.3,
      fieldStrength: 0.5, fieldFreq: 1.0, velWobble: 0.15,
      bandAmount: 0.55, bandFreq: 5.0, glow: 0.5
    },
    { fieldWeights: [0, 0, 1.0, 0.0] },
    {
      colBg: '#04000c', colLow: '#3b0c8f', colMid: '#9a2dff',
      colHigh: '#e6fff4', colAccent: '#58ffd0', colAccent2: '#7a3cff'
    }
  ),

  // 2 · Túnel: anillos concéntricos violetas con centro oscuro
  make(
    'Túnel',
    {
      sensorDist: 12, sensorAngle: 0.38, rotateAngle: 0.28, stepSize: 1.0,
      deposit: 0.4, decay: 0.07, diffuse: 0.45, exposure: 1.3,
      fieldStrength: 0.55, velWobble: 0.1, voidRadius: 0.09,
      bandAmount: 0.35, bandFreq: 6.0
    },
    { fieldWeights: [1.0, 0.12, 0, 0.1] },
    {
      colBg: '#030008', colLow: '#2a0068', colMid: '#7a1fe0',
      colHigh: '#dba6ff', colAccent: '#9a4dff', colAccent2: '#ff4fd8'
    }
  ),

  // 3 · Marea violeta: líneas densas y rizadas, violeta/azul con bordes magenta
  make(
    'Marea',
    {
      sensorDist: 14, sensorAngle: 0.7, rotateAngle: 0.55, stepSize: 1.2,
      deposit: 0.35, decay: 0.05, diffuse: 0.35, exposure: 1.5,
      fieldStrength: 0.28, fieldFreq: 1.6, velWobble: 0.4,
      bandAmount: 0.3, bandFreq: 7.0
    },
    { fieldWeights: [0.25, 0, 0, 0.75] },
    {
      colBg: '#02000a', colLow: '#2a0d7a', colMid: '#6a2bff',
      colHigh: '#c13cff', colAccent: '#ff2b9a', colAccent2: '#3a5bff'
    }
  ),

  // 4 · Iris: venas radiales finas lila sobre violeta profundo, pupila negra
  make(
    'Iris',
    {
      sensorDist: 22, sensorAngle: 0.6, rotateAngle: 0.42, stepSize: 1.0,
      deposit: 0.3, decay: 0.045, diffuse: 0.3, exposure: 1.7,
      fieldStrength: 0.35, velWobble: 0.2, voidRadius: 0.0, coreSoft: 1.0
    },
    { fieldWeights: [0, 0.75, 0, 0.35] },
    {
      colBg: '#08001a', colLow: '#4a22b8', colMid: '#a98aff',
      colHigh: '#f0e4ff', colAccent: '#c7a6ff', colAccent2: '#7d5cff'
    }
  ),

  // 5 · Topografía azul: curvas de nivel azul-blanco
  make(
    'Topografía',
    {
      sensorDist: 12, sensorAngle: 0.3, rotateAngle: 0.2, stepSize: 0.8,
      deposit: 0.45, decay: 0.035, diffuse: 0.65, exposure: 1.2,
      fieldStrength: 0.6, fieldFreq: 1.3, velWobble: 0.3,
      bandAmount: 0.75, bandFreq: 9.0, glow: 0.8, audioTame: 1.0
    },
    { fieldWeights: [0, 0, 0, 1.0] },
    {
      colBg: '#000003', colLow: '#14168a', colMid: '#4f63ff',
      colHigh: '#eef8ff', colAccent: '#7fb0ff', colAccent2: '#2b2bd0'
    }
  ),

  // 6 · Pétalo: estrella de ondas, índigo con verde oliva y destellos lila
  make(
    'Pétalo',
    {
      sensorDist: 13, sensorAngle: 0.42, rotateAngle: 0.3, stepSize: 1.0,
      deposit: 0.4, decay: 0.075, diffuse: 0.4, exposure: 1.35,
      fieldStrength: 0.5, fieldFreq: 1.2, velWobble: 0.3, voidRadius: 0.0, coreSoft: 1.0,
      bandAmount: 0.5, bandFreq: 7.0
    },
    { fieldWeights: [0.35, 0.45, 0, 0.6] },
    {
      colBg: '#010107', colLow: '#1f6158', colMid: '#5646e6',
      colHigh: '#e2b8ff', colAccent: '#a8d62e', colAccent2: '#2f8f86'
    }
  )
];

const DEFAULT_PRESET = 0;


export function createParameters() {
  const color = (hex) => uniform(new THREE.Color(hex));
  const v3 = (x, y, z) => uniform(new THREE.Vector3(x, y, z));

  const params = {
    // --- tiempo ---
    timeScale: uniform(1.0),
    frame: uniform(0.0),
    phase: uniform(0.0), // fase de las ondas; avanza más rápido con la música

    // --- Physarum (Jeff Jones): sentir → girar → avanzar → depositar ---
    sensorDist: uniform(16.0),
    sensorAngle: uniform(0.5),
    rotateAngle: uniform(0.4),
    stepSize: uniform(1.0),
    deposit: uniform(0.35),
    decay: uniform(0.06),
    diffuse: uniform(0.5),
    velWobble: uniform(0.25), // "weird velocity": la velocidad ondula en el espacio

    // --- 3 especies (Sage Jenson) ---
    speciesSensor: v3(1, 1.5, 0.7),
    speciesStep: v3(1, 0.8, 1.25),
    attract0: v3(1, 0.25, -0.3),
    attract1: v3(0.2, 1, 0.2),
    attract2: v3(-0.4, 0.3, 1),

    // --- campo de flujo que da la forma de cada referencia ---
    fieldWeights: uniform(new THREE.Vector4(0, 0, 0, 0)),
    fieldStrength: uniform(0.3),
    fieldFreq: uniform(1.0),
    voidRadius: uniform(0.0),
    coreSoft: uniform(0.0), // suaviza la convergencia de líneas en el centro (sin agujero)
    audioTame: uniform(0.0), // 1 = la música mueve las líneas pero NO satura el brillo
    tempo: uniform(1.0), // ritmo de la canción: lenta < 1 < rápida

    // --- render / color ---
    exposure: uniform(1.4),
    bandAmount: uniform(0.0),
    bandFreq: uniform(8.0),
    glow: uniform(0.5),
    colBg: color('#04000c'),
    colLow: color('#3b0c8f'),
    colMid: color('#9a2dff'),
    colHigh: color('#e6fff4'),
    colAccent: color('#58ffd0'),
    colAccent2: color('#7a3cff'),

    // --- audio ---
    audioBass: uniform(0.0),
    audioMid: uniform(0.0),
    audioHigh: uniform(0.0),
    songEnergy: uniform(0.0),
    beat: uniform(0.0), // golpe seco de bombo (decae en ~0.1 s)
    snap: uniform(0.0), // golpe de medios/agudos (voz, caja, hi-hat)

    // --- teclado (W A S D) y transición ---
    keyboardChaos: uniform(0.0), // W: sacudida de rumbo
    keyboardRotation: uniform(0.0), // A: gira el campo (espirales)
    keyboardWarp: uniform(0.0), // D: remolino
    transitionBurst: uniform(0.0), // se activa al cambiar de preset

    // --- puntero (fuente de comida / repelente) ---
    pointer: uniform(new THREE.Vector2(-10000, -10000)),
    brushRadius: uniform(60.0),
    brushStrength: uniform(0.6),
    brushSign: uniform(1.0), // Espacio lo invierte

    // --- pulso de onda expansiva (tecla S y golpes de bajo) ---
    pulseRadius: uniform(2.0),
    pulseAmp: uniform(0.0)
  };

  // Lo que se interpola suavemente entre presets
  const LERPED = [
    'sensorDist', 'sensorAngle', 'rotateAngle', 'stepSize', 'deposit', 'decay',
    'diffuse', 'velWobble', 'speciesSensor', 'speciesStep', 'attract0', 'attract1',
    'attract2', 'fieldWeights', 'fieldStrength', 'fieldFreq', 'voidRadius', 'coreSoft', 'audioTame',
    'exposure', 'bandAmount', 'bandFreq', 'glow', 'colBg', 'colLow', 'colMid',
    'colHigh', 'colAccent', 'colAccent2'
  ];

  const targets = {};
  for (const key of LERPED) {
    const val = params[key].value;
    targets[key] = typeof val === 'number' ? val : val.clone();
  }

  let activePreset = -1;

  function applyPreset(index) {
    const preset = PRESET_LIST[index];
    if (!preset) return;
    activePreset = index;

    for (const [key, val] of Object.entries(preset.numbers)) targets[key] = val;
    for (const [key, arr] of Object.entries(preset.vectors)) targets[key].set(...arr);
    for (const [key, hex] of Object.entries(preset.colors)) targets[key].set(hex);

    // Al cambiar de preset: sacude los agentes y acelera el decaimiento un instante
    // para que el patrón viejo se disuelva y se reorganice con el nuevo campo.
    params.transitionBurst.value = 1.0;
    firePulse(1.0);
  }

  function hitBeat(v = 1.0) {
    params.beat.value = Math.min(1, Math.max(params.beat.value, v));
  }

  function hitSnap(v = 1.0) {
    params.snap.value = Math.min(1, Math.max(params.snap.value, v));
  }

  function firePulse(amp = 1.0) {
    params.pulseRadius.value = 0.02;
    params.pulseAmp.value = Math.max(params.pulseAmp.value, amp);
  }

  // Se llama una vez por paso de simulación
  function tick() {
    params.frame.value = (params.frame.value + 1) % 65536;
  }

  // Se llama una vez por frame de pantalla
  function updateLerp(dt) {
    const k = 1 - Math.exp(-dt * 2.2); // ~1.5 s de transición

    for (const key of LERPED) {
      const uni = params[key];
      const target = targets[key];
      if (typeof target === 'number') uni.value += (target - uni.value) * k;
      else uni.value.lerp(target, k);
    }

    params.phase.value +=
      dt *
      params.tempo.value *
      (0.25 +
        params.songEnergy.value * 1.4 +
        params.audioBass.value * 0.8 +
        params.audioMid.value * 0.5 +
        params.beat.value * 2.2);

    // Golpes de beat: suben de golpe y caen rápido
    params.beat.value *= Math.exp(-dt * 9);
    params.snap.value *= Math.exp(-dt * 9);

    // Impulsos que se desvanecen
    params.keyboardChaos.value *= 0.92;
    params.keyboardRotation.value *= 0.96;
    params.keyboardWarp.value *= 0.93;
    params.transitionBurst.value *= 0.965;

    // Pulso: el anillo se expande y se apaga
    params.pulseRadius.value += dt * 0.75;
    params.pulseAmp.value *= 0.95;
  }

  applyPreset(DEFAULT_PRESET);
  // Arranca ya en el preset por defecto, sin transición desde valores neutros
  for (const key of LERPED) {
    const uni = params[key];
    const target = targets[key];
    if (typeof target === 'number') uni.value = target;
    else uni.value.copy(target);
  }
  params.transitionBurst.value = 0.0;
  params.pulseAmp.value = 0.0;

  return {
    ...params,
    targets,
    applyPreset,
    firePulse,
    hitBeat,
    hitSnap,
    tick,
    updateLerp,
    getActivePreset: () => activePreset
  };
}