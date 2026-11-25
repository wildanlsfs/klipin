// Live controller + world-space WebGL shader for the natural-draft clay furnace.
// Inlined after kitScript() and glScript(), so smooth, burst and settle come from the outer module scope.

const D = __DATA__;
const root = document.querySelector(".cf");
const stage = root.querySelector(".cf-stage");
const backSvg = stage.querySelector(".cf-back");
const frontSvg = stage.querySelector(".cf-front");
const damperEl = frontSvg.querySelector('[data-part="damper"]');
const gaugeEl = backSvg.querySelector('[data-part="gauge"]');
const fbBed = backSvg.querySelector('[data-part="fb-bed"]');
const fbFlame = backSvg.querySelector('[data-part="fb-flame"]');
const fbCore = backSvg.querySelector('[data-part="fb-core"]');
const fbAir = frontSvg.querySelector('[data-part="fb-air"]');
const readout = root.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const LIGHT = root.closest("[data-theme]")?.getAttribute("data-theme") !== "dark" ? 1 : 0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const FRAGMENT = `
uniform float uLight;
uniform float uHeat;
uniform float uDraft;
uniform float uFirst;

const float ZF = ${D.zFloor.toFixed(1)};
const float SH = ${D.shaftHeight.toFixed(1)};
const float ZTOP = ${D.zTop.toFixed(1)};
const float RIB = ${D.rInBase.toFixed(1)};
const float RIT = ${D.rInTop.toFixed(1)};
const float ROB = ${D.rOutBase.toFixed(1)};
const float ROT = ${D.rOutTop.toFixed(1)};
const float TZ = ${D.tuyereZ.toFixed(1)};
const float TR = ${D.tuyereR.toFixed(1)};
const float CUT0 = ${(D.cutStartDeg * Math.PI / 180).toFixed(5)};
const float CUT1 = ${(D.cutEndDeg * Math.PI / 180).toFixed(5)};

float rInAt(float z) {
  float t = clamp((z - ZF) / SH, 0., 1.);
  return mix(RIB, RIT, pow(t, .92));
}

float rOutAt(float z) {
  float t = clamp((z - ZF) / SH, 0., 1.);
  return mix(ROB, ROT, pow(t, .88));
}

// Blackbody thermal table: dull cherry -> orange -> yellow -> cream core (480..1210 C).
vec3 blackbody(float e) {
  vec3 c0 = vec3(.46, .09, .05);
  vec3 c1 = vec3(.68, .12, .04);
  vec3 c2 = vec3(.95, .39, .06);
  vec3 c3 = vec3(1.0, .77, .15);
  vec3 c4 = vec3(1.0, .95, .82);
  vec3 col = mix(c0, c1, smoothstep(0., .25, e));
  col = mix(col, c2, smoothstep(.25, .52, e));
  col = mix(col, c3, smoothstep(.52, .80, e));
  col = mix(col, c4, smoothstep(.80, 1.0, e));
  return col;
}

vec4 inkFor(vec3 seen, float cover) {
  vec3 absorbed = clamp(1. - seen, 0., 1.);
  float a = clamp(max(max(absorbed.r, max(absorbed.g, absorbed.b)), cover), 0., 1.);
  return vec4(clamp(vec3(a) - absorbed, 0., a), a);
}

vec4 overInk(vec4 top, vec4 under) {
  return top + under * (1. - top.a);
}

float tonemap1(float c, float exposure) {
  return 1. - exp(-c * exposure);
}

// True if point lies inside the carved cutaway cone or above the chimney crown.
float inOpenShaft(vec3 p) {
  float r = length(p.xy);
  float rIn = rInAt(p.z);
  float aboveTop = smoothstep(ZTOP - 1.5, ZTOP + 1.5, p.z);
  float insideR = 1. - smoothstep(rIn - .8, rIn + .8, r);
  float ang = atan(p.y, p.x);
  float inCut = smoothstep(CUT0 - .08, CUT0 + .08, ang) * (1. - smoothstep(CUT1 - .08, CUT1 + .08, ang));
  return max(aboveTop, max(insideR, inCut * smoothstep(ZF, ZF + 2., p.z)));
}

void main() {
  vec2 vb = viewOf(gl_FragCoord.xy);
  float px = pixelOf();
  // Window smoothly to strictly 0 inside the outer 12 viewBox px so edges never clip.
  float edgeX = smoothstep(4., 16., vb.x) * (1. - smoothstep(uView.x - 16., uView.x - 4., vb.x));
  float edgeY = smoothstep(4., 16., vb.y) * (1. - smoothstep(uView.y - 16., uView.y - 4., vb.y));
  float bounds = edgeX * edgeY;
  if (bounds < .002 || uFirst < .002) {
    gl_FragColor = vec4(0.);
    return;
  }

  vec3 o = rayOf(vb);
  vec3 V = towardViewer();

  // March through the furnace core box + above-chimney plume volume.
  float tStart = -85.;
  float tEnd = 85.;
  const int STEPS = 28;
  float dt = (tEnd - tStart) / float(STEPS);
  float dither = hash12(gl_FragCoord.xy + fract(uTime * .43) * 37.);

  float coalE = 0.;
  float flameE = 0.;
  float washE = 0.;
  float airE = 0.;
  float sparkE = 0.;
  float sparkCool = 0.;

  for (int i = 0; i < STEPS; i++) {
    float t = tStart + (float(i) + dither) * dt;
    vec3 p = o + t * V;

    // Occlude behind the earthen hearth floor and shaft outer rear wall.
    if (p.z < ZF - .4) continue;
    float r = length(p.xy);

    // 1. Cool ambient air draft entering tuyere tunnel (x = 20..88, y near 0, z near TZ).
    if (p.x > 18. && p.x < 90. && abs(p.y) < 11. && abs(p.z - TZ) < 10.5) {
      float radT = length(vec2(p.y, p.z - TZ));
      float rGate = 1. - smoothstep(TR * .32, TR * 1.18, radT);
      float xGate = smoothstep(18., 25., p.x) * (1. - smoothstep(66., 88., p.x));
      float flowPhase = p.x * .36 + uTime * (5. + uDraft * 7.5);
      float stream = .5 + .5 * sin(flowPhase + p.y * 1.1) * cos(p.x * .18 + uTime * 2.2 + (p.z - TZ) * .7);
      float rib = .38 + .62 * pow(clamp(stream, 0., 1.), 1.3);
      airE += rGate * xGate * rib * uDraft * dt * .095;
    }

    // Stop gas/flame cleanly outside chimney silhouette or outer plume envelope.
    float rLim = rInAt(min(p.z, ZTOP));
    float rShaft = rLim + max(0., p.z - ZTOP) * .28;
    if (p.z < ZTOP && r > rLim + 1.1) continue;
    if (p.z >= ZTOP && r > rShaft * 1.9) continue;

    // 2. Glowing lump charcoal combustion bed (z = 6..36).
    if (p.z >= ZF && p.z <= 40. && r < RIB + .6) {
      float zGate = smoothstep(ZF, ZF + 2.5, p.z) * (1. - smoothstep(23. + uHeat * 11., 34. + uHeat * 12., p.z));
      float rGate = 1. - smoothstep(rLim * .74, rLim * 1.01, r);
      // Hottest focal zone right where the tuyere blast meets the charcoal from +x.
      float tuyereFocus = exp(-length(p - vec3(9.5, 0., TZ + 1.5)) / 14.5);
      float lumps = .42 + .58 * fbm3(p * .21 + vec3(0., 0., -uTime * .14));
      float bed = zGate * rGate * lumps * (.28 + .72 * uHeat) * (.65 + .95 * tuyereFocus);
      coalE += bed * dt * .062;
    }

    // 3. Natural-draft flame tongue & hot updraft column (z = 14..148).
    if (p.z >= 13. && p.z <= ZTOP + 34.) {
      float zFadeTop = 1. - smoothstep(82. + uHeat * 36., 116. + uHeat * 34., p.z);
      float zFadeBot = smoothstep(13., 24., p.z);
      float swirl = fbm3(vec3(p.x * .12, p.y * .12, p.z * .085 - uTime * (2.6 + uDraft * 3.1)));
      float radiusScale = mix(.78, .54, smoothstep(ZF, ZTOP + 22., p.z)) * (1. - .26 * swirl);
      float rCore = max(2.2, rShaft * radiusScale);
      float plumeShape = exp(-pow(r / rCore, 1.85)) * (1. - smoothstep(rShaft * 1.2, rShaft * 1.85, r));
      // Axis-weighted profile so light theme stays solid with a hot core rather than hollow edges.
      float axisBoost = mix(1.0, 1.38 - .55 * smoothstep(0., rShaft, r), uLight);
      float fl = zFadeBot * zFadeTop * plumeShape * axisBoost * (0.22 + 0.92 * uHeat) * (0.62 + 0.52 * swirl);
      flameE += fl * dt * .046;

      // 4. Soft radiant glow wash strictly inside the refractory shaft cavity.
      float inCavity = smoothstep(rLim * .3, rLim * .92, r) * (1. - smoothstep(rLim * .95, rLim * 1.12, r));
      float wallMask = inCavity * (1. - smoothstep(ZTOP - 6., ZTOP + 2., p.z));
      washE += wallMask * zFadeBot * (.25 + .75 * uHeat) * dt * .028;
    }

    // 5. Rising ember sparks carried up by the chimney draft.
    if (p.z >= 26. && p.z <= ZTOP + 38. && r < rShaft * .9) {
      vec3 sp = vec3(p.x * .28, p.y * .28, p.z * .11 - uTime * (2.2 + uDraft * 2.4));
      vec3 cell = floor(sp);
      vec3 f = fract(sp) - .5;
      float h = hash13(cell);
      if (h > .76) {
        vec3 off = vec3(hash13(cell + 7.1) - .5, hash13(cell + 13.7) - .5, hash13(cell + 23.3) - .5) * .36;
        float dist = length(vec2(f.x - off.x, f.y - off.y) * 3.5);
        float zTail = smoothstep(.42, -.38, f.z - off.z) * (1. - smoothstep(.35, .48, abs(f.z - off.z)));
        float ember = smoothstep(.75, .14, dist) * zTail * uHeat * (1. - smoothstep(ZTOP - 6., ZTOP + 36., p.z));
        sparkE += ember * dt * .085;
        sparkCool += (1. - zTail) * ember * dt * .05;
      }
    }
  }

  float coalT = tonemap1(coalE, 1.35);
  float flameT = tonemap1(flameE, 1.28);
  float airT = tonemap1(airE, 1.25);
  float sparkT = tonemap1(sparkE, 1.65);

  // Dark theme: additive screen glow; Light theme: solved paper ink per layer.
  float eHot = max(coalT, flameT * .92);
  float heatMix = clamp(eHot * (0.35 + 0.65 * uHeat), 0., 1.);
  vec3 hotCol = blackbody(heatMix);

  vec4 darkCol = vec4(0.);
  vec3 dRgb = hotCol * (coalT * .95 + flameT * 1.1)
    + vec3(.32, .62, .96) * airT * .68
    + vec3(1.0, .62, .20) * sparkT * .95
    + vec3(1.0, .42, .10) * tonemap1(washE, 1.0) * .28;
  dRgb = tonemap(dRgb, 1.2);
  float dA = max(dRgb.r, max(dRgb.g, dRgb.b));
  darkCol = vec4(dRgb, dA);

  // Light theme stacked paper inks (back to front): cavity wash -> air stream -> hot emission -> sparks.
  float washA = clamp(.28 * tonemap1(washE, 1.15) * uHeat, 0., .34);
  vec4 washInk = vec4(vec3(.88, .36, .10) * washA, washA);

  float airStr = clamp(airT * 1.35, 0., 1.);
  vec3 airPaper = mix(vec3(1.), vec3(.14, .46, .88), airStr);
  vec4 airInk = inkFor(airPaper, clamp(airStr * .28, 0., .3)) * smoothstep(.02, .24, airStr);

  float fireM = clamp(max(coalT * 1.08, flameT * 1.04), 0., 1.);
  // Saturated orange-gold body + pale cream core only at peak temperature (> ~1,000 C), weighted cleanly.
  vec3 firePaper = mix(vec3(1.), blackbody(clamp(fireM * (.38 + .62 * uHeat), 0., 1.)), smoothstep(.04, .58, fireM));
  float paleCover = .88 * smoothstep(.52, .92, fireM * uHeat);
  vec4 fireInk = inkFor(firePaper, paleCover) * smoothstep(.01, .16, fireM);

  // Sparks drown softly over hotter body core and stay saturated red-orange on white paper.
  float spMask = clamp(sparkT * (1. - .68 * paleCover), 0., 1.);
  vec3 spCol = mix(vec3(.96, .42, .06), vec3(.58, .12, .03), clamp(sparkCool * 4., 0., 1.));
  vec4 spInk = vec4(spCol * spMask * .9, spMask * .9);

  vec4 lightCol = overInk(spInk, overInk(fireInk, overInk(airInk, washInk)));

  vec4 outCol = mix(darkCol, lightCol, uLight) * bounds * uFirst;
  outCol.rgb = min(outCol.rgb, vec3(outCol.a));

  // ±1 LSB triangular output dither gated away from transparent canvas pixels.
  float m = max(outCol.a, max(outCol.r, max(outCol.g, outCol.b)));
  float n = (hash12(gl_FragCoord.xy + fract(uTime * .61) * 91.) + hash12(gl_FragCoord.yx * 1.37 + fract(uTime * .37) * 57.) - 1.) / 255.;
  outCol = max(outCol + n * smoothstep(0., 1.5 / 255., m), 0.);
  outCol.rgb = min(outCol.rgb, vec3(outCol.a));

  gl_FragColor = outCol;
}
`;

const canvas = stage.querySelector(".cf-gl");
const layer = glLayer({
  canvas,
  fragment: FRAGMENT,
  view: [D.W, D.H],
  camera: D.camera,
  uniforms: ["uHeat", "uDraft", "uFirst"],
  fixed: { uLight: LIGHT },
});
if (layer) stage.setAttribute("data-gl", "");

const stops = [0.15, 0.52, 1.0, 0.25];
let target = still.matches ? 0.85 : stops[0];
let damper = target;
let first = still.matches ? 1 : 0;
let clock = 0;
let tourClock = 0;
let last = 0;
let frame = 0;
let touring = !still.matches;
let visible = false;
let idleTimer = 0;

function blackbodyRgb(tempC) {
  const s = D.stops;
  const t = clamp(tempC, s[0].temp, s[s.length - 1].temp);
  for (let i = 0; i < s.length - 1; i++) {
    if (t <= s[i + 1].temp) {
      const u = (t - s[i].temp) / (s[i + 1].temp - s[i].temp);
      return [0, 1, 2].map((k) => Math.round((s[i].rgb[k] + (s[i + 1].rgb[k] - s[i].rgb[k]) * u) * 255));
    }
  }
  return [255, 240, 204];
}

function modelOf(d) {
  const heat = Math.pow(d, 0.74);
  const tempC = 480 + 730 * heat;
  const tAvgK = tempC * 0.62 + 273.15;
  const draftPa = 1.6 + 6.9 * Math.max(0, 1 - 298.15 / tAvgK) * (0.28 + 0.72 * d);
  const velocityMs = 0.25 + 2.95 * Math.sqrt(Math.max(0, (draftPa - 1.6) / 6.8)) * (0.2 + 0.8 * d);
  return { d, heat, tempC, draftPa, velocityMs };
}

function paintSvg(m) {
  // Damper opens toward -y so the tuyere mouth and blast core stay unobstructed.
  damperEl.setAttribute("transform", translateAlong(D.P, [0, -m.d * D.damperTravel, 0]));
  const gaugeZ = D.gaugeBottom + m.heat * D.gaugeTravel;
  gaugeEl.setAttribute("transform", translateAlong(D.P, [0, 0, gaugeZ]));

  root.style.setProperty("--cf-glow", `${Math.round(m.heat * 100)}%`);
  if (!layer) {
    const [r, g, b] = blackbodyRgb(m.tempC);
    const col = `rgb(${r},${g},${b})`;
    if (fbBed) fbBed.style.fill = col;
    if (fbFlame) fbFlame.style.fill = col;
    if (fbFlame) fbFlame.style.opacity = (0.35 + 0.6 * m.heat).toFixed(2);
    if (fbCore) fbCore.style.opacity = (0.18 + 0.75 * m.heat).toFixed(2);
    if (fbAir) fbAir.style.opacity = (0.15 + 0.82 * m.d).toFixed(2);
  }

  const text = `damper ${Math.round(m.d * 100)}% · ${Math.round(m.tempC).toLocaleString("en-US")} °C · ${m.draftPa.toFixed(1)} Pa · ${m.velocityMs.toFixed(1)} m/s`;
  if (readout.textContent !== text) readout.textContent = text;
  stage.setAttribute("aria-valuenow", String(Math.round(m.d * 100)));
  stage.setAttribute("aria-valuetext", text);
}

function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  const calm = still.matches;

  if (!calm) {
    clock += dt;
    if (touring) {
      tourClock += dt;
      target = stops[Math.floor(tourClock / 2.6) % stops.length];
    }
    first = Math.min(1, first + dt / 0.85);
    damper += (target - damper) * (1 - Math.exp(-dt / 0.32));
    if (Math.abs(target - damper) < 0.002) damper = target;
  } else {
    first = 1;
    damper = target;
  }

  const m = modelOf(damper);
  paintSvg(m);
  if (layer) {
    layer.draw({
      uHeat: 0.14 + 0.86 * m.heat,
      uDraft: 0.1 + 0.9 * m.d,
      uFirst: smooth(0, 1, first),
    }, calm ? 0.8 : clock);
  }

  const keepGoing = visible && (!calm && (touring || Math.abs(target - damper) > 0.002 || first < 1 || (layer && m.d > 0.01)));
  frame = keepGoing ? requestAnimationFrame(tick) : 0;
}

const run = () => {
  if (!frame && visible) {
    last = 0;
    frame = requestAnimationFrame(tick);
  }
};

const steer = (next) => {
  touring = false;
  target = clamp(next, 0, 1);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    touring = !still.matches;
    tourClock = 0;
    run();
  }, 3600);
  run();
};

new IntersectionObserver((entries) => {
  visible = entries[entries.length - 1].isIntersecting;
  if (visible) run();
}, { rootMargin: "120px 0px" }).observe(stage);

stage.addEventListener("pointermove", (event) => {
  const box = backSvg.getBoundingClientRect();
  const share = clamp(((event.clientX - box.left) / box.width - 0.18) / 0.64, 0, 1);
  steer(share);
});

stage.addEventListener("keydown", (event) => {
  let next = null;
  if (event.key === "ArrowRight" || event.key === "ArrowUp") next = clamp(target + 0.15, 0, 1);
  else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = clamp(target - 0.15, 0, 1);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = 1;
  else if (event.key === " ") next = target > 0.5 ? 0.15 : 1;
  if (next === null) return;
  event.preventDefault();
  steer(next);
});

paintSvg(modelOf(damper));
