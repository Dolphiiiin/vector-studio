import { segsToPath, type Pt } from './fit';
import { alignRects, fitShape, primSegs, type Prim, type ShapeMode } from './shapes';
import { enclosedHoles, offsetMask, traceLoops } from './trace';

export type StitchMode = 'fill' | 'line';

export interface Layer {
  key: string;
  members: number[]; // 結合されたクラスタ id
  hex: string;
  origHex: string;
  name?: string;
  visible: boolean;
  mode: StitchMode;
  shape: ShapeMode;
  offsetMm: number;
}

export interface BuildOptions {
  sizeMm: number; // 長辺の仕上がり寸法
  overlapMm: number; // 下の色を上の色の下へ広げる幅
  cleanup: number; // 0..3 形を整える強さ
  snap: boolean; // 水平・垂直にそろえる
  minAreaPx: number;
}

export interface BuiltLayer {
  key: string;
  d: string;
  areaMm2: number;
}

/** 円形の窓での多数決。トゲや欠けを消して境界をなめらかにする */
function majority(labels: Uint8Array, w: number, h: number, k: number, r: number) {
  const offs: number[][] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) offs.push([dx, dy]);
  const out = new Uint8Array(labels.length);
  const cnt = new Uint16Array(k + 1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      cnt.fill(0);
      for (const [dx, dy] of offs) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const v = labels[yy * w + xx];
        cnt[v === 255 ? k : v]++;
      }
      const self = labels[y * w + x];
      let best = self === 255 ? k : self, bc = cnt[best];
      for (let c = 0; c <= k; c++) if (cnt[c] > bc) { bc = cnt[c]; best = c; }
      out[y * w + x] = best === k ? 255 : best;
    }
  labels.set(out);
}

function loopArea(p: Pt[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** 穴ひとつ全体が後から縫う色だけでできていれば埋める（外枠が顔全体を埋めないように） */
function fillHolesUnder(mask: Uint8Array, labels: Uint8Array, w: number, h: number, up: Uint8Array) {
  const holes = enclosedHoles(mask, w, h);
  const seen = new Uint8Array(labels.length);
  const comp: number[] = [];
  for (let s0 = 0; s0 < labels.length; s0++) {
    if (!holes[s0] || seen[s0]) continue;
    comp.length = 0;
    let ok = true;
    const st = [s0];
    seen[s0] = 1;
    while (st.length) {
      const q = st.pop()!;
      comp.push(q);
      if (!up[labels[q]]) ok = false;
      const x = q % w;
      for (const r of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w]) {
        if (r >= 0 && r < labels.length && holes[r] && !seen[r]) { seen[r] = 1; st.push(r); }
      }
    }
    if (ok) for (const q of comp) mask[q] = 1;
  }
}

export interface BuildResult {
  layers: BuiltLayer[];
  widthMm: number;
  heightMm: number;
}

export function buildLayers(
  labels: Uint8Array,
  w: number,
  h: number,
  layers: Layer[],
  opt: BuildOptions,
): BuildResult {
  // 画素ごとのレイヤー番号。全色まとめて境界を均すので、色どうしにすき間ができない
  const layerOf = new Uint8Array(256).fill(255);
  layers.forEach((l, i) => l.members.forEach((m) => (layerOf[m] = i)));
  labels = labels.map((v) => layerOf[v]);
  const r = Math.min(1, Math.round(opt.cleanup));
  if (r > 0) majority(labels, w, h, layers.length, r);
  const orderOf = new Int16Array(256).fill(-1);
  layers.forEach((l, i) => {
    if (l.visible) orderOf[i] = i;
  });

  // 縫う色だけの外接矩形を仕上がり寸法に合わせる
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let p = 0; p < labels.length; p++) {
    if (orderOf[labels[p]] < 0) continue;
    const x = p % w, y = (p / w) | 0;
    if (x < x0) x0 = x;
    if (x >= x1) x1 = x + 1;
    if (y < y0) y0 = y;
    if (y >= y1) y1 = y + 1;
  }
  if (x1 <= x0) { x0 = 0; y0 = 0; x1 = w; y1 = h; }
  const scale = opt.sizeMm / Math.max(x1 - x0, y1 - y0);
  const pxPerMm = 1 / scale;

  const later = (i: number) => {
    const f = new Uint8Array(256);
    layers.forEach((o, j) => { if (j > i && o.visible) f[j] = 1; });
    return f;
  };

  // 1. 色ごとの範囲：下の色は、後から縫う色の下へ「重なり」の幅だけ広げ、囲んだ穴も埋める（重ね縫い）
  const masks = layers.map((layer, i) => {
    if (!layer.visible) return null;
    let mask: Uint8Array = new Uint8Array(labels.length);
    for (let p = 0; p < labels.length; p++) mask[p] = labels[p] === i ? 1 : 0;
    const up = later(i);
    const grow = (layer.mode === 'fill' ? opt.overlapMm : 0) + Math.max(0, layer.offsetMm);
    if (grow > 0) {
      const dil = offsetMask(mask, w, h, grow * pxPerMm);
      for (let p = 0; p < labels.length; p++) if (dil[p] && up[labels[p]]) mask[p] = 1;
    }
    if (layer.mode === 'fill') fillHolesUnder(mask, labels, w, h, up);
    if (layer.offsetMm < 0) mask = offsetMask(mask, w, h, layer.offsetMm * pxPerMm);
    return mask;
  });

  // 2. 輪郭ごとに、いちばん単純で十分に合う図形を当てはめる
  const shapeOpt = {
    tol: 0.5 + opt.cleanup * 0.45,
    minRadius: pxPerMm,
    snapDeg: opt.snap ? 7 : 0,
    smooth: {
      smooth: 0.6 + opt.cleanup * 0.9,
      error: 0.6 + opt.cleanup * 0.4,
      lineTol: 0.8 + opt.cleanup * 0.75,
      snapDeg: opt.snap ? 7 : 0,
      shape: 'smooth' as const,
    },
  };
  const prims: Prim[][] = masks.map((mask, i) => {
    if (!mask) return [];
    return traceLoops(mask, w, h)
      .filter((loop) => Math.abs(loopArea(loop)) >= opt.minAreaPx)
      .map((loop) => fitShape(loop, layers[i].shape, shapeOpt));
  });

  // 3. 大きさのそろった四角（両目など）をそろえる
  if (opt.snap) alignRects(prims.flat());

  const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
  const S = (q: Pt) => `${fmt((q[0] - x0) * scale)} ${fmt((q[1] - y0) * scale)}`;
  const built = layers.map((layer, i): BuiltLayer => {
    const mask = masks[i];
    if (!mask) return { key: layer.key, d: '', areaMm2: 0 };
    let count = 0;
    for (let p = 0; p < mask.length; p++) count += mask[p];
    const d = prims[i].map((pr) => segsToPath(primSegs(pr), S)).join('');
    return { key: layer.key, d, areaMm2: count * scale * scale };
  });
  return { layers: built, widthMm: (x1 - x0) * scale, heightMm: (y1 - y0) * scale };
}

export function toSvg(
  layers: Layer[],
  built: BuiltLayer[],
  wMm: number,
  hMm: number,
  lineWidthMm: number,
): string {
  let n = 0;
  const body = layers
    .map((l, i) => {
      const b = built[i];
      if (!l.visible || !b?.d) return '';
      const id = `color${String(++n).padStart(2, '0')}`;
      return l.mode === 'line'
        ? `  <path id="${id}" d="${b.d}" fill="none" stroke="${l.hex}" stroke-width="${lineWidthMm}" stroke-linejoin="round"/>`
        : `  <path id="${id}" d="${b.d}" fill="${l.hex}" fill-rule="evenodd"/>`;
    })
    .filter(Boolean)
    .join('\n');
  const W = Math.round(wMm * 100) / 100, H = Math.round(hMm * 100) / 100;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">
${body}
</svg>
`;
}
