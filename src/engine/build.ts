import { enclosedHoles, maskToPath, offsetMask } from './trace';

export type StitchMode = 'fill' | 'line';

export interface Layer {
  key: string;
  members: number[]; // 結合されたクラスタ id
  hex: string;
  origHex: string;
  visible: boolean;
  mode: StitchMode;
  offsetMm: number;
  underlay: boolean;
}

export interface BuildOptions {
  sizeMm: number; // 長辺の仕上がり寸法
  overlapMm: number; // 上の色を下の色へ重ねる幅
  simplify: number; // px
  curve: boolean;
  minAreaPx: number;
}

export interface BuiltLayer {
  key: string;
  d: string;
  areaMm2: number;
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
  // クラスタ → 縫い順
  const orderOf = new Int16Array(256).fill(-1);
  layers.forEach((l, i) => {
    if (l.visible) for (const m of l.members) orderOf[m] = i;
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
    const set = new Uint8Array(256);
    for (const m of layer.members) set[m] = 1;
    let mask: Uint8Array = new Uint8Array(labels.length);
    for (let p = 0; p < labels.length; p++) mask[p] = set[labels[p]];

    if (layer.underlay) {
      const holes = enclosedHoles(mask, w, h);
      for (let p = 0; p < labels.length; p++) if (holes[p] && orderOf[labels[p]] > i) mask[p] = 1;
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
      simplify: opt.simplify,
      curve: opt.curve,
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
