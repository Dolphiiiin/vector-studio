/**
 * 輪郭 1 本に「いちばん単純で十分に合う図形」を当てはめる。
 *
 * 候補を単純な順に試す：長方形 → 角丸長方形 → 楕円 → 頂点の少ない多角形 → 曲線。
 * 元の輪郭との差（XOR 画素数 ÷ 周長 ＝ 平均のずれ px）が許容値以下になった最初の候補を採用。
 * 多角形は各辺に直線を当てはめ、隣の直線との交点を角にするので角がシャープになる。
 */
import { fitLoop, type FitOptions, type Pt, type Seg } from './fit';

export type ShapeMode = 'auto' | 'rect' | 'straight' | 'smooth';

export interface RectPrim {
  kind: 'rect';
  cx: number; cy: number; w: number; h: number; th: number; r: number;
  hole?: boolean;
}
export interface EllipsePrim {
  kind: 'ellipse';
  cx: number; cy: number; a: number; b: number; th: number;
}
export interface PathPrim {
  kind: 'path';
  segs: Seg[];
}
export type Prim = RectPrim | EllipsePrim | PathPrim;

export interface ShapeOptions {
  tol: number; // 許容する平均のずれ（px）
  snapDeg: number;
  smooth: FitOptions; // 曲線にするときの設定
}

// ---------- 基本 ----------
const len = (x: number, y: number) => Math.hypot(x, y);

function polyArea(p: Pt[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function perimeter(p: Pt[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += len(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

/** 画素中心で塗りつぶし判定するスキャンライン塗り */
function raster(poly: Pt[], x0: number, y0: number, W: number, H: number, out: Uint8Array) {
  out.fill(0);
  const xs: number[] = [];
  for (let row = 0; row < H; row++) {
    const y = y0 + row + 0.5;
    xs.length = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5 - x0));
      const to = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5 - x0));
      for (let c = from; c <= to; c++) out[row * W + c] = 1;
    }
  }
}

/** 元の輪郭の点が候補の線から最大どれだけ離れているか */
function maxDeviation(raw: Pt[], poly: Pt[]): number {
  let worst = 0;
  for (let i = 0; i < raw.length; i += 2) {
    const [px, py] = raw[i];
    let best = Infinity;
    for (let j = 0; j < poly.length; j++) {
      const a = poly[j], b = poly[(j + 1) % poly.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
      const d = Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

class Scorer {
  private x0: number; private y0: number; private W: number; private H: number;
  private target: Uint8Array; private buf: Uint8Array; private per: number;
  private raw: Pt[];
  private maxTol: number;
  constructor(raw: Pt[], maxTol = Infinity) {
    this.raw = raw;
    this.maxTol = maxTol;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of raw) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const m = 6;
    this.x0 = Math.floor(minX) - m; this.y0 = Math.floor(minY) - m;
    this.W = Math.ceil(maxX) - this.x0 + m; this.H = Math.ceil(maxY) - this.y0 + m;
    this.target = new Uint8Array(this.W * this.H);
    this.buf = new Uint8Array(this.W * this.H);
    raster(raw, this.x0, this.y0, this.W, this.H, this.target);
    this.per = Math.max(1, perimeter(raw));
  }
  /** 平均のずれ（px）。枠からはみ出した分は大きな誤差として数える */
  score(poly: Pt[]): number {
    raster(poly, this.x0, this.y0, this.W, this.H, this.buf);
    let diff = 0;
    for (let i = 0; i < this.buf.length; i++) if (this.buf[i] !== this.target[i]) diff++;
    let outside = 0;
    for (const [x, y] of poly) {
      if (x < this.x0 || y < this.y0 || x > this.x0 + this.W || y > this.y0 + this.H) outside++;
    }
    const mean = diff / this.per + outside * 10;
    // 平均は良くても一部で大きく外れる候補は不合格（大きな形の角を切り落とさない）
    if (this.maxTol < Infinity && maxDeviation(this.raw, poly) > this.maxTol) return mean + 1000;
    return mean;
  }
}

// ---------- 長方形・楕円（モーメントから） ----------
function moments(p: Pt[]) {
  let A = 0, cx = 0, cy = 0, xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
    const c = x0 * y1 - x1 * y0;
    A += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    xx += (x0 * x0 + x0 * x1 + x1 * x1) * c;
    yy += (y0 * y0 + y0 * y1 + y1 * y1) * c;
    xy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c;
  }
  A /= 2;
  cx /= 6 * A; cy /= 6 * A;
  return { A: Math.abs(A), cx, cy, vx: xx / 12 / A - cx * cx, vy: yy / 12 / A - cy * cy, vxy: xy / 24 / A - cx * cy };
}

function minAreaAngle(p: Pt[]): number {
  let th = 0, best = Infinity;
  for (let deg = 0; deg < 90; deg += 1) {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of p) {
      const u = x * c + y * s, v = -x * s + y * c;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const a = (u1 - u0) * (v1 - v0);
    if (a < best - 1e-9) { best = a; th = r; }
  }
  return th > Math.PI / 4 ? th - Math.PI / 2 : th;
}

function snapAngle(th: number, snapDeg: number) {
  const q = Math.round(th / (Math.PI / 2)) * (Math.PI / 2);
  return Math.abs(th - q) <= (snapDeg * Math.PI) / 180 ? q : th;
}

function rectFrom(p: Pt[], snapDeg: number): RectPrim {
  const m = moments(p);
  const th = snapAngle(minAreaAngle(p), snapDeg);
  const c = Math.cos(th), s = Math.sin(th);
  const vu = m.vx * c * c + 2 * m.vxy * c * s + m.vy * s * s;
  const vv = m.vx * s * s - 2 * m.vxy * c * s + m.vy * c * c;
  return { kind: 'rect', cx: m.cx, cy: m.cy, w: Math.sqrt(12 * Math.max(vu, 0)), h: Math.sqrt(12 * Math.max(vv, 0)), th, r: 0 };
}

function ellipseFrom(p: Pt[], snapDeg: number): EllipsePrim {
  const m = moments(p);
  let th = 0.5 * Math.atan2(2 * m.vxy, m.vx - m.vy);
  th = snapAngle(th, snapDeg);
  const c = Math.cos(th), s = Math.sin(th);
  const vu = m.vx * c * c + 2 * m.vxy * c * s + m.vy * s * s;
  const vv = m.vx * s * s - 2 * m.vxy * c * s + m.vy * c * c;
  return { kind: 'ellipse', cx: m.cx, cy: m.cy, a: 2 * Math.sqrt(Math.max(vu, 0)), b: 2 * Math.sqrt(Math.max(vv, 0)), th };
}

const rot = (cx: number, cy: number, th: number, u: number, v: number): Pt => [
  cx + u * Math.cos(th) - v * Math.sin(th),
  cy + u * Math.sin(th) + v * Math.cos(th),
];

/** 採点用の多角形（角丸・楕円は細かい折れ線で近似） */
export function primPolygon(p: RectPrim | EllipsePrim): Pt[] {
  if (p.kind === 'ellipse') {
    return Array.from({ length: 48 }, (_, i) => {
      const t = (i / 48) * Math.PI * 2;
      return rot(p.cx, p.cy, p.th, p.a * Math.cos(t), p.b * Math.sin(t));
    });
  }
  const hw = p.w / 2, hh = p.h / 2, r = Math.min(p.r, hw, hh);
  if (r <= 0.01) return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => rot(p.cx, p.cy, p.th, u, v));
  const out: Pt[] = [];
  const corners: [number, number, number][] = [[hw - r, -hh + r, -Math.PI / 2], [hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2], [-hw + r, -hh + r, Math.PI]];
  for (const [ux, uy, a0] of corners) {
    for (let k = 0; k <= 6; k++) {
      const a = a0 + (k / 6) * (Math.PI / 2);
      out.push(rot(p.cx, p.cy, p.th, ux + r * Math.cos(a), uy + r * Math.sin(a)));
    }
  }
  return out;
}

/** 出力用の区間（角丸・楕円は 3 次ベジェで正確に） */
export function primSegs(p: Prim): Seg[] {
  if (p.kind === 'path') return p.segs;
  const K = 0.5523;
  if (p.kind === 'ellipse') {
    const P = (u: number, v: number) => rot(p.cx, p.cy, p.th, u, v);
    const { a, b } = p;
    return [
      { kind: 'C', a: P(a, 0), c1: P(a, b * K), c2: P(a * K, b), b: P(0, b) },
      { kind: 'C', a: P(0, b), c1: P(-a * K, b), c2: P(-a, b * K), b: P(-a, 0) },
      { kind: 'C', a: P(-a, 0), c1: P(-a, -b * K), c2: P(-a * K, -b), b: P(0, -b) },
      { kind: 'C', a: P(0, -b), c1: P(a * K, -b), c2: P(a, -b * K), b: P(a, 0) },
    ];
  }
  const hw = p.w / 2, hh = p.h / 2, r = Math.min(p.r, hw, hh);
  const P = (u: number, v: number) => rot(p.cx, p.cy, p.th, u, v);
  if (r <= 0.01) {
    const c = [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)];
    return c.map((pt, i) => ({ kind: 'L' as const, a: pt, b: c[(i + 1) % 4] }));
  }
  const k = r * K;
  return [
    { kind: 'L', a: P(-hw + r, -hh), b: P(hw - r, -hh) },
    { kind: 'C', a: P(hw - r, -hh), c1: P(hw - r + k, -hh), c2: P(hw, -hh + r - k), b: P(hw, -hh + r) },
    { kind: 'L', a: P(hw, -hh + r), b: P(hw, hh - r) },
    { kind: 'C', a: P(hw, hh - r), c1: P(hw, hh - r + k), c2: P(hw - r + k, hh), b: P(hw - r, hh) },
    { kind: 'L', a: P(hw - r, hh), b: P(-hw + r, hh) },
    { kind: 'C', a: P(-hw + r, hh), c1: P(-hw + r - k, hh), c2: P(-hw, hh - r + k), b: P(-hw, hh - r) },
    { kind: 'L', a: P(-hw, hh - r), b: P(-hw, -hh + r) },
    { kind: 'C', a: P(-hw, -hh + r), c1: P(-hw, -hh + r - k), c2: P(-hw + r - k, -hh), b: P(-hw + r, -hh) },
  ];
}

// ---------- 多角形 ----------
function rdpIdx(p: Pt[], s: number, e: number, eps: number, keep: Uint8Array) {
  const stack: [number, number][] = [[s, e]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const dx = p[b][0] - p[a][0], dy = p[b][1] - p[a][1];
    const l = len(dx, dy) || 1;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (p[i][0] - p[a][0]) - dx * (p[i][1] - p[a][1])) / l;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
}

/** 閉じた輪郭を eps で単純化し、頂点の添字を返す */
function simplifyIdx(p: Pt[], eps: number): number[] {
  const n = p.length;
  let far = 0, fd = 0;
  for (let i = 1; i < n; i++) {
    const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const ext = [...p, p[0]];
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  rdpIdx(ext, 0, far, eps, keep);
  rdpIdx(ext, far, n, eps, keep);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return idx;
}

/** 辺ごとに直線を当てはめ、隣の直線との交点を角にする。水平・垂直に近い辺はそろえる */
function refinePolygon(p: Pt[], idx: number[], snapDeg: number): Pt[] {
  const n = p.length, k = idx.length;
  const lines = idx.map((from, j) => {
    const to = idx[(j + 1) % k];
    const pts: Pt[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      pts.push(p[i]);
      if (i === to) break;
    }
    let mx = 0, my = 0;
    for (const q of pts) { mx += q[0]; my += q[1]; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const q of pts) {
      const dx = q[0] - mx, dy = q[1] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    th = snapAngle(th, snapDeg);
    return { mx, my, dx: Math.cos(th), dy: Math.sin(th), length: pts.length };
  });
  return idx.map((vi, j) => {
    const A = lines[(j - 1 + k) % k], B = lines[j];
    const den = A.dx * B.dy - A.dy * B.dx;
    if (Math.abs(den) < 0.25) return p[vi];
    const t = ((B.mx - A.mx) * B.dy - (B.my - A.my) * B.dx) / den;
    const q: Pt = [A.mx + A.dx * t, A.my + A.dy * t];
    // 交点が元の角から離れすぎたら使わない
    return len(q[0] - p[vi][0], q[1] - p[vi][1]) > 6 ? p[vi] : q;
  });
}

function polySegs(poly: Pt[]): Seg[] {
  return poly.map((pt, i) => ({ kind: 'L' as const, a: pt, b: poly[(i + 1) % poly.length] }));
}

function polygonCandidates(p: Pt[], snapDeg: number): Pt[][] {
  const out: Pt[][] = [];
  let lastK = -1;
  for (const eps of [8, 6, 4.5, 3.5, 2.5, 1.8, 1.2, 0.8]) {
    const idx = simplifyIdx(p, eps);
    if (idx.length < 3 || idx.length === lastK) continue;
    lastK = idx.length;
    out.push(refinePolygon(p, idx, snapDeg));
  }
  return out;
}

// ---------- 選択 ----------
export function fitShape(raw: Pt[], mode: ShapeMode, opt: ShapeOptions): Prim {
  const area = Math.abs(polyArea(raw));
  const tol = opt.tol;
  const scorer = new Scorer(raw, Math.max(2.5, tol * 2.2));

  const rect = rectFrom(raw, opt.snapDeg);
  if (polyArea(raw) < 0) rect.hole = true;
  if (mode === 'rect') return rect;
  if (mode === 'smooth') return { kind: 'path', segs: fitLoop(raw, opt.smooth) };

  const polys = polygonCandidates(raw, opt.snapDeg);
  if (mode === 'straight') {
    let best = polys[polys.length - 1], bestS = Infinity;
    for (const poly of polys) {
      const s = scorer.score(poly);
      if (s <= tol) return { kind: 'path', segs: polySegs(poly) };
      if (s < bestS) { bestS = s; best = poly; }
    }
    return best ? { kind: 'path', segs: polySegs(best) } : rect;
  }

  // 自動：単純な順に試す
  type Cand = { prim: Prim; poly: Pt[] };
  const cands: Cand[] = [];
  cands.push({ prim: rect, poly: primPolygon(rect) });
  const short = Math.min(rect.w, rect.h);
  for (const f of [0.15, 0.3, 0.5]) {
    const rr: RectPrim = { ...rect, r: short * f };
    cands.push({ prim: rr, poly: primPolygon(rr) });
  }
  const el = ellipseFrom(raw, opt.snapDeg);
  cands.push({ prim: el, poly: primPolygon(el) });
  // 小さすぎる島は単純図形だけで十分
  if (area > 30) for (const poly of polys) cands.push({ prim: { kind: 'path', segs: polySegs(poly) }, poly });

  let best: Cand | null = null, bestS = Infinity;
  for (const c of cands) {
    const s = scorer.score(c.poly);
    if (s <= tol) return c.prim;
    if (s < bestS) { bestS = s; best = c; }
  }
  // どれも合わなければ曲線と比べて良い方
  const smooth = fitLoop(raw, opt.smooth);
  return best && bestS <= tol * 1.6 ? best.prim : { kind: 'path', segs: smooth };
}

/** 大きさがほぼ同じ長方形（両目・両ほっぺなど）をそろえる */
export function alignRects(prims: Prim[]) {
  const rects = prims.filter((p): p is RectPrim => p.kind === 'rect' && !p.hole && Math.abs(p.th) < 1e-6);
  const parent = rects.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const near = (x: number, y: number) => Math.abs(x - y) <= 0.15 * Math.max(x, y);
      // 離れて並ぶ同じ大きさの四角だけ（重なっているものは別物）
      const apart = Math.abs(a.cx - b.cx) > (a.w + b.w) / 2 || Math.abs(a.cy - b.cy) > (a.h + b.h) / 2;
      if (apart && near(a.w, b.w) && near(a.h, b.h) && Math.abs(a.r - b.r) < 1) parent[find(i)] = find(j);
    }
  const groups = new Map<number, RectPrim[]>();
  rects.forEach((r, i) => {
    const g = find(i);
    groups.set(g, [...(groups.get(g) ?? []), r]);
  });
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const w = g.reduce((s, r) => s + r.w, 0) / g.length;
    const h = g.reduce((s, r) => s + r.h, 0) / g.length;
    for (const r of g) { r.w = w; r.h = h; }
    // 高さがほぼ同じものは同じ行にそろえる
    const cys = g.map((r) => {
      const row = g.filter((o) => Math.abs(o.cy - r.cy) <= 0.12 * h);
      return row.reduce((s, o) => s + o.cy, 0) / row.length;
    });
    g.forEach((r, i) => (r.cy = cys[i]));
  }
}
