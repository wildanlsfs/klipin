import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "/Users/user/.agents/skills/anatomy/kit/iso-kit.mjs";
import { glCamera } from "/Users/user/.agents/skills/anatomy/kit/gl.mjs";
import { kitScript, glScript } from "/Users/user/.agents/skills/anatomy/scripts/inline-kit.mjs";
import { FURNACE, rOutAt, rInAt, BLACKBODY_STOPS, furnaceState } from "./model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";
const CSS = readFileSync(join(HERE, "furnace.css"), "utf8");
const LIVE = readFileSync(join(HERE, "live.js"), "utf8");

const WIDTH = 640;
const HEIGHT = 440;

const PLATE = { x: -136, y: -88, w: 272, d: 176, r: 8 };
const PLATE_H = 12;
const FOOT_H = 5;
const HEARTH_R = 52;
const HEARTH_H = FURNACE.zFloor;

const TUYERE_X0 = 21;
const TUYERE_X1 = 55;
const DAMPER_X = 58.5;
const RAIL_Y0 = -36;
const RAIL_Y1 = 16;

const PYRO_X = -96;
const PYRO_Y = 0;
const GAUGE_BOTTOM = 18;
const GAUGE_TOP = 92;

const P = k.fitProjection(
  [
    ...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
    [0, 0, FURNACE.zTop + 36],
    [PYRO_X - 18, PYRO_Y, 108],
    [126, -78, 20],
  ],
  WIDTH,
  HEIGHT,
  { pad: 26, azimuth: 44, elevation: 30 },
);

const at = (p) => k.iso(p, P);
const S = (paths, opts) => k.solidSvg(paths, opts);
const L = (d, opts) => k.lineSvg(d, opts);
const D = (pts, opts) => k.dotsSvg(pts, opts);
const byDepth = (pts, z = 0) => [...pts].sort((a, b) => k.depthOf([a[0], a[1], z], P) - k.depthOf([b[0], b[1], z], P));
const RAD = Math.PI / 180;

// Counter-clockwise closed annular sector in XY so k.extrude computes outward normals cleanly.
function arcRing(a0Deg, a1Deg, rIn0, rOut0, steps = 16) {
  const outer = [];
  const inner = [];
  for (let i = 0; i <= steps; i++) {
    const a = (a0Deg + ((a1Deg - a0Deg) * i) / steps) * RAD;
    outer.push([Math.cos(a) * rOut0, Math.sin(a) * rOut0]);
    inner.push([Math.cos(a) * rIn0, Math.sin(a) * rIn0]);
  }
  return [...outer, ...inner.reverse()];
}

function baseAndProps() {
  const out = [];
  out.push(`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`);

  // 4 flanged feet sorted back-to-front.
  for (const [fx, fy] of byDepth(k.corners(PLATE, 24))) {
    out.push(S(k.cylinder(fx, fy, 7.2, -PLATE_H - FOOT_H, 1.8, P, 28), { tone: "lo" }));
    out.push(S(k.cylinder(fx, fy, 5.5, -PLATE_H - FOOT_H + 1.8, FOOT_H - 1.8, P, 28), { tone: "mid" }));
  }

  // Main bench plinth, groove, and corner mounting screws.
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }));
  const corners = k.corners(PLATE, 10);
  out.push(L(corners.map(([cx, cy]) => k.ring(cx, cy, 2.2, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(corners.map(([cx, cy]) => at([cx, cy, 0])), { size: 0.5 }));

  // Damper calibration strip on the front deck (+y side, edge-rooted ticks).
  const strip = { x: 10, y: 66, w: 108, d: 8, r: 1.2 };
  out.push(S(k.slabOf(strip, 0, 0.8, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 6, strip.x + strip.w - 6, 4, 5, strip.y + 0.8, 0.8, [2.2, 4.0], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(D([at([strip.x + 3, strip.y + 4, 0.8]), at([strip.x + strip.w - 3, strip.y + 4, 0.8])], { size: 0.45 }));

  // Engraved label plate (only printed-text rule lines carry free: true).
  const plaque = { x: -46, y: 64, w: 44, d: 13, r: 1.5 };
  out.push(S(k.slabOf(plaque, 0, 0.9, P, 3), { tone: "lo" }));
  out.push(L(k.planOutline(k.insetPlan(plaque, 1.8), 0.9, P, 2), { tone: "faint" }));
  out.push(L(k.lineOnTop([plaque.x + 5, plaque.y + 4.2], [plaque.x + 30, plaque.y + 4.2], 0.9, P), { tone: "mid", free: true }));
  out.push(L(k.lineOnTop([plaque.x + 5, plaque.y + 6.8], [plaque.x + 24, plaque.y + 6.8], 0.9, P), { tone: "lo", free: true }));
  out.push(L(k.lineOnTop([plaque.x + 5, plaque.y + 9.4], [plaque.x + 19, plaque.y + 9.4], 0.9, P), { tone: "lo", free: true }));
  out.push(D([at([plaque.x + 2.6, plaque.y + 6.5, 0.9]), at([plaque.x + plaque.w - 2.6, plaque.y + 6.5, 0.9])], { size: 0.45 }));

  // Charcoal fuel basket & spare charcoal logs in back-right corner (far behind tuyere/damper).
  const tray = { x: 78, y: -76, w: 48, d: 34, r: 2.5 };
  out.push(`<path class="iso-halo" d="${k.haloOf(tray, 0, 0.2, P)}"/>`);
  out.push(S(k.slabOf(tray, 0, 2.5, P, 4, 0.4), { tone: "lo" }));
  const wallBack = { x: tray.x, y: tray.y, w: tray.w, d: 3, r: 0.8 };
  const wallLeft = { x: tray.x, y: tray.y, w: 3, d: tray.d, r: 0.8 };
  const wallRight = { x: tray.x + tray.w - 3, y: tray.y, w: 3, d: tray.d, r: 0.8 };
  const wallFront = { x: tray.x, y: tray.y + tray.d - 3, w: tray.w, d: 3, r: 0.8 };
  out.push(S(k.slabOf(wallBack, 2.5, 8, P, 2), { tone: "mid" }));
  out.push(S(k.slabOf(wallLeft, 2.5, 8, P, 2), { tone: "mid" }));
  for (const [cx, cy] of byDepth([[90, -64], [103, -65], [115, -62], [93, -53], [106, -54], [116, -51]], 2.5)) {
    out.push(S(k.cylinder(cx, cy, 3.6, 2.5, 9.5, P, 18, 0.4), { tone: "lo" }));
  }
  out.push(S(k.slabOf(wallRight, 2.5, 8, P, 2), { tone: "mid" }));
  out.push(S(k.slabOf(wallFront, 2.5, 8, P, 2), { tone: "mid" }));
  out.push(D([
    at([tray.x + 1.5, tray.y + 1.5, 10.5]),
    at([tray.x + tray.w - 1.5, tray.y + 1.5, 10.5]),
    at([tray.x + 1.5, tray.y + tray.d - 1.5, 10.5]),
    at([tray.x + tray.w - 1.5, tray.y + tray.d - 1.5, 10.5]),
  ], { size: 0.45 }));

  // Compacted earthen hearth pad & inner cavity floor.
  out.push(`<path class="iso-halo" d="${k.haloOf({ x: -HEARTH_R, y: -HEARTH_R, w: HEARTH_R * 2, d: HEARTH_R * 2, r: HEARTH_R }, 0, HEARTH_H, P)}"/>`);
  out.push(S(k.cylinder(0, 0, HEARTH_R, 0, HEARTH_H, P, 64, 1.0), { tone: "lo" }));
  out.push(L(k.ring(0, 0, HEARTH_R - 4, HEARTH_H, P, 64), { tone: "faint" }));
  out.push(`<g class="cf-cavity">${S(k.cylinder(0, 0, FURNACE.rInBase + 1, HEARTH_H, 0.3, P, 40), { tone: "lo", crease: "none" })}</g>`);

  // Bamboo stoking poker resting on twin notched timber cradles (front-left deck).
  for (const cx of [-106, -64]) {
    out.push(S(k.slabOf({ x: cx - 2.5, y: 49, w: 5, d: 10, r: 1 }, 0, 5.2, P, 2), { tone: "mid" }));
    out.push(D([at([cx, 50.5, 5.2]), at([cx, 57.5, 5.2])], { size: 0.4 }));
  }
  out.push(S(k.slabOf({ x: -118, y: 52.5, w: 66, d: 3, r: 1.4 }, 4.2, 2.8, P, 3, 0.3), { tone: "mid" }));
  out.push(L(k.rise([-100, 55.5], 4.2, 7.0, P), { tone: "lo" }));
  out.push(L(k.rise([-80, 55.5], 4.2, 7.0, P), { tone: "lo" }));

  // Rear foundation anchor stones seated cleanly outside the outer clay base (behind cutaway wings).
  const rearStones = [148, 174, 200, 226, 252, 278, 304]
    .map((deg) => [Math.cos(deg * RAD) * (FURNACE.rOutBase + 6.4), Math.sin(deg * RAD) * (FURNACE.rOutBase + 6.4)]);
  for (const [sx, sy] of byDepth(rearStones, HEARTH_H)) {
    out.push(S(k.cylinder(sx, sy, 4.8, HEARTH_H, 5.2, P, 16, 0.5), { tone: "lo" }));
  }

  return out.join("");
}

function pyrometerStand() {
  const out = [];
  const base = { x: PYRO_X - 18, y: PYRO_Y - 16, w: 36, d: 32, r: 3 };
  out.push(`<path class="iso-halo" d="${k.haloOf(base, 0, 10, P)}"/>`);
  out.push(S(k.slabOf(base, 0, 10, P, 5, 0.8), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(base, 2.4), 10, P, 4), { tone: "faint" }));
  out.push(D([
    at([base.x + 4, base.y + 4, 10]),
    at([base.x + base.w - 4, base.y + 4, 10]),
    at([base.x + 4, base.y + base.d - 4, 10]),
    at([base.x + base.w - 4, base.y + base.d - 4, 10]),
  ], { size: 0.45 }));

  // Probe boss mounted flush on furnace -x wall + horizontal ceramic thermocouple sheath.
  const zProbe = 24;
  const rWall = rOutAt(zProbe);
  out.push(S(k.slabOf({ x: -rWall - 3, y: -4.5, w: 7, d: 9, r: 1.8 }, zProbe - 4, 8, P, 3, 0.4), { tone: "mid" }));
  out.push(S(k.slabOf({ x: PYRO_X - 1, y: -2, w: Math.abs(-rWall - PYRO_X), d: 4, r: 1.5 }, zProbe - 1.5, 3, P, 3), { tone: "hi" }));

  // Post collar, post, vertical temperature scale strip, and crown cap.
  out.push(S(k.cylinder(PYRO_X, PYRO_Y, 5.2, 10, 4, P, 24), { tone: "mid" }));
  out.push(S(k.cylinder(PYRO_X, PYRO_Y, 3.0, 14, 90, P, 24), { tone: "mid", crease: "none" }));
  out.push(L([36, 56, 76].map((z) => k.sideArc(PYRO_X, PYRO_Y, 3.0, z, P, 16)).join(""), { tone: "faint" }));
  out.push(S(k.cylinder(PYRO_X, PYRO_Y, 3.8, 104, 2.2, P, 24), { tone: "mid" }));

  const scale = { x: PYRO_X + 6, y: -5, w: 4, d: 10, r: 1 };
  out.push(S(k.slabOf(scale, 12, 84, P, 2, 0.3), { tone: "lo" }));
  const tickSegs = [];
  const majorSegs = [];
  for (let tz = GAUGE_BOTTOM; tz <= GAUGE_TOP; tz += 5) {
    const isMaj = (tz - GAUGE_BOTTOM) % 15 === 0;
    const len = isMaj ? 3.4 : 1.9;
    (isMaj ? majorSegs : tickSegs).push(L(k.segment([scale.x + scale.w, scale.y + scale.d - 0.1, tz], [scale.x + scale.w - len, scale.y + scale.d - 0.1, tz], P), { tone: isMaj ? "mid" : "lo" }));
  }
  out.push(tickSegs.join(""), majorSegs.join(""));

  // Dynamic lit temperature slider cursor + scale pointer (translated along +z in live.js).
  const cursor = { x: PYRO_X + 4.5, y: -6.5, w: 7, d: 13, r: 1.5 };
  const ptr = { x: PYRO_X + 10.2, y: -1.4, w: 2.8, d: 2.8, r: 0.6 };
  out.push(`<g data-part="gauge">${S(k.slabOf(cursor, -2, 4.4, P, 3, 0.4), { tone: "hi", lit: true })}${S(k.slabOf(ptr, -0.9, 2.2, P, 2), { tone: "hi", lit: true })}</g>`);
  return out.join("");
}

function clayShaftBack() {
  const courses = 14;
  const dh = FURNACE.shaftHeight / courses;
  const out = [];
  // Keep seam inside the hidden limb (+6 deg behind 135/315) so exterior clay edges stay front-SVG paper tone.
  const b0 = FURNACE.seamLeftDeg + 5;
  const b1 = FURNACE.seamRightDeg - 5;
  for (let i = 0; i < courses; i++) {
    const z0 = FURNACE.zFloor + i * dh;
    const z1 = z0 + dh;
    const rOut0 = rOutAt((z0 + z1) / 2);
    const rIn0 = rInAt((z0 + z1) / 2);
    const ring = arcRing(b0, b1, rIn0, rOut0, 24);
    out.push(S(k.extrude(ring, z0, dh, P, { convex: false, bevel: 0.35 }), { tone: "mid" }));
  }
  // Keep top crown clay lip unified across back and front wings while staying behind emerging flame.
  const crown = [];
  for (const bz of [32, 74, FURNACE.zTop - 3.8]) {
    const rOutB = rOutAt(bz) + 1.5;
    const rInB = bz > 100 ? rInAt(FURNACE.zTop) : rOutAt(bz) - 0.1;
    crown.push(S(k.extrude(arcRing(b0, b1, rInB, rOutB, 24), bz, 3.8, P, { convex: false, bevel: 0.3 }), { tone: bz > 100 ? "hi" : "mid" }));
  }
  return `<g class="cf-cavity">${out.join("")}</g>${crown.join("")}`;
}

function clayShaftFront() {
  const courses = 14;
  const dh = FURNACE.shaftHeight / courses;
  const leftOut = [];
  const rightOut = [];
  const b0 = FURNACE.seamLeftDeg + 5;
  const b1 = FURNACE.seamRightDeg - 5;
  for (let i = 0; i < courses; i++) {
    const z0 = FURNACE.zFloor + i * dh;
    const z1 = z0 + dh;
    const rOut0 = rOutAt((z0 + z1) / 2);
    const rIn0 = rInAt((z0 + z1) / 2);
    const leftRing = arcRing(FURNACE.cutEndDeg, b0, rIn0, rOut0, 12);
    const rightRing = arcRing(b1, 360 + FURNACE.cutStartDeg, rIn0, rOut0, 16);
    leftOut.push(S(k.extrude(leftRing, z0, dh, P, { convex: false, bevel: 0.35 }), { tone: "hi" }));
    rightOut.push(S(k.extrude(rightRing, z0, dh, P, { convex: false, bevel: 0.35 }), { tone: "hi" }));
  }
  // Exterior reinforcing clay hoop bands wrapping round front wings behind limb seams.
  for (const bz of [32, 74, FURNACE.zTop - 3.8]) {
    const rOutB = rOutAt(bz) + 1.5;
    const rInB = rOutAt(bz) - 0.1;
    leftOut.push(S(k.extrude(arcRing(FURNACE.cutEndDeg, b0, rInB, rOutB, 12), bz, 3.8, P, { convex: false, bevel: 0.3 }), { tone: "mid" }));
    rightOut.push(S(k.extrude(arcRing(b1, 360 + FURNACE.cutStartDeg, rInB, rOutB, 16), bz, 3.8, P, { convex: false, bevel: 0.3 }), { tone: "mid" }));
  }
  return leftOut.join("") + rightOut.join("");
}

function tuyereAndDamper() {
  const out = [];
  // Front anchor stones clear of cutaway edges and tuyere tunnel.
  for (const [sx, sy] of byDepth([
    [Math.cos(126 * RAD) * (FURNACE.rOutBase + 6.4), Math.sin(126 * RAD) * (FURNACE.rOutBase + 6.4)],
    [Math.cos(332 * RAD) * (FURNACE.rOutBase + 6.4), Math.sin(332 * RAD) * (FURNACE.rOutBase + 6.4)],
  ], HEARTH_H)) {
    out.push(S(k.cylinder(sx, sy, 4.8, HEARTH_H, 5.0, P, 16, 0.5), { tone: "lo" }));
  }

  // Baked-clay tuyere intake tunnel (+x wall, z = 8..22).
  out.push(S(k.slabOf({ x: 30, y: -9, w: 6, d: 18, r: 2.2 }, 7, 16, P, 4, 0.6), { tone: "mid" }));
  out.push(S(k.slabOf({ x: TUYERE_X0 + 10, y: -7.2, w: TUYERE_X1 - (TUYERE_X0 + 10), d: 14.4, r: 2.2 }, 8.5, 13, P, 4, 0.5), { tone: "hi" }));
  // Circular tuyere bore at x = TUYERE_X1.
  out.push(L(k.sideRing([TUYERE_X1, 0, FURNACE.tuyereZ], FURNACE.tuyereR + 0.9, "x", P, 24), { tone: "mid" }));
  out.push(`<path class="iso-fill" d="${k.sideRing([TUYERE_X1, 0, FURNACE.tuyereZ], FURNACE.tuyereR, "x", P, 24)}" style="fill:var(--anatomy-shade-0)"/><path class="iso-edge" d="${k.sideRing([TUYERE_X1, 0, FURNACE.tuyereZ], FURNACE.tuyereR, "x", P, 24)}" data-tone="hi"/>`);

  // Twin low guide rails + end stops for the sliding clay damper.
  for (const rx of [DAMPER_X - 2.6, DAMPER_X + 2.6]) {
    out.push(S(k.slabOf({ x: rx - 1.1, y: RAIL_Y0, w: 2.2, d: RAIL_Y1 - RAIL_Y0, r: 0.6 }, 0, 2.8, P, 2), { tone: "mid" }));
  }
  for (const ry of [RAIL_Y0 - 3, RAIL_Y1]) {
    out.push(S(k.slabOf({ x: DAMPER_X - 4.4, y: ry, w: 8.8, d: 3.4, r: 0.9 }, 0, 5.2, P, 2, 0.3), { tone: "mid" }));
    out.push(D([at([DAMPER_X - 2.2, ry + 1.7, 5.2]), at([DAMPER_X + 2.2, ry + 1.7, 5.2])], { size: 0.4 }));
  }

  // Sliding lit clay damper slab (resting closed at y = -10..10, translated toward -y as it opens).
  const gatePlan = { x: DAMPER_X - 2.6, y: -10, w: 5.2, d: 20, r: 1.4 };
  const handlePlan = { x: DAMPER_X - 1.6, y: -4, w: 3.2, d: 8, r: 1 };
  const damperBody = [
    `<path class="iso-halo" d="${k.haloOf(gatePlan, 2.8, 0.2, P)}"/>`,
    S(k.slabOf(gatePlan, 2.8, 22, P, 4, 0.6), { tone: "hi", lit: true }),
    S(k.slabOf(handlePlan, 24.8, 3.6, P, 3, 0.4), { tone: "hi", lit: true }),
    S(k.cylinder(DAMPER_X, 0, 2.2, 28.4, 3.2, P, 18), { tone: "hi", lit: true }),
  ].join("");
  out.push(`<g data-part="damper">${damperBody}</g>`);
  return out.join("");
}

function svgFallbacks() {
  // No-WebGL fallback shapes projecting the charcoal bed, rising flame and intake air arrows.
  const bedPts = [
    at([15, -8, 12]), at([12, 12, 12]), at([0, 17, 16]), at([-14, 11, 18]),
    at([-15, -10, 16]), at([0, -16, 14]), at([15, -8, 12]),
  ];
  const flamePts = [
    at([9, -6, 22]), at([7, 7, 22]), at([3, 3, 86]), at([0, 0, 116]),
    at([-3, -3, 86]), at([-7, -7, 22]), at([9, -6, 22]),
  ];
  const corePts = [
    at([5, -3, 24]), at([4, 4, 24]), at([1, 1, 64]), at([-2, -2, 48]), at([5, -3, 24]),
  ];
  const dOf = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("") + "Z";
  const backFb = `<g class="cf-fallback" aria-hidden="true">
    <path data-part="fb-bed" class="cf-fb-tint" d="${dOf(bedPts)}" style="fill:var(--cf-fb-bed);opacity:.85"/>
    <path data-part="fb-flame" class="cf-fb-tint" d="${dOf(flamePts)}" style="fill:var(--cf-fb-flame);opacity:.72"/>
    <path data-part="fb-core" d="${dOf(corePts)}" style="fill:var(--cf-fb-core);opacity:.78"/>
  </g>`;
  const airLine = k.segment([76, 0, FURNACE.tuyereZ], [61.5, 0, FURNACE.tuyereZ], P);
  const frontFb = `<g class="cf-fallback" data-part="fb-air" aria-hidden="true">${L(airLine, { tone: "lit", dashed: true, free: true })}</g>`;
  return { backFb, frontFb };
}

const init = furnaceState(0.5);
const fb = svgFallbacks();

const backSvg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  className: "cf-back",
  label: "Isometric cutaway of a natural-draft clay furnace showing a sliding clay air damper, tuyere tunnel, glowing charcoal bed, convective updraft flame and thermocouple gauge.",
  body: [baseAndProps(), pyrometerStand(), clayShaftBack(), fb.backFb],
});

const frontSvg = `<svg xmlns="http://www.w3.org/2000/svg" class="iso-svg cf-layer cf-front" viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true">${clayShaftFront()}${tuyereAndDamper()}${fb.frontFb}</svg>`;

const stage = `<div class="cf-stage" tabindex="0" role="slider" aria-label="Clay furnace air damper: arrow keys open or close the intake" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">${backSvg}<canvas class="cf-layer cf-gl" aria-hidden="true"></canvas>${frontSvg}</div>`;

const data = {
  W: WIDTH,
  H: HEIGHT,
  P,
  camera: glCamera(P),
  zFloor: FURNACE.zFloor,
  shaftHeight: FURNACE.shaftHeight,
  zTop: FURNACE.zTop,
  rOutBase: FURNACE.rOutBase,
  rOutTop: FURNACE.rOutTop,
  rInBase: FURNACE.rInBase,
  rInTop: FURNACE.rInTop,
  tuyereZ: FURNACE.tuyereZ,
  tuyereR: FURNACE.tuyereR,
  damperTravel: FURNACE.damperTravel,
  cutStartDeg: FURNACE.cutStartDeg,
  cutEndDeg: FURNACE.cutEndDeg,
  gaugeBottom: GAUGE_BOTTOM,
  gaugeTravel: GAUGE_TOP - GAUGE_BOTTOM,
  stops: BLACKBODY_STOPS,
};

const card = k.plateHtml({
  fig: "Fig 1",
  title: "Natural-draft clay furnace",
  hint: "Hover or drag to slide damper · ← → keys",
  readout: `damper 50% · ${Math.round(init.tempC).toLocaleString("en-US")} °C · ${init.draftPa.toFixed(1)} Pa · ${init.velocityMs.toFixed(1)} m/s`,
  keys: [
    { mark: "lit", label: "Clay air damper & thermocouple needle (moves with draft)" },
    { mark: "raised", label: "Coiled clay shaft cutaway & refractory soot cavity" },
    { mark: "edge", label: "1,210 °C smelting peak via chimney buoyancy alone" },
  ],
  caption: "No bellows or motor: cold air enters the lower clay tuyere, superheats the charcoal bed, and rises up the tapered chimney, pulling fresh oxygen faster as temperature climbs.",
  body: stage,
});

const outName = theme === "light" ? "clay-furnace-light.html" : "clay-furnace.html";
const html = k.pageHtml({
  title: "Natural-Draft Clay Furnace",
  theme,
  body: `<style>${CSS}</style><div class="cf">${card}</div>`,
  script: kitScript() + glScript() + LIVE.replace("__DATA__", JSON.stringify(data)),
  width: 680,
});

writeFileSync(join(HERE, outName), html);
console.log("wrote", outName);
