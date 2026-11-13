import type { ShapeMode } from './fit';
import { enclosedHoles, maskToPath, offsetMask } from './trace';

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
  underlay: boolean;
}

export interface BuildOptions {
  sizeMm: number; // 長辺の仕上がり寸法
  overlapMm: number; // 上の色を下の色へ重ねる幅
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
  const r = Math.min(2, Math.round(opt.cleanup));
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

  const built = layers.map((layer, i): BuiltLayer => {
    if (!layer.visible) return { key: layer.key, d: '', areaMm2: 0 };
    let mask: Uint8Array = new Uint8Array(labels.length);
    for (let p = 0; p < labels.length; p++) mask[p] = labels[p] === i ? 1 : 0;

    // 上に重なる色の下を埋める：指定時は全部、直線・四角にした色の下は常に
    const fillUnder = new Uint8Array(256);
    layers.forEach((o, j) => {
      if (j > i && o.visible && (layer.underlay || o.shape !== 'smooth')) fillUnder[j] = 1;
    });
    if (fillUnder.some((v) => v)) {
      // 穴ひとつ全体が対象の色だけでできているときに埋める（外枠が顔全体を埋めないように）
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
          if (!fillUnder[labels[q]]) ok = false;
          const x = q % w;
          for (const r of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w]) {
            if (r >= 0 && r < labels.length && holes[r] && !seen[r]) { seen[r] = 1; st.push(r); }
          }
        }
        if (ok) for (const q of comp) mask[q] = 1;
      }
    }

    const grow = (layer.mode === 'fill' ? opt.overlapMm : 0) + layer.offsetMm;
    if (grow > 0) {
      // 外形は崩さず、先に縫う色の側へだけ広げる
      const dil = offsetMask(mask, w, h, grow * pxPerMm);
      if (dil !== mask) {
        for (let p = 0; p < labels.length; p++) {
          const o = orderOf[labels[p]];
          if (dil[p] && o >= 0 && o < i) mask[p] = 1;
        }
      }
    } else if (grow < 0) {
      mask = offsetMask(mask, w, h, grow * pxPerMm);
    }

    let count = 0;
    for (let p = 0; p < mask.length; p++) count += mask[p];
    const d = maskToPath(mask, w, h, scale, {
      originX: x0,
      originY: y0,
      smooth: 0.6 + opt.cleanup * 0.9,
      error: 0.6 + opt.cleanup * 0.4,
      lineTol: 0.8 + opt.cleanup * 0.75,
      snapDeg: opt.snap ? 7 : 0,
      shape: layer.shape,
      minLoopArea: opt.minAreaPx,
    });
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
