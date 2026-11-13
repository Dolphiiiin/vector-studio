type Pt = [number, number];

/** 2パスのチャンファー距離変換（3-4）。mask 内側の各画素について外側までの距離(px)を返す */
function distance(mask: Uint8Array, w: number, h: number, inside: boolean): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = (mask[i] === 1) === inside ? INF : 0;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - w] + a);
        if (x > 0) v = Math.min(v, d[i - w - 1] + b);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + a);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (x > 0) v = Math.min(v, d[i + w - 1] + b);
      }
      d[i] = v;
    }
  return d;
}

/** 正で太らせる（重なりを作る）、負で細らせる（すき間を作る） */
export function offsetMask(mask: Uint8Array, w: number, h: number, px: number): Uint8Array {
  if (Math.abs(px) < 0.25) return mask;
  const out = new Uint8Array(mask.length);
  if (px > 0) {
    const d = distance(mask, w, h, false);
    for (let i = 0; i < d.length; i++) out[i] = d[i] <= px ? 1 : 0;
  } else {
    const d = distance(mask, w, h, true);
    for (let i = 0; i < d.length; i++) out[i] = d[i] > -px ? 1 : 0;
  }
  return out;
}

/** 外周に接していない穴（＝他の色に囲まれた部分）を返す */
export function enclosedHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(mask.length);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!mask[i] && !outside[i]) { outside[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  const holes = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) holes[i] = !mask[i] && !outside[i] ? 1 : 0;
  return holes;
}

/**
 * 画素の境界をたどって閉じた輪郭を作る。内側が常に進行方向の右になる向き。
 * 頂点は (w+1)x(h+1) の格子点。
 */
function traceLoops(mask: Uint8Array, w: number, h: number): Pt[][] {
  const W = w + 1;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  // 各頂点から出るエッジ（最大2本）。方向 0:右 1:下 2:左 3:上
  const out = new Map<number, number[]>();
  const add = (x: number, y: number, dir: number) => {
    const key = y * W + x;
    const arr = out.get(key);
    if (arr) arr.push(dir); else out.set(key, [dir]);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!inside(x, y - 1)) add(x, y, 0);
      if (!inside(x + 1, y)) add(x + 1, y, 1);
      if (!inside(x, y + 1)) add(x + 1, y + 1, 2);
      if (!inside(x - 1, y)) add(x, y + 1, 3);
    }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const loops: Pt[][] = [];
  for (const [startKey, dirs] of out) {
    while (dirs.length) {
      let dir = dirs.pop()!;
      let key = startKey;
      const loop: Pt[] = [];
      for (let guard = 0; guard < 4 * w * h + 8; guard++) {
        const x = key % W, y = (key / W) | 0;
        // 辺の中点を頂点にする（階段状のギザギザが斜線になる）
        loop.push([x + DX[dir] / 2, y + DY[dir] / 2]);
        key = (y + DY[dir]) * W + (x + DX[dir]);
        if (key === startKey) break;
        const next = out.get(key);
        if (!next || next.length === 0) break;
        // 鞍点では右折を優先（斜めに接する画素を別の島として扱う）
        let pick = 0;
        if (next.length > 1) {
          const right = (dir + 1) % 4;
          const idx = next.indexOf(right);
          pick = idx >= 0 ? idx : 0;
        }
        dir = next.splice(pick, 1)[0];
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [x1, y1] = pts[s], [x2, y2] = pts[e];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let md = 0, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const dd = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (dd > md) { md = dd; mi = i; }
    }
    if (md > eps && mi > 0) {
      keep[mi] = 1;
      stack.push([s, mi], [mi, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyClosed(loop: Pt[], eps: number): Pt[] {
  // 最も離れた2点で分割してから RDP
  let far = 0, fd = 0;
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = rdp(loop.slice(0, far + 1), eps);
  const b = rdp([...loop.slice(far), loop[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function area(loop: Pt[]) {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

function loopToPath(p: Pt[], scale: number, ox: number, oy: number, curve: boolean): string {
  const n = p.length;
  const S = (q: Pt) => `${fmt((q[0] - ox) * scale)} ${fmt((q[1] - oy) * scale)}`;
  if (!curve || n < 4) return 'M' + p.map(S).join('L') + 'Z';
  // 角度が急な点は角として残し、それ以外は Catmull-Rom を 3次ベジェに
  const corner = p.map((c, i) => {
    const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
    const v1x = c[0] - a[0], v1y = c[1] - a[1], v2x = b[0] - c[0], v2y = b[1] - c[1];
    const cos = (v1x * v2x + v1y * v2y) / ((Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)) || 1);
    return cos < 0.55; // 約57°以上曲がる点
  });
  let d = 'M' + S(p[0]);
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    const t = 1 / 6;
    const c1: Pt = corner[i] ? p1 : [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2: Pt = corner[(i + 1) % n] ? p2 : [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    if (corner[i] && corner[(i + 1) % n]) d += 'L' + S(p2);
    else d += 'C' + S(c1) + ' ' + S(c2) + ' ' + S(p2);
  }
  return d + 'Z';
}

export interface TraceOptions {
  originX: number;
  originY: number;
  simplify: number; // px
  curve: boolean;
  minLoopArea: number; // px²
}

export function maskToPath(mask: Uint8Array, w: number, h: number, scale: number, opt: TraceOptions): string {
  const loops = traceLoops(mask, w, h);
  let d = '';
  for (const loop of loops) {
    if (Math.abs(area(loop)) < opt.minLoopArea) continue;
    const s = simplifyClosed(loop, opt.simplify);
    if (s.length < 3) continue;
    d += loopToPath(s, scale, opt.originX, opt.originY, opt.curve);
  }
  return d;
}
