import type { Layer } from './build';

export interface LayerStats {
  key: string;
  areaPct: number; // 縫う範囲全体に対する割合
  bbox: [number, number, number, number]; // 画像に対する % (x0, y0, x1, y1)
  islands: number;
  rectangularity: number; // 1 に近いほど長方形（島の面積 ÷ 最小外接矩形の面積、面積で加重）
  nextToBackground: number; // 輪郭のうち背景（縫わない色）に接している割合
}

/** 島ごとの最小外接矩形の面積（画素の四隅で評価、3°刻み） */
function minRectArea(xs: number[], ys: number[]): number {
  let best = Infinity;
  for (let deg = 0; deg < 90; deg += 3) {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      for (let k = 0; k < 4; k++) {
        const x = xs[i] + (k & 1), y = ys[i] + (k >> 1);
        const u = x * c + y * s, v = -x * s + y * c;
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
    }
    best = Math.min(best, (u1 - u0) * (v1 - v0));
  }
  return best;
}

export function analyzeLayers(labels: Uint8Array, w: number, h: number, layers: Layer[], minArea: number): LayerStats[] {
  const layerOf = new Int16Array(256).fill(-1);
  layers.forEach((l, i) => l.members.forEach((m) => (layerOf[m] = i)));
  const L = new Int16Array(labels.length);
  let fgTotal = 0;
  for (let p = 0; p < labels.length; p++) {
    L[p] = layerOf[labels[p]];
    if (L[p] >= 0 && layers[L[p]].visible) fgTotal++;
  }
  const stats = layers.map((l) => ({
    key: l.key, count: 0, x0: w, y0: h, x1: 0, y1: 0, islands: 0, rectSum: 0, rectW: 0, edge: 0, edgeBg: 0,
  }));
  const seen = new Uint8Array(labels.length);
  const xs: number[] = [], ys: number[] = [];
  for (let s = 0; s < labels.length; s++) {
    if (seen[s] || L[s] < 0) continue;
    const id = L[s];
    const st = stats[id];
    xs.length = 0; ys.length = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p / w) | 0;
      xs.push(x); ys.push(y);
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0) continue;
        if (L[q] === id) {
          if (!seen[q]) { seen[q] = 1; stack.push(q); }
        } else {
          st.edge++;
          if (L[q] < 0 || !layers[L[q]].visible) st.edgeBg++;
        }
      }
    }
    st.count += xs.length;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < st.x0) st.x0 = xs[i];
      if (xs[i] + 1 > st.x1) st.x1 = xs[i] + 1;
      if (ys[i] < st.y0) st.y0 = ys[i];
      if (ys[i] + 1 > st.y1) st.y1 = ys[i] + 1;
    }
    if (xs.length >= minArea) {
      st.islands++;
      st.rectSum += (xs.length / minRectArea(xs, ys)) * xs.length;
      st.rectW += xs.length;
    }
  }
  const pct = (v: number, d: number) => Math.round((v / d) * 1000) / 10;
  return stats.map((st) => ({
    key: st.key,
    areaPct: fgTotal ? pct(st.count, fgTotal) : 0,
    bbox: st.count ? [pct(st.x0, w), pct(st.y0, h), pct(st.x1, w), pct(st.y1, h)] : [0, 0, 0, 0],
    islands: st.islands,
    rectangularity: st.rectW ? Math.round((st.rectSum / st.rectW) * 100) / 100 : 0,
    nextToBackground: st.edge ? Math.round((st.edgeBg / st.edge) * 100) / 100 : 0,
  }));
}

/** 長方形に近い小さな色は自動で「四角」にする */
export function autoShapes(layers: Layer[], stats: LayerStats[]): Layer[] {
  return layers.map((l, i) => {
    const s = stats[i];
    if (!l.visible || l.shape !== 'smooth') return l;
    if (s.islands >= 1 && s.islands <= 6 && s.rectangularity >= 0.9 && s.areaPct < 12) return { ...l, shape: 'rect' };
    return l;
  });
}
