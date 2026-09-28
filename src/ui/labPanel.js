import { PRESET_LIST } from '../simulation/parameters.js';

function rangeRow(parent, label, object, targets, key, min, max, step, onInput) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const lab = document.createElement('label');
  const name = document.createElement('span');
  const value = document.createElement('span');
  value.className = 'value';
  name.textContent = label;
  lab.append(name, value);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  const current = () => Number(targets && key in targets ? targets[key] : object[key].value);
  input.value = String(current());
  const digits = step < 0.01 ? 3 : 2;
  const show = (val) => (value.textContent = val.toFixed(digits));
  input.addEventListener('input', () => {
    const val = Number(input.value);
    if (targets && key in targets) targets[key] = val;
    else object[key].value = val;
    show(val);
    onInput?.(val);
  });
  show(current());
  wrap.append(lab, input);
  parent.append(wrap);
  return {
    refresh() {
      const next = current();
      input.value = String(next);
      show(next);
    }
  };
}

function button(parent, label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  parent.append(b);
  return b;
}

function group(panel, title) {
  const g = document.createElement('div');
  g.className = 'group';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  g.append(h2);
  panel.append(g);
  return g;
}

export function createLabPanel({
  params,
  onReset,
  onPreset,
  onModeChange,
  onPauseChange,
  onToggleAudio,
  onSeekAudio
}) {
  const refreshers = [];
  const panel = document.createElement('aside');
  panel.className = 'panel';

  const h1 = document.createElement('h1');
  h1.textContent = 'Audio Reactive Physarum';
  const intro = document.createElement('p');
  intro.innerHTML = 'Pulsa <b>P</b> para modo PERFORMANCE.';
  panel.append(h1, intro);

  // --- Música ---
  const audioGroup = group(panel, 'Música');
  const playBtn = button(audioGroup, '▶️ PLAY', () => {
    const isPlaying = onToggleAudio();
    playBtn.textContent = isPlaying ? '⏸ PAUSE' : '▶️ PLAY';
    playBtn.style.background = isPlaying ? '#a600ff' : '';
    playBtn.style.color = isPlaying ? '#fff' : '';
  });

  const progressWrap = document.createElement('div');
  progressWrap.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:10px';
  const progressSlider = document.createElement('input');
  progressSlider.type = 'range';
  progressSlider.min = 0;
  progressSlider.max = 100;
  progressSlider.step = 0.1;
  progressSlider.value = 0;
  progressSlider.style.flex = '1';
  const progressLabel = document.createElement('span');
  progressLabel.textContent = '0:00 / 0:00';
  progressLabel.style.cssText = 'font-size:12px;color:#fff';

  let isDragging = false;
  progressSlider.addEventListener('pointerdown', () => (isDragging = true));
  progressSlider.addEventListener('pointerup', () => (isDragging = false));
  progressSlider.addEventListener('input', () => onSeekAudio(Number(progressSlider.value)));
  progressWrap.append(progressSlider, progressLabel);
  audioGroup.append(progressWrap);

  // --- Presets ---
  const presetGroup = group(panel, 'Visuales (teclas 1-6)');
  const presetButtons = PRESET_LIST.map((preset, i) =>
    button(presetGroup, `${i + 1}. ${preset.name}`, () => onPreset(i))
  );

  // --- Physarum ---
  const physGroup = group(panel, 'Physarum');
  const R = (label, key, min, max, step) =>
    refreshers.push(rangeRow(physGroup, label, params, params.targets, key, min, max, step));
  R('Distancia sensor', 'sensorDist', 3, 40, 0.5);
  R('Ángulo sensor', 'sensorAngle', 0.1, 1.4, 0.02);
  R('Ángulo giro', 'rotateAngle', 0.05, 1.2, 0.02);
  R('Paso', 'stepSize', 0.2, 3, 0.05);
  R('Depósito', 'deposit', 0.02, 1.5, 0.01);
  R('Decaimiento', 'decay', 0.005, 0.25, 0.005);
  R('Difusión', 'diffuse', 0, 1, 0.01);
  R('Fuerza del campo', 'fieldStrength', 0, 1.5, 0.01);
  R('Frecuencia del campo', 'fieldFreq', 0.3, 3, 0.05);
  R('Velocidad ondulante', 'velWobble', 0, 1, 0.01);

  const lookGroup = group(panel, 'Color');
  const L = (label, key, min, max, step) =>
    refreshers.push(rangeRow(lookGroup, label, params, params.targets, key, min, max, step));
  L('Exposición', 'exposure', 0.3, 4, 0.05);
  L('Bandas (relieve)', 'bandAmount', 0, 1, 0.01);
  L('Frecuencia bandas', 'bandFreq', 1, 20, 0.5);
  L('Brillo alto', 'glow', 0, 1.5, 0.01);
  refreshers.push(rangeRow(lookGroup, 'Velocidad tiempo', params, null, 'timeScale', 0, 2, 0.01));

  // --- Acciones ---
  const actions = group(panel, 'Acciones');
  button(actions, 'Reset', onReset);
  button(actions, 'Pausar visuales', () => onPauseChange());
  button(actions, 'LAB / PERFORMANCE', () => onModeChange());

  document.body.append(panel);

  const formatTime = (time) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60)
      .toString()
      .padStart(2, '0');
    return `${mins}:${secs}`;
  };

  return {
    element: panel,
    setVisible(visible) {
      panel.classList.toggle('hidden', !visible);
    },
    refresh() {
      for (const item of refreshers) item.refresh();
    },
    setActivePreset(index) {
      presetButtons.forEach((b, i) => {
        b.style.background = i === index ? '#a600ff' : '';
        b.style.color = i === index ? '#fff' : '';
      });
    },
    updateAudioTime(curr, total) {
      if (!isDragging && total > 0) {
        progressSlider.value = (curr / total) * 100;
        progressLabel.textContent = `${formatTime(curr)} / ${formatTime(total)}`;
      }
    }
  };
}