// Pure thermal and geometric model for the natural-draft clay furnace.
// Shared between build.mjs (static SVG + metadata) and live.js (browser animation + shader uniforms).

export const FURNACE = {
  shaftHeight: 112,
  zFloor: 6,
  zTop: 118,
  rOutBase: 34,
  rOutTop: 21,
  rInBase: 20,
  rInTop: 12.5,
  tuyereZ: 15,
  tuyereR: 4.8,
  damperTravel: 24,
  cutStartDeg: 22,
  cutEndDeg: 112,
  seamLeftDeg: 135,
  seamRightDeg: 315,
};

export function rOutAt(z) {
  const t = Math.max(0, Math.min(1, (z - FURNACE.zFloor) / FURNACE.shaftHeight));
  // Slight bell taper typical of hand-coiled clay shaft furnaces.
  return FURNACE.rOutBase - (FURNACE.rOutBase - FURNACE.rOutTop) * Math.pow(t, 0.88);
}

export function rInAt(z) {
  const t = Math.max(0, Math.min(1, (z - FURNACE.zFloor) / FURNACE.shaftHeight));
  return FURNACE.rInBase - (FURNACE.rInBase - FURNACE.rInTop) * Math.pow(t, 0.92);
}

// Physical blackbody ramp from 480°C to 1,210°C (dull red -> orange -> yellow -> cream core).
// Matches GLSL ink stops so --no-webgl fallback and WebGL shader agree on every hue.
export const BLACKBODY_STOPS = [
  { temp: 480, rgb: [0.46, 0.09, 0.05] },
  { temp: 680, rgb: [0.66, 0.11, 0.04] },
  { temp: 850, rgb: [0.93, 0.36, 0.05] },
  { temp: 1050, rgb: [1.0, 0.76, 0.14] },
  { temp: 1210, rgb: [1.0, 0.94, 0.8] },
];

export function furnaceState(damper) {
  const d = Math.max(0, Math.min(1, Number(damper) || 0));
  // Non-linear oxygen response: opening the tuyere intake rapidly accelerates charcoal combustion.
  const heat = Math.pow(d, 0.74);
  const tempC = 480 + 730 * heat;
  // Stack effect: dp = rho0 * g * H * (1 - T_amb / T_avg), H = 1.45 m scale equivalent.
  const tAmbK = 298.15;
  const tAvgK = (tempC * 0.62 + 273.15);
  const draftPa = 1.6 + 6.9 * Math.max(0, 1 - tAmbK / tAvgK) * (0.28 + 0.72 * d);
  const velocityMs = 0.25 + 2.95 * Math.sqrt(Math.max(0, (draftPa - 1.6) / 6.8)) * (0.2 + 0.8 * d);

  let phase = "smoldering";
  if (tempC >= 1100) phase = "smelting blast";
  else if (tempC >= 860) phase = "yellow heat";
  else if (tempC >= 660) phase = "red forge";

  return { damper: d, heat, tempC, draftPa, velocityMs, phase };
}

export function blackbodyCss(tempC) {
  const t = Math.max(BLACKBODY_STOPS[0].temp, Math.min(BLACKBODY_STOPS[BLACKBODY_STOPS.length - 1].temp, tempC));
  for (let i = 0; i < BLACKBODY_STOPS.length - 1; i++) {
    const a = BLACKBODY_STOPS[i];
    const b = BLACKBODY_STOPS[i + 1];
    if (t <= b.temp) {
      const u = (t - a.temp) / (b.temp - a.temp);
      const r = Math.round((a.rgb[0] + (b.rgb[0] - a.rgb[0]) * u) * 255);
      const g = Math.round((a.rgb[1] + (b.rgb[1] - a.rgb[1]) * u) * 255);
      const bl = Math.round((a.rgb[2] + (b.rgb[2] - a.rgb[2]) * u) * 255);
      return `rgb(${r}, ${g}, ${bl})`;
    }
  }
  return "rgb(255, 240, 204)";
}
