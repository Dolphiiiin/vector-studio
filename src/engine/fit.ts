/**
 * 輪郭点列 → きれいなパス。
 *  1. 角を検出して、角と角の間を「辺」に分ける
 *  2. 辺ごとに点列をガウス平滑化（角の位置は動かさない）
 *  3. ほぼ一直線なら直線、そうでなければ Schneider 法で最小限の 3次ベジェに当てはめ
 *  4. 水平・垂直に近い直線はまっすぐにそろえる
 */
export type Pt = [number, number];

export interface FitOptions {
  smooth: number; // 平滑化の強さ（px）
  error: number; // 曲線の許容誤差（px）
  lineTol: number; // 直線とみなす最大のずれ（px）
  snapDeg: number; // 0 で無効
  shape: ShapeMode;
}

export type ShapeMode = 'smooth' | 'straight';

export type Seg =
  | { kind: 'L'; a: Pt; b: Pt }
  | { kind: 'C'; a: Pt; c1: Pt; c2: Pt; b: Pt };

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const norm = (a: Pt): Pt => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};

// ---------- 角の検出 ----------
function findCorners(p: Pt[], k: number, cosMax: number): number[] {
  const n = p.length;
  const turn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = sub(p[i], p[(i - k + n) % n]);
    const b = sub(p[(i + k) % n], p[i]);
    const c = dot(a, b) / ((len(a) * len(b)) || 1);
    turn[i] = c;
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] > cosMax) continue;
    let isMin = true;
    for (let j = -k; j <= k && isMin; j++) {
      if (j === 0) continue;
      const t = turn[(i + j + n) % n];
      if (t < turn[i] || (t === turn[i] && j < 0)) isMin = false;
    }
    if (isMin) out.push(i);
  }
  return out;
}

// ---------- 平滑化 ----------
function smoothOpen(p: Pt[], sigma: number): Pt[] {
  const n = p.length;
  if (sigma <= 0 || n < 3) return p;
  const R = Math.ceil(sigma * 2);
  const wts = Array.from({ length: R + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
  return p.map((q, i) => {
    const r = Math.min(R, i, n - 1 - i); // 対称な窓で端点を固定
    if (r === 0) return q;
    let sx = 0, sy = 0, sw = 0;
    for (let j = -r; j <= r; j++) {
      const w = wts[Math.abs(j)];
      sx += p[i + j][0] * w; sy += p[i + j][1] * w; sw += w;
    }
    return [sx / sw, sy / sw];
  });
}

function smoothClosed(p: Pt[], sigma: number): Pt[] {
  const n = p.length;
  if (sigma <= 0) return p;
  const R = Math.min(Math.ceil(sigma * 2), (n >> 1) - 1);
  const wts = Array.from({ length: R + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
  return p.map((_, i) => {
    let sx = 0, sy = 0, sw = 0;
    for (let j = -R; j <= R; j++) {
      const q = p[(i + j + n) % n], w = wts[Math.abs(j)];
      sx += q[0] * w; sy += q[1] * w; sw += w;
    }
    return [sx / sw, sy / sw];
  });
}

// ---------- Schneider の曲線当てはめ ----------
const bez = (c: Pt[], t: number): Pt => {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, cc = 3 * mt * t * t, d = t * t * t;
  return [a * c[0][0] + b * c[1][0] + cc * c[2][0] + d * c[3][0], a * c[0][1] + b * c[1][1] + cc * c[2][1] + d * c[3][1]];
};

function chordParams(p: Pt[]): number[] {
  const u = [0];
  for (let i = 1; i < p.length; i++) u.push(u[i - 1] + len(sub(p[i], p[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generateBezier(p: Pt[], u: number[], t1: Pt, t2: Pt): Pt[] {
  const first = p[0], last = p[p.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < p.length; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const a1 = mul(t1, b1), a2 = mul(t2, b2);
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2);
    const tmp = sub(p[i], add(mul(first, b0 + b1), mul(last, b2 + b3)));
    x0 += dot(a1, tmp); x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let ar = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const segLen = len(sub(last, first));
  const eps = 1e-6 * segLen;
  if (al < eps || ar < eps) al = ar = segLen / 3;
  return [first, add(first, mul(t1, al)), add(last, mul(t2, ar)), last];
}

function maxError(p: Pt[], c: Pt[], u: number[]): [number, number] {
  let md = 0, mi = (p.length / 2) | 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = sub(bez(c, u[i]), p[i]);
    const dd = dot(d, d);
    if (dd >= md) { md = dd; mi = i; }
  }
  return [md, mi];
}

function reparam(p: Pt[], c: Pt[], u: number[]): number[] {
  const d1 = [mul(sub(c[1], c[0]), 3), mul(sub(c[2], c[1]), 3), mul(sub(c[3], c[2]), 3)];
  const d2 = [mul(sub(d1[1], d1[0]), 2), mul(sub(d1[2], d1[1]), 2)];
  return u.map((t, i) => {
    const mt = 1 - t;
    const q = bez(c, t);
    const q1: Pt = [mt * mt * d1[0][0] + 2 * mt * t * d1[1][0] + t * t * d1[2][0], mt * mt * d1[0][1] + 2 * mt * t * d1[1][1] + t * t * d1[2][1]];
    const q2: Pt = [mt * d2[0][0] + t * d2[1][0], mt * d2[0][1] + t * d2[1][1]];
    const diff = sub(q, p[i]);
    const den = dot(q1, q1) + dot(diff, q2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.min(1, Math.max(0, t - dot(diff, q1) / den));
  });
}

function fitCubic(p: Pt[], t1: Pt, t2: Pt, err: number, out: Seg[], depth = 0) {
  const n = p.length;
  if (n === 2 || depth > 12) {
    const d = len(sub(p[n - 1], p[0])) / 3;
    out.push({ kind: 'C', a: p[0], c1: add(p[0], mul(t1, d)), c2: add(p[n - 1], mul(t2, d)), b: p[n - 1] });
    return;
  }
  let u = chordParams(p);
  let c = generateBezier(p, u, t1, t2);
  let [e, split] = maxError(p, c, u);
  const err2 = err * err;
  if (e < err2) {
    out.push({ kind: 'C', a: c[0], c1: c[1], c2: c[2], b: c[3] });
    return;
  }
  if (e < err2 * 4) {
    for (let i = 0; i < 4; i++) {
      u = reparam(p, c, u);
      c = generateBezier(p, u, t1, t2);
      [e, split] = maxError(p, c, u);
      if (e < err2) {
        out.push({ kind: 'C', a: c[0], c1: c[1], c2: c[2], b: c[3] });
        return;
      }
    }
  }
  split = Math.max(1, Math.min(n - 2, split));
  const tc = norm(sub(p[split - 1], p[split + 1]));
  fitCubic(p.slice(0, split + 1), t1, tc, err, out, depth + 1);
  fitCubic(p.slice(split), mul(tc, -1), t2, err, out, depth + 1);
}

function tangentAt(p: Pt[], fromStart: boolean): Pt {
  const n = p.length;
  const k = Math.min(n - 1, Math.max(1, Math.round(n / 6)), 6);
  return fromStart ? norm(sub(p[k], p[0])) : norm(sub(p[n - 1 - k], p[n - 1]));
}

function lineDeviation(p: Pt[]): number {
  const a = p[0], b = p[p.length - 1];
  const d = sub(b, a);
  const l = len(d) || 1;
  let m = 0;
  for (const q of p) m = Math.max(m, Math.abs(d[1] * (q[0] - a[0]) - d[0] * (q[1] - a[1])) / l);
  return m;
}

function rdp(p: Pt[], eps: number): Pt[] {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const d = sub(p[e], p[s]);
    const l = len(d) || 1;
    let md = 0, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const dd = Math.abs(d[1] * (p[i][0] - p[s][0]) - d[0] * (p[i][1] - p[s][1])) / l;
      if (dd > md) { md = dd; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return p.filter((_, i) => keep[i]);
}

function fitPiece(p: Pt[], opt: FitOptions, out: Seg[]) {
  if (p.length < 3 || lineDeviation(p) <= opt.lineTol) {
    out.push({ kind: 'L', a: p[0], b: p[p.length - 1] });
    return;
  }
  if (opt.shape === 'straight') {
    const q = rdp(p, opt.lineTol);
    for (let i = 0; i + 1 < q.length; i++) out.push({ kind: 'L', a: q[i], b: q[i + 1] });
    return;
  }
  fitCubic(p, tangentAt(p, true), tangentAt(p, false), opt.error, out);
}

// ---------- 水平・垂直にそろえる ----------
function snap(segs: Seg[], deg: number) {
  if (deg <= 0) return;
  const tan = Math.tan((deg * Math.PI) / 180);
  const n = segs.length;
  const shift = (s: Seg, which: 'a' | 'b', v: Pt) => {
    const old = s[which];
    const delta = sub(v, old);
    s[which] = v;
    if (s.kind === 'C') {
      if (which === 'a') s.c1 = add(s.c1, delta);
      else s.c2 = add(s.c2, delta);
    }
  };
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    if (s.kind !== 'L') continue;
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    if (Math.hypot(dx, dy) < 3) continue;
    let na: Pt | null = null, nb: Pt | null = null;
    if (Math.abs(dy) <= Math.abs(dx) * tan) {
      const y = (s.a[1] + s.b[1]) / 2;
      na = [s.a[0], y]; nb = [s.b[0], y];
    } else if (Math.abs(dx) <= Math.abs(dy) * tan) {
      const x = (s.a[0] + s.b[0]) / 2;
      na = [x, s.a[1]]; nb = [x, s.b[1]];
    }
    if (!na || !nb) continue;
    const prev = segs[(i - 1 + n) % n], next = segs[(i + 1) % n];
    shift(s, 'a', na);
    shift(prev, 'b', na);
    shift(s, 'b', nb);
    shift(next, 'a', nb);
  }
}

/** 1本の閉じた輪郭を区間リストに */
export function fitLoop(raw: Pt[], opt: FitOptions): Seg[] {
  const n = raw.length;
  const k = Math.max(3, Math.round(opt.smooth * 1.5 + 2));
  const segs: Seg[] = [];
  if (n < 2 * k + 2) {
    // 小さな島はそのまま多角形
    const s = smoothClosed(raw, Math.min(opt.smooth, 1));
    for (let i = 0; i < s.length; i++) segs.push({ kind: 'L', a: s[i], b: s[(i + 1) % s.length] });
    return segs;
  }
  const corners = findCorners(raw, k, 0.6);
  if (corners.length === 0 && opt.shape === 'straight') {
    const s = smoothClosed(raw, opt.smooth);
    const q = rdp([...s, s[0]], opt.lineTol);
    for (let i = 0; i + 1 < q.length; i++) segs.push({ kind: 'L', a: q[i], b: q[i + 1] });
    snap(segs, opt.snapDeg);
    return segs;
  }
  if (corners.length === 0) {
    // 角のない形（円など）：閉じたまま平滑化して、4分割で当てはめ
    const s = smoothClosed(raw, opt.smooth);
    const m = s.length;
    for (let j = 0; j < 4; j++) {
      const from = Math.floor((j * m) / 4), to = Math.floor(((j + 1) * m) / 4);
      const piece: Pt[] = [];
      for (let i = from; i <= to; i++) piece.push(s[i % m]);
      const t1 = norm(sub(s[(from + 1) % m], s[(from - 1 + m) % m]));
      const t2 = norm(sub(s[(to - 1 + m) % m], s[(to + 1) % m]));
      fitCubic(piece, t1, t2, opt.error, segs);
    }
    return segs;
  }
  for (let c = 0; c < corners.length; c++) {
    const from = corners[c];
    const to = corners[(c + 1) % corners.length];
    const piece: Pt[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      piece.push(raw[i]);
      if (i === to && piece.length > 1) break;
      if (piece.length > n + 1) break;
    }
    fitPiece(smoothOpen(piece, opt.smooth), opt, segs);
  }
  snap(segs, opt.snapDeg);
  return segs;
}

export function segsToPath(segs: Seg[], S: (p: Pt) => string): string {
  if (!segs.length) return '';
  let d = 'M' + S(segs[0].a);
  for (const s of segs) d += s.kind === 'L' ? 'L' + S(s.b) : 'C' + S(s.c1) + ' ' + S(s.c2) + ' ' + S(s.b);
  return d + 'Z';
}

