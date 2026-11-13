/**
 * Simple 3D Dice — лёгкие 3D-кубики для Foundry VTT (v12–v13).
 * Без внешних зависимостей: собственный WebGL-рендер и упрощённая физика броска.
 */

import { SUITE_ID } from "../../core/constants.js";
import { createFeatureHooks } from "../../core/feature-hooks.js";

/** Функция «3D-кубики» внутри RPG Suite.
 *  Настройки: "rpg-tools-by-hibear.dice-*", цвет игрока: user.flags["rpg-tools-by-hibear"].dice.color */
export const MODULE_ID = SUITE_ID;
const SK = (k) => `dice-${k}`;
const COLOR_FLAG = "dice.color";
const Hooks = createFeatureHooks();

export function setup() {
  Hooks.activate();
}
const DEFAULT_COLOR = "#c0392b";
const MAX_DICE = 30;

export const PALETTE = [
  "#ffffff", "#d0d3d4", "#7f8c8d", "#2b2b2b",
  "#8e1b1b", "#c0392b", "#e74c3c", "#e67e22",
  "#f39c12", "#f1c40f", "#d4ac0d", "#8d5524",
  "#2ecc71", "#27ae60", "#145a32", "#a3e4d7",
  "#1abc9c", "#16a085", "#3498db", "#2155a3",
  "#0b1f4b", "#9b59b6", "#6c3483", "#e84393"
];

/* ------------------------------------------------------------------ */
/*  Векторы, кватернионы, матрицы                                      */
/* ------------------------------------------------------------------ */

const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
};

const Q = {
  mul(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz
    ];
  },
  norm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; },
  axisAngle(axis, ang) { const a = V.norm(axis), s = Math.sin(ang / 2); return [a[0] * s, a[1] * s, a[2] * s, Math.cos(ang / 2)]; },
  rotate(q, v) {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
  },
  fromUnitVectors(a, b) {
    const r = V.dot(a, b) + 1;
    if (r < 1e-6) {
      const axis = Math.abs(a[0]) > Math.abs(a[2]) ? [-a[1], a[0], 0] : [0, -a[2], a[1]];
      return Q.norm([...axis, 0]);
    }
    return Q.norm([...V.cross(a, b), r]);
  },
  integrate(q, w, dt) {
    const d = Q.mul([w[0], w[1], w[2], 0], q);
    return Q.norm([q[0] + d[0] * 0.5 * dt, q[1] + d[1] * 0.5 * dt, q[2] + d[2] * 0.5 * dt, q[3] + d[3] * 0.5 * dt]);
  },
  slerp(a, b, t) {
    let [bx, by, bz, bw] = b;
    let c = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (c > 0.9995) return Q.norm([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
    const th = Math.acos(c), s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
  },
  random() {
    const u1 = Math.random(), u2 = Math.random() * Math.PI * 2, u3 = Math.random() * Math.PI * 2;
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
  }
};

const M4 = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(eye, center, up) {
    const z = V.norm(V.sub(eye, center)), x = V.norm(V.cross(up, z)), y = V.cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -V.dot(x, eye), -V.dot(y, eye), -V.dot(z, eye), 1]);
  },
  model(p, q, s) {
    const [x, y, z, w] = q;
    return new Float32Array([
      (1 - 2 * (y * y + z * z)) * s, 2 * (x * y + z * w) * s, 2 * (x * z - y * w) * s, 0,
      2 * (x * y - z * w) * s, (1 - 2 * (x * x + z * z)) * s, 2 * (y * z + x * w) * s, 0,
      2 * (x * z + y * w) * s, 2 * (y * z - x * w) * s, (1 - 2 * (x * x + y * y)) * s, 0,
      p[0], p[1], p[2], 1
    ]);
  }
};

/* ------------------------------------------------------------------ */
/*  Геометрия кубиков                                                  */
/* ------------------------------------------------------------------ */

/** Собирает многогранник: нормализует радиус, ориентирует грани наружу. */
function makePolyhedron(rawVerts, faceIdx, opts = {}) {
  const maxLen = Math.max(...rawVerts.map(V.len));
  const verts = rawVerts.map(v => V.mul(v, 1 / maxLen));
  const faces = faceIdx.map(idx => {
    let pts = idx.map(i => verts[i]);
    const c = V.mul(pts.reduce((a, p) => V.add(a, p), [0, 0, 0]), 1 / pts.length);
    let n = V.norm(V.cross(V.sub(pts[1], pts[0]), V.sub(pts[2], pts[0])));
    if (V.dot(n, c) < 0) {
      idx = [idx[0], ...idx.slice(1).reverse()];
      pts = idx.map(i => verts[i]);
      n = V.mul(n, -1);
    }
    const upRef = opts.edgeUp ? V.mul(V.add(pts[0], pts[1]), 0.5) : pts[0];
    const up = V.norm(V.sub(upRef, c));
    return { idx, pts, c, n, up };
  });
  return { verts, faces };
}

function icosaData() {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  return { v, f };
}

function dodecaData() {
  // Двойственный икосаэдру: вершины — центры граней икосаэдра.
  const { v, f } = icosaData();
  const verts = f.map(face => V.mul(face.reduce((a, i) => V.add(a, v[i]), [0, 0, 0]), 1 / 3));
  const faces = v.map((iv, vi) => {
    const axis = V.norm(iv);
    const ids = f.map((face, fi) => face.includes(vi) ? fi : -1).filter(i => i >= 0);
    const ref = V.norm(V.sub(verts[ids[0]], V.mul(axis, V.dot(verts[ids[0]], axis))));
    const ref2 = V.cross(axis, ref);
    return ids.sort((a, b) => {
      const pa = verts[a], pb = verts[b];
      return Math.atan2(V.dot(pa, ref2), V.dot(pa, ref)) - Math.atan2(V.dot(pb, ref2), V.dot(pb, ref));
    });
  });
  return { v: verts, f: faces };
}

function d10Data() {
  const e = (1 - Math.cos(Math.PI / 5)) / (1 + Math.cos(Math.PI / 5)); // планарность граней-«воздушных змеев»
  const v = [];
  for (let i = 0; i < 10; i++) {
    const a = i * Math.PI / 5;
    v.push([Math.cos(a), i % 2 ? -e : e, Math.sin(a)]);
  }
  v.push([0, 1, 0], [0, -1, 0]); // 10 — верх, 11 — низ
  const f = [];
  for (let k = 0; k < 5; k++) {
    f.push([10, 2 * k, 2 * k + 1, (2 * k + 2) % 10]);
    f.push([11, 2 * k + 1, (2 * k + 2) % 10, (2 * k + 3) % 10]);
  }
  return { v, f };
}

function coinData(seg = 32, h = 0.13) {
  const v = [];
  for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; v.push([Math.cos(a), h, Math.sin(a)]); }
  for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; v.push([Math.cos(a), -h, Math.sin(a)]); }
  const top = [...Array(seg).keys()];
  const bottom = [...Array(seg).keys()].map(i => seg + i);
  const f = [top, bottom];
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; f.push([i, j, seg + j, seg + i]); }
  return { v, f };
}

const SHAPE_DEFS = {
  d2: () => ({ ...coinData(), scale: 0.95, font: 0.5, maxW: 0.62 }),
  d4: () => ({ v: [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]], f: [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]], scale: 1.3, font: 0.2, maxW: 0.24, vertexLabels: true }),
  d6: () => ({ v: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    f: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]], scale: 1.0, font: 0.5, maxW: 0.6, edgeUp: true }),
  d8: () => ({ v: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
    f: [[2, 0, 4], [2, 4, 1], [2, 1, 5], [2, 5, 0], [3, 4, 0], [3, 1, 4], [3, 5, 1], [3, 0, 5]], scale: 1.08, font: 0.3, maxW: 0.4 }),
  d10: () => ({ ...d10Data(), scale: 1.02, font: 0.26, maxW: 0.32 }),
  d12: () => ({ ...dodecaData(), scale: 1.08, font: 0.36, maxW: 0.5 }),
  d20: () => ({ ...icosaData(), scale: 1.12, font: 0.26, maxW: 0.36 })
};

const ATLAS = 512;
const shapeCache = new Map();

/** Готовая форма: грани, UV в атласе, «слоты» значений. */
export function getShape(key) {
  if (shapeCache.has(key)) return shapeCache.get(key);
  const def = SHAPE_DEFS[key]();
  const { verts, faces } = makePolyhedron(def.v, def.f, def);
  const shape = { key, verts, faces, scale: def.scale, font: def.font, maxW: def.maxW, vertexLabels: !!def.vertexLabels };

  // Слоты — то, что может оказаться «результатом»: грани (или вершины у d4).
  if (shape.vertexLabels) shape.slots = verts.map((v, i) => ({ dir: V.norm(v), vertex: i }));
  else if (key === "d2") shape.slots = [{ dir: faces[0].n, face: 0 }, { dir: faces[1].n, face: 1 }];
  else shape.slots = faces.map((f, i) => ({ dir: f.n, face: i }));

  // Ячейки атласа: у монетки все боковые грани делят одну ячейку.
  faces.forEach((f, i) => { f.cell = key === "d2" ? Math.min(i, 2) : i; f.slot = key === "d2" ? (i < 2 ? i : -1) : i; });
  const cells = Math.max(...faces.map(f => f.cell)) + 1;
  shape.grid = Math.ceil(Math.sqrt(cells));

  // Плоские 2D-координаты граней и UV.
  const pos = [], nrm = [], uv = [];
  for (const f of faces) {
    const u = V.cross(f.up, f.n);
    const p2 = f.pts.map(p => { const d = V.sub(p, f.c); return [V.dot(d, u), -V.dot(d, f.up)]; });
    const m = Math.max(...p2.flat().map(Math.abs)) || 1;
    f.p2 = p2.map(([x, y]) => [x / m, y / m]);
    const col = f.cell % shape.grid, row = Math.floor(f.cell / shape.grid);
    const fuv = f.p2.map(([x, y]) => [(col + 0.5 + x * 0.46) / shape.grid, (row + 0.5 + y * 0.46) / shape.grid]);
    for (let i = 1; i < f.pts.length - 1; i++) {
      for (const k of [0, i, i + 1]) { pos.push(...f.pts[k]); nrm.push(...f.n); uv.push(...fuv[k]); }
    }
  }
  shape.mesh = { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), count: pos.length / 3 };
  shapeCache.set(key, shape);
  return shape;
}

/* ------------------------------------------------------------------ */
/*  Что рисовать на гранях                                             */
/* ------------------------------------------------------------------ */

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const STANDARD = [4, 6, 8, 10, 12, 20];

/**
 * Превращает один результат кубика в описание(я) 3D-кубика.
 * @returns {{shape:string, labels:string[], slot:number}[]}
 */
export function specsForResult(faces, result, kind = "die") {
  if (kind === "fate") {
    const slot = result > 0 ? 0 : result < 0 ? 2 : 4;
    return [{ shape: "d6", labels: ["+", "+", "−", "−", " ", " "], slot }];
  }
  if (kind === "coin") return [{ shape: "d2", labels: ["1", "0"], slot: result ? 0 : 1 }];
  if (faces === 2) return [{ shape: "d2", labels: ["1", "2"], slot: result === 2 ? 1 : 0 }];
  if (faces === 100) {
    const tens = Math.floor((result % 100) / 10), units = result % 10;
    return [
      { shape: "d10", labels: range(10, i => (i === 0 ? "00" : String(i * 10))), slot: tens },
      { shape: "d10", labels: range(10, i => String(i)), slot: units }
    ];
  }
  if (STANDARD.includes(faces)) return [{ shape: `d${faces}`, labels: range(faces, i => String(i + 1)), slot: result - 1 }];
  if (faces < 20) {
    const n = STANDARD.find(s => s >= faces);
    return [{ shape: `d${n}`, labels: range(n, i => String((i % faces) + 1)), slot: result - 1 }];
  }
  // Нестандартный большой кубик (d30, d50…): форма d20, результат на верхней грани.
  const labels = range(20, () => String(1 + Math.floor(Math.random() * faces)));
  labels[0] = String(result);
  return [{ shape: "d20", labels, slot: 0 }];
}

/** Достаёт все кубики из массива Roll. */
export function specsFromRolls(rolls) {
  const out = [];
  const terms = foundry?.dice?.terms ?? {};
  for (const roll of rolls ?? []) {
    for (const term of roll.dice ?? []) {
      let kind = "die";
      if (terms.FateDie && term instanceof terms.FateDie) kind = "fate";
      else if (terms.Coin && term instanceof terms.Coin) kind = "coin";
      const faces = Number(term.faces) || 0;
      if (!faces && kind === "die") continue;
      for (const r of term.results ?? []) {
        if (typeof r.result !== "number") continue;
        out.push(...specsForResult(faces, r.result, kind));
      }
    }
  }
  return out.slice(0, MAX_DICE);
}

/* ------------------------------------------------------------------ */
/*  Цвет                                                               */
/* ------------------------------------------------------------------ */

function parseHex(hex) {
  let h = String(hex || DEFAULT_COLOR).replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n) ? [192, 57, 43] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toCss = ([r, g, b]) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;

function diceColors(hex) {
  const c = parseHex(hex);
  const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  const text = lum > 0.6 ? "#161616" : "#ffffff";
  const edge = lum < 0.2 ? c.map(x => x + (255 - x) * 0.25) : c.map(x => x * 0.68);
  return { body: toCss(c), text, edge: toCss(edge) };
}

/* ------------------------------------------------------------------ */
/*  WebGL-рендер                                                       */
/* ------------------------------------------------------------------ */

const DIE_VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;
uniform mat4 uProj, uView, uModel;
varying vec3 vN; varying vec2 vUv; varying vec3 vW;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz; vN = mat3(uModel) * aNrm; vUv = aUv;
  gl_Position = uProj * uView * w;
}`;
const DIE_FS = `
precision mediump float;
uniform sampler2D uTex; uniform vec3 uEye; uniform float uAlpha;
varying vec3 vN; varying vec2 vUv; varying vec3 vW;
void main(){
  vec3 n = normalize(vN);
  vec3 l = normalize(vec3(0.35, 1.0, 0.45));
  vec3 v = normalize(uEye - vW);
  vec3 h = normalize(l + v);
  vec3 base = texture2D(uTex, vUv).rgb;
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(n, h), 0.0), 40.0) * 0.35;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.12;
  vec3 col = base * (0.38 + 0.72 * diff) + vec3(spec + rim);
  gl_FragColor = vec4(col, uAlpha);
}`;
const SHADOW_VS = `
attribute vec2 aQuad; uniform mat4 uProj, uView; uniform vec3 uCenter; uniform float uSize;
varying vec2 vQ;
void main(){ vQ = aQuad; gl_Position = uProj * uView * vec4(uCenter + vec3(aQuad.x, 0.0, aQuad.y) * uSize, 1.0); }`;
const SHADOW_FS = `
precision mediump float; uniform float uAlpha; varying vec2 vQ;
void main(){ float d = length(vQ); gl_FragColor = vec4(0.0, 0.0, 0.0, uAlpha * (1.0 - smoothstep(0.15, 1.0, d))); }`;

export class DiceRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: true });
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    this.dieProg = this.#program(DIE_VS, DIE_FS);
    this.shadowProg = this.#program(SHADOW_VS, SHADOW_FS);
    this.buffers = new Map();
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    this.atlasCanvas = document.createElement("canvas");
    this.atlasCanvas.width = this.atlasCanvas.height = ATLAS;
  }

  #program(vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const loc = {};
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES), nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < na; i++) { const n = gl.getActiveAttrib(p, i).name; loc[n] = gl.getAttribLocation(p, n); }
    for (let i = 0; i < nu; i++) { const n = gl.getActiveUniform(p, i).name; loc[n] = gl.getUniformLocation(p, n); }
    return { p, loc };
  }

  #meshBuffers(shape) {
    if (this.buffers.has(shape.key)) return this.buffers.get(shape.key);
    const gl = this.gl, mk = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    const b = { pos: mk(shape.mesh.pos), nrm: mk(shape.mesh.nrm), uv: mk(shape.mesh.uv), count: shape.mesh.count };
    this.buffers.set(shape.key, b);
    return b;
  }

  /** Рисует атлас граней (цвет, рёбра, цифры) и загружает его в текстуру. */
  createTexture(shape, labels, color) {
    const ctx = this.atlasCanvas.getContext("2d");
    const col = diceColors(color);
    const cs = ATLAS / shape.grid;
    ctx.fillStyle = col.body;
    ctx.fillRect(0, 0, ATLAS, ATLAS);
    const drawn = new Set();
    for (const f of shape.faces) {
      if (drawn.has(f.cell)) continue;
      drawn.add(f.cell);
      const cx = (f.cell % shape.grid + 0.5) * cs, cy = (Math.floor(f.cell / shape.grid) + 0.5) * cs, k = 0.46 * cs;
      if (shape.key !== "d2" || f.cell < 2) {
        ctx.beginPath();
        f.p2.forEach(([x, y], i) => (i ? ctx.lineTo(cx + x * k, cy + y * k) : ctx.moveTo(cx + x * k, cy + y * k)));
        ctx.closePath();
        ctx.strokeStyle = col.edge;
        ctx.lineWidth = cs * 0.035;
        ctx.stroke();
      }
      ctx.fillStyle = col.text;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (shape.vertexLabels) {
        f.idx.forEach((vi, j) => {
          const [x, y] = f.p2[j];
          this.#text(ctx, labels[vi], cx + x * k * 0.56, cy + y * k * 0.56, Math.atan2(x, -y), cs, shape);
        });
      } else if (f.slot >= 0) {
        this.#text(ctx, labels[f.slot], cx, cy, 0, cs, shape);
      }
    }
    const gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  #text(ctx, label, x, y, rot, cs, shape) {
    if (!label || !label.trim()) return;
    let size = cs * shape.font;
    ctx.font = `bold ${size}px Signika, "Segoe UI", Arial, sans-serif`;
    const w = ctx.measureText(label).width, maxW = cs * shape.maxW;
    if (w > maxW) { size *= maxW / w; ctx.font = `bold ${size}px Signika, "Segoe UI", Arial, sans-serif`; }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillText(label, 0, size * 0.04);
    // Подчёркивание 6 и 9, чтобы их не путали.
    if ((label === "6" || label === "9") && shape.key !== "d6" && shape.key !== "d4") {
      ctx.fillRect(-size * 0.24, size * 0.42, size * 0.48, Math.max(2, size * 0.08));
    }
    ctx.restore();
  }

  deleteTexture(tex) { if (tex) this.gl.deleteTexture(tex); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    return this.canvas.width / this.canvas.height;
  }

  clear() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /**
   * @param {object[]} items  {shape, tex, pos, q, scale, alpha}
   * @param {object} cam      {eye, target, fov}
   */
  draw(items, cam, { shadows = true } = {}) {
    const gl = this.gl;
    const aspect = this.resize();
    this.clear();
    if (!items.length) return;
    const proj = M4.perspective(cam.fov, aspect, 0.5, 300), view = M4.lookAt(cam.eye, cam.target, cam.up ?? [0, 1, 0]);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (shadows) {
      const { p, loc } = this.shadowProg;
      gl.useProgram(p);
      gl.disable(gl.DEPTH_TEST);
      gl.uniformMatrix4fv(loc.uProj, false, proj);
      gl.uniformMatrix4fv(loc.uView, false, view);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(loc.aQuad);
      gl.vertexAttribPointer(loc.aQuad, 2, gl.FLOAT, false, 0, 0);
      for (const it of items) {
        const h = Math.max(0, it.pos[1] - it.scale * 0.6);
        gl.uniform3f(loc.uCenter, it.pos[0] + h * 0.25, 0.01, it.pos[2] + h * 0.3);
        gl.uniform1f(loc.uSize, it.scale * (1.25 + h * 0.15));
        gl.uniform1f(loc.uAlpha, it.alpha * 0.45 / (1 + h * 0.4));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      gl.disableVertexAttribArray(loc.aQuad);
    }

    const { p, loc } = this.dieProg;
    gl.useProgram(p);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.uniformMatrix4fv(loc.uProj, false, proj);
    gl.uniformMatrix4fv(loc.uView, false, view);
    gl.uniform3fv(loc.uEye, cam.eye);
    gl.uniform1i(loc.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const it of items) {
      const b = this.#meshBuffers(it.shape);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.pos); gl.enableVertexAttribArray(loc.aPos); gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.nrm); gl.enableVertexAttribArray(loc.aNrm); gl.vertexAttribPointer(loc.aNrm, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.uv); gl.enableVertexAttribArray(loc.aUv); gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, it.tex);
      gl.uniformMatrix4fv(loc.uModel, false, M4.model(it.pos, it.q, it.scale));
      gl.uniform1f(loc.uAlpha, it.alpha);
      gl.drawArrays(gl.TRIANGLES, 0, b.count);
    }
    gl.disable(gl.CULL_FACE);
  }

  destroy() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/* ------------------------------------------------------------------ */
/*  Физика броска (заранее просчитанная траектория)                    */
/* ------------------------------------------------------------------ */

const DT = 1 / 60;
const GRAVITY = 38;
const SETTLE = 0.45;
const UP = [0, 1, 0];

function minY(shape, q, s) {
  let m = Infinity;
  for (const v of shape.verts) { const y = Q.rotate(q, v)[1]; if (y < m) m = y; }
  return m * s;
}

/**
 * Просчитывает бросок группы кубиков. Когда кубик почти остановился,
 * результат «переклеивается» на ту грань, что смотрит вверх, —
 * поэтому кубик доваливается совсем чуть-чуть и выглядит естественно.
 */
export function simulate(dice, bounds, obstacles = []) {
  const n = dice.length;
  const side = Math.floor(Math.random() * 3); // 0 — снизу, 1 — слева, 2 — справа
  const midX = (bounds.minX + bounds.maxX) / 2, midZ = (bounds.minZ + bounds.maxZ) / 2;
  const spanX = bounds.maxX - bounds.minX, spanZ = bounds.maxZ - bounds.minZ;

  dice.forEach((d, i) => {
    const spread = (i - (n - 1) / 2) * 1.6 + (Math.random() - 0.5) * 1.2;
    let start;
    if (side === 0) start = [midX + spread, 0, bounds.maxZ + 2];
    else if (side === 1) start = [bounds.minX - 2, 0, midZ + spread];
    else start = [bounds.maxX + 2, 0, midZ + spread];
    start[1] = 2.5 + Math.random() * 2.5;
    const aim = [midX + (Math.random() - 0.5) * spanX * 0.45, 0, midZ + (Math.random() - 0.5) * spanZ * 0.45];
    const dir = V.norm([aim[0] - start[0], 0, aim[2] - start[2]]);
    const speed = 15 + Math.random() * 9;
    d.pos = start;
    d.vel = [dir[0] * speed, 2 + Math.random() * 4, dir[2] * speed];
    d.q = Q.random();
    d.w = V.mul(V.norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]), 12 + Math.random() * 12);
    d.r = d.scale * 0.85;
    d.tS = 1.05 + Math.random() * 0.35;
    d.entered = false;
    d.qT = null;
    d.frames = [];
  });

  const total = Math.max(...dice.map(d => d.tS)) + SETTLE + 0.05;
  const steps = Math.ceil(total / DT);

  for (let step = 0; step <= steps; step++) {
    const t = step * DT;
    for (const d of dice) {
      let qRender;
      if (t < d.tS) {
        d.w = V.mul(d.w, Math.exp(-(0.6 + 2.6 * t / d.tS) * DT));
        d.q = Q.integrate(d.q, d.w, DT);
        qRender = d.q;
      } else {
        if (!d.qT) {
          // Какая грань (вершина у d4) сейчас ближе всего к «верху»?
          let best = 0, bestDot = -Infinity;
          d.shape.slots.forEach((s, i) => { const dt = Q.rotate(d.q, s.dir)[1]; if (dt > bestDot) { bestDot = dt; best = i; } });
          if (best !== d.slot) { const tmp = d.labels[best]; d.labels[best] = d.labels[d.slot]; d.labels[d.slot] = tmp; d.slot = best; }
          d.qT = Q.norm(Q.mul(Q.fromUnitVectors(Q.rotate(d.q, d.shape.slots[best].dir), UP), d.q));
        }
        const s = Math.min(1, (t - d.tS) / SETTLE), e = 1 - Math.pow(1 - s, 3);
        d.w = V.mul(d.w, Math.exp(-7 * DT));
        d.q = Q.integrate(d.q, d.w, DT);
        qRender = s >= 1 ? d.qT : Q.slerp(d.q, d.qT, e);
        d.vel = [d.vel[0] * Math.exp(-5 * DT), d.vel[1], d.vel[2] * Math.exp(-5 * DT)];
      }

      d.vel[1] -= GRAVITY * DT;
      d.pos = V.add(d.pos, V.mul(d.vel, DT));

      const ym = minY(d.shape, qRender, d.scale);
      if (d.pos[1] + ym <= 0) {
        d.pos[1] = -ym;
        if (d.vel[1] < 0) {
          const impact = -d.vel[1];
          d.vel[1] = impact > 3 ? impact * 0.38 : 0;
          d.vel[0] *= 0.8; d.vel[2] *= 0.8;
          if (t < d.tS) {
            const roll = V.mul(V.cross(UP, d.vel), 1 / d.r);
            const kick = V.mul([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5], impact * 0.5);
            d.w = V.add(V.lerp(d.w, roll, 0.55), kick);
          }
        }
      }
      if (d.pos[1] + ym < 0.05) { const f = Math.exp(-2.4 * DT); d.vel[0] *= f; d.vel[2] *= f; }

      // Борта стола
      const inside = d.pos[0] - d.r > bounds.minX && d.pos[0] + d.r < bounds.maxX && d.pos[2] - d.r > bounds.minZ && d.pos[2] + d.r < bounds.maxZ;
      if (inside) d.entered = true;
      if (d.entered) {
        if (d.pos[0] - d.r < bounds.minX && d.vel[0] < 0) { d.pos[0] = bounds.minX + d.r; d.vel[0] *= -0.6; d.w = V.mul(d.w, -0.7); }
        if (d.pos[0] + d.r > bounds.maxX && d.vel[0] > 0) { d.pos[0] = bounds.maxX - d.r; d.vel[0] *= -0.6; d.w = V.mul(d.w, -0.7); }
        if (d.pos[2] - d.r < bounds.minZ && d.vel[2] < 0) { d.pos[2] = bounds.minZ + d.r; d.vel[2] *= -0.6; d.w = V.mul(d.w, -0.7); }
        if (d.pos[2] + d.r > bounds.maxZ && d.vel[2] > 0) { d.pos[2] = bounds.maxZ - d.r; d.vel[2] *= -0.6; d.w = V.mul(d.w, -0.7); }
      }
      d.qRender = qRender;
    }

    // Столкновения кубиков между собой (как шары, только по горизонтали)
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = dice[i], b = dice[j];
      const dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2];
      const dist = Math.hypot(dx, dz), min = a.r + b.r;
      if (dist >= min || dist < 1e-6) continue;
      const nx = dx / dist, nz = dz / dist, push = (min - dist) / 2;
      a.pos[0] -= nx * push; a.pos[2] -= nz * push;
      b.pos[0] += nx * push; b.pos[2] += nz * push;
      const rel = (b.vel[0] - a.vel[0]) * nx + (b.vel[2] - a.vel[2]) * nz;
      if (rel < 0) {
        const imp = -(1 + 0.5) * rel / 2;
        a.vel[0] -= nx * imp; a.vel[2] -= nz * imp;
        b.vel[0] += nx * imp; b.vel[2] += nz * imp;
        if (t < a.tS) a.w = V.add(a.w, [nz * imp, 0, -nx * imp]);
        if (t < b.tS) b.w = V.add(b.w, [-nz * imp, 0, nx * imp]);
      }
    }

    // Кубики предыдущих бросков, которые ещё лежат на столе
    for (const d of dice) for (const o of obstacles) {
      const dx = d.pos[0] - o.x, dz = d.pos[2] - o.z, dist = Math.hypot(dx, dz), min = d.r + o.r;
      if (dist >= min || dist < 1e-6) continue;
      const nx = dx / dist, nz = dz / dist;
      d.pos[0] = o.x + nx * min; d.pos[2] = o.z + nz * min;
      const vn = d.vel[0] * nx + d.vel[2] * nz;
      if (vn < 0) { d.vel[0] -= 1.5 * vn * nx; d.vel[2] -= 1.5 * vn * nz; }
    }

    for (const d of dice) d.frames.push([d.pos[0], d.pos[1], d.pos[2], ...d.qRender]);
  }
  return total;
}

/** Положение кубика в момент времени t (с интерполяцией кадров). */
function sample(d, t) {
  const f = Math.max(0, t / DT), i = Math.min(Math.floor(f), d.frames.length - 1), j = Math.min(i + 1, d.frames.length - 1), a = Math.min(1, f - i);
  const A = d.frames[i], B = d.frames[j];
  return {
    pos: [A[0] + (B[0] - A[0]) * a, A[1] + (B[1] - A[1]) * a, A[2] + (B[2] - A[2]) * a],
    q: Q.slerp([A[3], A[4], A[5], A[6]], [B[3], B[4], B[5], B[6]], a)
  };
}

/* ------------------------------------------------------------------ */
/*  Оверлей на столе                                                   */
/* ------------------------------------------------------------------ */

const TABLE_CAM = { eye: [0, 70, 6], target: [0, 0, 0], fov: 16 * Math.PI / 180 };

/** Видимая часть «пола» (y = 0) под камерой. */
function tableBounds(aspect) {
  const { eye, target, fov } = TABLE_CAM;
  const f = V.norm(V.sub(target, eye)), r = V.norm(V.cross(f, UP)), u = V.cross(r, f), th = Math.tan(fov / 2);
  const hit = (x, y) => { const d = V.add(f, V.add(V.mul(r, x * th * aspect), V.mul(u, y * th))); const k = -eye[1] / d[1]; return V.add(eye, V.mul(d, k)); };
  const nearR = hit(1, -1), farR = hit(1, 1);
  const half = Math.min(Math.abs(nearR[0]), Math.abs(farR[0])) - 0.6;
  return { minX: -half, maxX: half, minZ: farR[2] + 1.2, maxZ: nearR[2] - 1.0 };
}

export class DiceOverlay {
  constructor() {
    this.groups = [];
    this.raf = null;
    this.canvas = document.createElement("canvas");
    this.canvas.id = "simple-3d-dice-overlay";
    const board = document.getElementById("board");
    if (board) board.after(this.canvas);
    else { this.canvas.style.zIndex = "100"; document.body.append(this.canvas); }
    this.renderer = new DiceRenderer(this.canvas);
  }

  /**
   * Бросает кубики на стол.
   * @returns {Promise<void>} — выполняется, когда кубики остановились.
   */
  throw(specs, color, { size = 1, hold = 3 } = {}) {
    if (!specs.length) return Promise.resolve();
    const aspect = this.renderer.resize();
    const dice = specs.map(s => {
      const shape = getShape(s.shape);
      return { shape, labels: [...s.labels], slot: s.slot, scale: shape.scale * size };
    });
    const obstacles = this.groups.flatMap(g => g.dice.map(d => { const F = d.frames.at(-1); return { x: F[0], z: F[2], r: d.r }; }));
    const simTime = simulate(dice, tableBounds(aspect), obstacles);
    for (const d of dice) d.tex = this.renderer.createTexture(d.shape, d.labels, color);
    return new Promise(resolve => {
      this.groups.push({ dice, start: performance.now(), simTime, hold, fade: 0.6, onSettle: resolve, settled: false });
      if (!this.raf) this.raf = requestAnimationFrame(this.#frame);
    });
  }

  #frame = (now) => {
    const items = [];
    for (const g of this.groups) {
      const t = (now - g.start) / 1000;
      if (!g.settled && t >= g.simTime) { g.settled = true; g.onSettle(); }
      const fadeT = t - g.simTime - g.hold;
      const alpha = fadeT > 0 ? Math.max(0, 1 - fadeT / g.fade) : 1;
      g.done = alpha <= 0;
      if (g.done) continue;
      for (const d of g.dice) items.push({ shape: d.shape, tex: d.tex, scale: d.scale, alpha, ...sample(d, t) });
    }
    for (const g of this.groups.filter(g => g.done)) for (const d of g.dice) this.renderer.deleteTexture(d.tex);
    this.groups = this.groups.filter(g => !g.done);
    this.renderer.draw(items, TABLE_CAM);
    this.raf = this.groups.length ? requestAnimationFrame(this.#frame) : null;
  };
}

/* ------------------------------------------------------------------ */
/*  Превью в окне выбора цвета                                         */
/* ------------------------------------------------------------------ */

export class DicePreview {
  constructor(canvas, color) {
    this.renderer = new DiceRenderer(canvas);
    this.keys = ["d4", "d6", "d8", "d10", "d12", "d20"];
    this.labelsFor = { d4: ["1", "2", "3", "4"], d6: range(6, i => `${i + 1}`), d8: range(8, i => `${i + 1}`), d10: range(10, i => `${i + 1}`), d12: range(12, i => `${i + 1}`), d20: range(20, i => `${i + 1}`) };
    this.setColor(color);
    this.t0 = performance.now();
    this.raf = requestAnimationFrame(this.#frame);
  }
  setColor(color) {
    for (const t of this.texes ?? []) this.renderer.deleteTexture(t);
    this.texes = this.keys.map(k => this.renderer.createTexture(getShape(k), this.labelsFor[k], color));
  }
  #frame = (now) => {
    const t = (now - this.t0) / 1000, n = this.keys.length;
    const items = this.keys.map((k, i) => {
      const shape = getShape(k);
      return {
        shape, tex: this.texes[i], alpha: 1, scale: shape.scale * 0.95,
        pos: [(i - (n - 1) / 2) * 2.5, 0, 0],
        q: Q.mul(Q.axisAngle([0, 1, 0], t * 0.7 + i), Q.axisAngle([1, 0, 0.3], 0.5 + i * 0.4))
      };
    });
    this.renderer.draw(items, { eye: [0, 1.2, 9], target: [0, 0, 0], fov: 32 * Math.PI / 180 }, { shadows: false });
    this.raf = requestAnimationFrame(this.#frame);
  };
  destroy() { cancelAnimationFrame(this.raf); this.renderer.destroy(); }
}

/* ------------------------------------------------------------------ */
/*  Интеграция с Foundry                                               */
/* ------------------------------------------------------------------ */

let overlay = null;
const pending = new Set();

function getOverlay() {
  if (!overlay) {
    try { overlay = new DiceOverlay(); }
    catch (err) { console.error(`${MODULE_ID} | WebGL недоступен`, err); overlay = false; }
  }
  return overlay || null;
}

export function userDiceColor(user) {
  const flag = user?.getFlag?.(MODULE_ID, COLOR_FLAG);
  if (flag) return flag;
  const c = user?.color;
  return c?.css ?? (c ? String(c) : DEFAULT_COLOR);
}

function diceOptions() {
  const size = { small: 0.75, medium: 1, large: 1.3 }[game.settings.get(MODULE_ID, SK("size"))] ?? 1;
  return { size, hold: Number(game.settings.get(MODULE_ID, SK("duration"))) || 3 };
}

function setHidden(id, hidden) {
  for (const el of document.querySelectorAll(`[data-message-id="${id}"]`)) el.classList.toggle("s3d-pending", hidden);
}

async function onCreateChatMessage(message) {
  if (!message.isRoll || !message.rolls?.length) return;
  // Кубиков не будет — сразу сообщаем, что ждать нечего
  const skip = () => Hooks.callAll("rpgSuite.diceSettled", message.id);
  if (message.isContentVisible === false) return skip();
  const specs = specsFromRolls(message.rolls);
  if (!specs.length) return skip();
  const ov = getOverlay();
  if (!ov) return skip();

  const hide = game.settings.get(MODULE_ID, SK("hideUntilSettled"));
  if (hide) { pending.add(message.id); setHidden(message.id, true); }
  try {
    await ov.throw(specs, userDiceColor(message.author ?? message.user), diceOptions());
  } finally {
    Hooks.callAll("rpgSuite.diceSettled", message.id);
    if (hide) {
      pending.delete(message.id);
      setHidden(message.id, false);
      try { ui.chat?.scrollBottom?.(); } catch (_) { /* не критично */ }
    }
  }
}

function onRenderChatMessage(message, html) {
  if (!pending.has(message.id)) return;
  const el = html instanceof HTMLElement ? html : html?.[0];
  el?.classList.add("s3d-pending");
}

/** Публичное API: game.rpgSuite.api.dice */
export const api = {
  /** Показать уже брошенный Roll локально (используют Запросы бросков, если результат не идёт в чат). */
  async showRoll(roll, user = game.user) {
    const ov = getOverlay();
    if (ov) await ov.throw(specsFromRolls([roll]), userDiceColor(user), diceOptions());
  },
  /** Показать кубики локально, например: api.show("2d20 + 1d6"). */
  async show(formula, color = userDiceColor(game.user)) {
    const roll = await new Roll(formula).evaluate();
    const ov = getOverlay();
    if (ov) await ov.throw(specsFromRolls([roll]), color, diceOptions());
    return roll;
  },
  /** Тестовый бросок всех кубиков от d2 до d100. */
  test(color = userDiceColor(game.user)) {
    return api.show("1d2 + 1d4 + 1d6 + 1d8 + 1d10 + 1d12 + 1d20 + 1d100", color);
  }
};

function registerSettings() {
  const ApplicationV2 = foundry.applications.api.ApplicationV2;

  class DiceColorConfig extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "rpg-suite-dice-color",
      tag: "form",
      classes: ["s3d-config"],
      window: { title: "S3D.Config.Title", icon: "fas fa-dice-d20" },
      position: { width: 460, height: "auto" },
      form: { handler: DiceColorConfig.onSubmit, closeOnSubmit: true }
    };

    color = userDiceColor(game.user);

    async _renderHTML() {
      const L = (k) => game.i18n.localize(`S3D.Config.${k}`);
      const el = document.createElement("div");
      el.className = "s3d-body";
      el.innerHTML = `
        <canvas class="s3d-preview"></canvas>
        <p class="s3d-label">${L("Palette")}</p>
        <div class="s3d-palette">
          ${PALETTE.map(c => `<button type="button" class="s3d-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
        </div>
        <div class="s3d-custom">
          <span class="s3d-label">${L("Custom")}</span>
          <input type="color" class="s3d-picker">
          <input type="text" class="s3d-hex" maxlength="7">
        </div>
        <input type="hidden" name="color">
        <div class="s3d-buttons">
          <button type="button" data-act="test"><i class="fas fa-dice"></i> ${L("Test")}</button>
          <button type="button" data-act="reset"><i class="fas fa-undo"></i> ${L("Reset")}</button>
          <button type="submit"><i class="fas fa-save"></i> ${L("Save")}</button>
        </div>`;
      return el;
    }

    _replaceHTML(result, content) { content.replaceChildren(result); }

    _onRender() {
      const root = this.element;
      try { this.preview = new DicePreview(root.querySelector(".s3d-preview"), this.color); }
      catch (err) { console.warn(`${MODULE_ID} | превью недоступно`, err); }
      root.querySelectorAll(".s3d-swatch").forEach(b => b.addEventListener("click", () => this.#setColor(b.dataset.color)));
      root.querySelector(".s3d-picker").addEventListener("input", ev => this.#setColor(ev.target.value));
      root.querySelector(".s3d-hex").addEventListener("change", ev => {
        const v = ev.target.value.trim();
        if (/^#?[0-9a-f]{6}$/i.test(v)) this.#setColor(v.startsWith("#") ? v : `#${v}`);
      });
      root.querySelector('[data-act="test"]').addEventListener("click", () => api.test(this.color));
      root.querySelector('[data-act="reset"]').addEventListener("click", async () => {
        await game.user.unsetFlag(MODULE_ID, COLOR_FLAG);
        this.#setColor(userDiceColor(game.user));
      });
      this.#setColor(this.color);
    }

    #setColor(c) {
      this.color = c.toLowerCase();
      const root = this.element;
      root.querySelector('input[name="color"]').value = this.color;
      root.querySelector(".s3d-picker").value = this.color.length === 7 ? this.color : "#000000";
      root.querySelector(".s3d-hex").value = this.color;
      root.querySelectorAll(".s3d-swatch").forEach(b => b.classList.toggle("active", b.dataset.color === this.color));
      this.preview?.setColor(this.color);
    }

    _onClose() { this.preview?.destroy(); this.preview = null; }

    static async onSubmit(event, form, formData) {
      const color = formData.object.color;
      if (color) await game.user.setFlag(MODULE_ID, COLOR_FLAG, color);
    }
  }

  game.settings.registerMenu(MODULE_ID, SK("colorMenu"), {
    name: "S3D.Menu.Name",
    label: "S3D.Menu.Label",
    hint: "S3D.Menu.Hint",
    icon: "fas fa-palette",
    type: DiceColorConfig,
    restricted: false
  });

  game.settings.register(MODULE_ID, SK("size"), {
    name: "S3D.Settings.Size", hint: "S3D.Settings.SizeHint", scope: "world", config: true, type: String, default: "medium",
    choices: { small: "S3D.Settings.SizeSmall", medium: "S3D.Settings.SizeMedium", large: "S3D.Settings.SizeLarge" }
  });
  game.settings.register(MODULE_ID, SK("duration"), {
    name: "S3D.Settings.Duration", hint: "S3D.Settings.DurationHint", scope: "world", config: true, type: Number, default: 3,
    range: { min: 1, max: 15, step: 1 }
  });
  game.settings.register(MODULE_ID, SK("hideUntilSettled"), {
    name: "S3D.Settings.Hide", hint: "S3D.Settings.HideHint", scope: "world", config: true, type: Boolean, default: true
  });
}

if (typeof Hooks !== "undefined") {
  Hooks.once("init", () => {
    registerSettings();
    if (game.release?.generation >= 13) Hooks.on("renderChatMessageHTML", onRenderChatMessage);
    else Hooks.on("renderChatMessage", onRenderChatMessage);
  });
  Hooks.once("ready", () => {
    if (game.modules.get("dice-so-nice")?.active) {
      console.warn(`${MODULE_ID} | Включён Dice So Nice — кубики будут показаны дважды. Отключите один из модулей.`);
    }
    getOverlay();
  });
  Hooks.on("createChatMessage", onCreateChatMessage);
}
