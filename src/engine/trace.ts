import type { Pt } from './fit';

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
export function traceLoops(mask: Uint8Array, w: number, h: number): Pt[][] {
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

