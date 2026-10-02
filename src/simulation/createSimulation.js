import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  atan,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  instancedArray,
  length,
  max,
  min,
  mix,
  mod,
  oneMinus,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  uint,
  uv,
  vec2,
  vec3,
  vec4
} from 'three/tsl';

const TAU = Math.PI * 2;

/**
 * Physarum (Jeff Jones) + multi-especie (Sage Jenson) sobre un mapa de rastro.
 *
 *  agentes:  sentir (3 sensores) → girar → avanzar → depositar
 *  mapa:     difusión (blur 3x3) + decaimiento
 *  extra:    campo de flujo por preset, pulsos de onda, pincel del puntero
 *
 * Buffers:
 *  agents     vec4  (x, y, ángulo, especie)
 *  trail      vec4  (rastro especie 0, 1, 2, -)   ← los agentes leen y depositan aquí
 *  trailNext  vec4  resultado de difundir/decaer; es lo que se dibuja
 */
export function createSimulation({
  renderer,
  scene,
  params,
  count = 262144,
  gridWidth = 1280,
  gridHeight = 720
}) {
  const W = gridWidth;
  const H = gridHeight;
  const CELLS = W * H;
  const uW = uint(W);
  const uH = uint(H);

  const agents = instancedArray(count, 'vec4');
  const trail = instancedArray(CELLS, 'vec4');
  const trailNext = instancedArray(CELLS, 'vec4');

  // ---------- helpers ----------

  // índice de celda con wrap toroidal
  const cellIndex = (x, y) => {
    const ix = min(uint(floor(mod(x, float(W)))), uint(W - 1));
    const iy = min(uint(floor(mod(y, float(H)))), uint(H - 1));
    return iy.mul(uW).add(ix);
  };

  const norm2 = (v) => v.div(max(length(v), 0.00001));

  const rot2 = (v, a) =>
    vec2(
      v.x.mul(cos(a)).sub(v.y.mul(sin(a))),
      v.x.mul(sin(a)).add(v.y.mul(cos(a)))
    );

  // Campo de flujo: dirección "deseada" en (px, py). Mezcla de 4 campos pesados
  // por params.fieldWeights, así la transición entre presets es continua.
  const fieldVector = (px, py) => {
    const cx = px.sub(W * 0.5).div(H);
    const cy = py.sub(H * 0.5).div(H);
    const r = max(sqrt(cx.mul(cx).add(cy.mul(cy))), 0.0001);
    const radial = vec2(cx.div(r), cy.div(r));
    const tangent = vec2(cy.div(r).negate(), cx.div(r));

    const w = params.fieldWeights;
    const f = params.fieldFreq;
    const ph = params.phase;

    // Ondas horizontales, espejadas respecto al horizonte
    const sgn = select(cy.greaterThanEqual(0.0), 1.0, -1.0);
    const wy = cos(cx.mul(f.mul(9.0)).add(ph.mul(1.3)).add(abs(cy).mul(6.0)))
      .mul(0.6)
      .mul(sgn);
    const waves = norm2(vec2(1.0, wy));

    // Curvas de nivel de un potencial suave (los agentes siguen el contorno)
    const pot = (x, y) => {
      const a = sin(x.mul(f.mul(6.0)).add(sin(y.mul(f.mul(4.6)).add(ph.mul(0.6))).mul(1.7)));
      const b = cos(y.mul(f.mul(6.2)).sub(sin(x.mul(f.mul(3.8)).sub(ph.mul(0.4))).mul(2.0)));
      const c = sin(x.add(y).mul(f.mul(9.0)).add(ph)).mul(0.4);
      return a.add(b).add(c);
    };
    const e = 0.01;
    const gx = pot(cx.add(e), cy).sub(pot(cx.sub(e), cy));
    const gy = pot(cx, cy.add(e)).sub(pot(cx, cy.sub(e)));
    const contour = norm2(vec2(gy.negate(), gx));

    // Anillos + radial, girables con la tecla A y con los medios
    const twist = params.keyboardRotation.add(params.audioMid.mul(0.65));
    const swirl = radial
      .mul(w.y)
      .add(tangent.mul(w.x.add(params.keyboardWarp.mul(2.0))));
    const rt = rot2(swirl, twist);

    const fv = rt.add(waves.mul(w.z)).add(contour.mul(w.w));
    return { fv, radial, r };
  };

  // ---------- init ----------

  const initAgents = Fn(() => {
    const i = instanceIndex;
    const a = agents.element(i);
    const r1 = hash(i);
    const r2 = hash(i.add(uint(count + 1)));
    const r3 = hash(i.add(uint(count * 2 + 3)));
    a.assign(vec4(r1.mul(W), r2.mul(H), r3.mul(TAU), float(i.mod(uint(3)))));
  })()
    .compute(count)
    .setName('Init Agents');

  const initTrail = Fn(() => {
    trail.element(instanceIndex).assign(vec4(0.0));
    trailNext.element(instanceIndex).assign(vec4(0.0));
  })()
    .compute(CELLS)
    .setName('Init Trail');

  // ---------- agentes ----------

  const updateAgents = Fn(() => {
    const a = agents.element(instanceIndex);
    const px = a.x.toVar();
    const py = a.y.toVar();
    const ang = a.z.toVar();
    const sp = a.w;

    // Dos números aleatorios por agente y por paso
    const seed = uint(params.frame)
      .mul(uint(count * 2))
      .add(instanceIndex.mul(uint(2)));
    const r1 = hash(seed);
    const r2 = hash(seed.add(uint(1)));

    // Máscara de especie (1,0,0) / (0,1,0) / (0,0,1)
    const m0 = oneMinus(step(0.5, sp));
    const m1 = step(0.5, sp).mul(oneMinus(step(1.5, sp)));
    const m2 = step(1.5, sp);
    const mask = vec3(m0, m1, m2);

    // Qué rastros atraen o repelen a esta especie
    const attract = params.attract0
      .mul(m0)
      .add(params.attract1.mul(m1))
      .add(params.attract2.mul(m2));
    const sd = params.sensorDist.mul(dot(params.speciesSensor, mask));
    const stepMul = dot(params.speciesStep, mask);
    const sa = params.sensorAngle.add(params.audioMid.mul(0.35));
    const ra = params.rotateAngle;

    // --- sentir ---
    const sense = (offset) => {
      const aa = ang.add(offset);
      const sx = px.add(cos(aa).mul(sd));
      const sy = py.add(sin(aa).mul(sd));
      const t = trail.element(cellIndex(sx, sy));
      return dot(t.xyz, attract);
    };
    const F = sense(0.0).toVar();
    const FL = sense(sa).toVar();
    const FR = sense(sa.negate()).toVar();

    // --- girar (reglas de Jones) ---
    const ahead = F.greaterThan(FL).and(F.greaterThan(FR));
    const bothLow = F.lessThan(FL).and(F.lessThan(FR));
    const randTurn = select(r1.lessThan(0.5), ra, ra.negate());
    const sideTurn = select(FL.greaterThan(FR), ra, select(FR.greaterThan(FL), ra.negate(), 0.0));
    const turn = select(ahead, 0.0, select(bothLow, randTurn, sideTurn)).toVar();
    ang.addAssign(turn);

    // --- caos (tecla W, transición de preset, golpes de bajo) ---
    const chaos = params.keyboardChaos
      .mul(1.1)
      .add(params.transitionBurst.mul(0.9))
      .add(params.audioBass.mul(0.09));
    ang.addAssign(r2.sub(0.5).mul(2.0).mul(chaos));

    // --- serpenteo lateral: las líneas "bailan" con el bombo y la voz ---
    const swing = sin(px.mul(0.021).add(py.mul(0.016)).add(params.phase.mul(3.0))).mul(
      params.beat.mul(0.2).add(params.snap.mul(0.12))
    );
    ang.addAssign(swing);

    // --- seguir el campo de flujo (como eje: vale en ambos sentidos) ---
    const field = fieldVector(px, py);
    const h = vec2(cos(ang), sin(ang)).toVar();
    const align = select(dot(h, field.fv).greaterThanEqual(0.0), 1.0, -1.0);
    const strength = params.fieldStrength.mul(float(1.0).add(params.songEnergy.mul(1.1)));
    const inVoid = step(field.r, params.voidRadius); // 1 si está dentro del "vacío" central

    // Onda expansiva: al golpe del bombo, el anillo empuja físicamente las líneas hacia afuera
    const rw = field.r.sub(params.pulseRadius).div(0.07);
    const ringPush = exp(rw.mul(rw).negate())
      .mul(params.pulseAmp)
      .mul(clamp(params.songEnergy.mul(4.0), 0.0, 1.0));

    const steered = h
      .add(field.fv.mul(align).mul(strength))
      .add(field.radial.mul(inVoid).mul(1.5))
      .add(field.radial.mul(ringPush).mul(1.2))
      .toVar();
    ang.assign(mod(atan(steered.y, steered.x), float(TAU)));

    // --- avanzar (velocidad que ondula: "weird velocity") ---
    const wobble = sin(params.phase.mul(2.0).add(px.mul(0.017)).sub(py.mul(0.013)))
      .mul(0.5)
      .add(cos(px.mul(0.009).add(py.mul(0.021)).sub(params.phase)).mul(0.5));
    // Cada zona reacciona a una parte del espectro: centro = graves, medio = medios, borde = agudos
    const zoneMid = smoothstep(0.08, 0.3, field.r);
    const zoneOut = smoothstep(0.28, 0.6, field.r);
    const bandLocal = mix(mix(params.audioBass, params.audioMid, zoneMid), params.audioHigh, zoneOut);

    const speed = params.stepSize
      .mul(stepMul)
      .mul(params.timeScale)
      .mul(params.tempo)
      .mul(
        float(1.0)
          .add(wobble.mul(params.velWobble))
          .add(params.audioBass.mul(1.0))
          .add(params.beat.mul(1.0))
          .add(bandLocal.mul(0.35))
          .add(ringPush.mul(0.5))
          .add(params.transitionBurst.mul(1.2))
      );
    const nx = mod(px.add(cos(ang).mul(speed)), float(W)).toVar();
    const ny = mod(py.add(sin(ang).mul(speed)), float(H)).toVar();

    // --- depositar en el canal de su especie ---
    const ncx = nx.sub(W * 0.5).div(H);
    const ncy = ny.sub(H * 0.5).div(H);
    const nr = sqrt(ncx.mul(ncx).add(ncy.mul(ncy)));
    const outside = step(params.voidRadius, nr);
    const core = mix(float(1.0), clamp(nr.div(0.12), 0.12, 1.0), params.coreSoft);
    const dep = params.deposit
      .mul(outside)
      .mul(core)
      .mul(float(1.0).add(params.audioBass.mul(1.0)).add(params.songEnergy.mul(0.45)));
    trail.element(cellIndex(nx, ny)).addAssign(vec4(mask.mul(dep), 0.0));

    a.assign(vec4(nx, ny, ang, sp));
  })()
    .compute(count)
    .setName('Update Agents');

  // ---------- difusión + decaimiento ----------

  const diffuseTrail = Fn(() => {
    const i = instanceIndex;
    const x = i.mod(uW);
    const y = i.div(uW);
    const xm = x.add(uint(W - 1)).mod(uW);
    const xp = x.add(uint(1)).mod(uW);
    const ym = y.add(uint(H - 1)).mod(uH);
    const yp = y.add(uint(1)).mod(uH);

    let sum = vec4(0.0);
    for (const ry of [ym, y, yp]) {
      for (const rx of [xm, x, xp]) {
        sum = sum.add(trail.element(ry.mul(uW).add(rx)));
      }
    }
    const avg = sum.div(9.0);

    const v = mix(trail.element(i), avg, params.diffuse).toVar();
    // Con audioTame, el decaimiento acompaña al depósito de la música: el rastro
    // se mueve más rápido pero no se acumula hasta quemar la imagen.
    const decayComp = float(1.0).add(
      params.audioTame.mul(0.85).mul(params.audioBass.add(params.songEnergy.mul(0.45)))
    );
    const decayEff = clamp(
      params.decay.mul(decayComp).add(params.transitionBurst.mul(0.06)),
      0.0,
      0.6
    );
    v.mulAssign(oneMinus(decayEff));

    const fx = float(x).add(0.5);
    const fy = float(y).add(0.5);

    // Pincel del puntero: comida (+) o repelente (-, con Espacio)
    const dx = fx.sub(params.pointer.x);
    const dy = fy.sub(params.pointer.y);
    const bd = sqrt(dx.mul(dx).add(dy.mul(dy)));
    const bf = clamp(oneMinus(bd.div(params.brushRadius)), 0.0, 1.0);
    v.addAssign(
      vec4(1.0, 1.0, 1.0, 0.0).mul(bf.mul(bf).mul(params.brushStrength).mul(params.brushSign))
    );

    // Pulso de onda expansiva (tecla S y golpes de bajo)
    const cx = fx.sub(W * 0.5).div(H);
    const cy = fy.sub(H * 0.5).div(H);
    const r = sqrt(cx.mul(cx).add(cy.mul(cy)));
    const rd = r.sub(params.pulseRadius).div(0.035);
    const ring = exp(rd.mul(rd).negate()).mul(params.pulseAmp);
    v.addAssign(vec4(0.6, 1.0, 0.4, 0.0).mul(ring).mul(mix(float(0.8), float(0.35), params.audioTame)));

    // Vacío central (pupila del iris, centro del túnel)
    v.mulAssign(
      smoothstep(params.voidRadius.mul(0.8), params.voidRadius.mul(1.1).add(0.0001), r)
    );

    v.assign(clamp(v, vec4(0.0), vec4(12.0)));
    trailNext.element(i).assign(v);
  })()
    .compute(CELLS)
    .setName('Diffuse Trail');

  const copyTrail = Fn(() => {
    trail.element(instanceIndex).assign(trailNext.element(instanceIndex));
  })()
    .compute(CELLS)
    .setName('Copy Trail');

  // ---------- render: pantalla completa con la paleta ----------

  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false
  });

  material.colorNode = Fn(() => {
    // Muestreo bilineal del mapa (suaviza el escalado a pantalla)
    const g = uv().mul(vec2(W, H)).sub(0.5);
    const x0 = floor(g.x);
    const y0 = floor(g.y);
    const fx = fract(g.x);
    const fy = fract(g.y);
    const rd = (xx, yy) => trailNext.element(cellIndex(xx, yy));
    const t = mix(
      mix(rd(x0, y0), rd(x0.add(1.0), y0), fx),
      mix(rd(x0, y0.add(1.0)), rd(x0.add(1.0), y0.add(1.0)), fx),
      fy
    );

    const expo = params.exposure.div(
      float(1.0).add(
        params.audioTame.mul(params.songEnergy.mul(0.5).add(params.audioBass.mul(0.3)))
      )
    );
    const tone = (v) => oneMinus(exp(v.mul(expo).negate()));
    const tMain = tone(t.x);
    const tA = tone(t.y);
    const tB = tone(t.z);
    const s = clamp(tMain.add(tA.mul(0.55)).add(tB.mul(0.55)), 0.0, 1.0);

    // Degradado de 4 tonos + acentos por especie
    const g1 = smoothstep(0.02, 0.4, s);
    const g2 = smoothstep(0.3, 0.72, s);
    const g3 = smoothstep(0.62, 1.0, s);
    const col = mix(params.colBg, params.colLow, g1).toVar();
    col.assign(mix(col, params.colMid, g2));
    const glowRaw = params.glow.add(params.audioHigh.mul(0.7));
    const glowEff = mix(glowRaw, min(glowRaw, 1.0), params.audioTame);
    col.assign(mix(col, params.colHigh, g3.mul(glowEff)));
    col.addAssign(params.colAccent.mul(tA).mul(0.75));
    col.addAssign(params.colAccent2.mul(tB).mul(0.6));

    // Bandas de contorno (efecto "relieve" de las referencias)
    const stripes = sin(s.mul(params.bandFreq).mul(TAU).add(params.phase.mul(0.35)))
      .mul(0.5)
      .add(0.5);
    const shaped = smoothstep(0.12, 0.88, stripes);
    const bandMask = smoothstep(0.02, 0.3, s).mul(params.bandAmount);
    col.mulAssign(mix(1.0, mix(0.3, 1.3, shaped), bandMask));

    // Golpe de bajo + viñeta
    const lift = float(1.0).add(
      params.audioBass
        .mul(mix(float(0.45), oneMinus(g3).mul(0.18), params.audioTame))
        .add(params.beat.mul(mix(float(0.3), oneMinus(g3).mul(0.1), params.audioTame)))
    );
    col.mulAssign(lift);
    const d = length(uv().sub(0.5));
    col.mulAssign(oneMinus(smoothstep(0.35, 1.0, d).mul(0.55)));

    return vec4(col, 1.0);
  })();

  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // ---------- API ----------

  function reset() {
    renderer.compute(initTrail);
    renderer.compute(initAgents);
  }

  function stepSimulation() {
    params.tick();
    renderer.compute(updateAgents);
    renderer.compute(diffuseTrail);
    renderer.compute(copyTrail);
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    scene.remove(mesh);
  }

  return { count, gridWidth: W, gridHeight: H, reset, stepSimulation, dispose };
}