import { labToRgb, rgbToLab, toHex } from './color';

export interface QuantizeOptions {
  colors: number; // 目標色数
  shade: number; // 0..1 陰影の打ち消し強度（明度の重みを下げる）
  smooth: number; // 0..4 エッジ保持平滑化の回数
  minArea: number; // px。これより小さい島は周囲に吸収
  background: number; // 0 で無効。外周から背景を広げるときの隣接画素の色差しきい値
  flatten: boolean; // 同じ色味の濃淡（グラデーション・陰影）を 1 色にまとめる
  vivid: boolean; // 写真のくすみを取り、白・黒・鮮やかな色に寄せる
  details: boolean; // 毛筋・ステッチ線のような細く明るい線を別の色として残す
}

export interface Cluster {
  id: number;
  hex: string;
  count: number;
  background: boolean;
}

export interface QuantizeResult {
  width: number;
  height: number;
  labels: Uint8Array;
  clusters: Cluster[];
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lab 空間でのバイラテラルフィルタ（輪郭を残して布目・陰影の細かいムラを消す） */
function bilateral(L: Float32Array, A: Float32Array, B: Float32Array, w: number, h: number) {
  const r = 2;
  const sigmaS = 2, sigmaR = 9;
  const spatial: number[] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS)));
  const range = new Float32Array(2048);
  for (let i = 0; i < range.length; i++) range[i] = Math.exp(-i / (2 * sigmaR * sigmaR));
  const oL = new Float32Array(L.length), oA = new Float32Array(L.length), oB = new Float32Array(L.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l0 = L[i], a0 = A[i], b0 = B[i];
      let sw = 0, sl = 0, sa = 0, sb = 0, k = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++, k++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const j = yy * w + xx;
          const dl = L[j] - l0, da = A[j] - a0, db = B[j] - b0;
          const d2 = dl * dl + da * da + db * db;
          const wr = d2 >= 2048 ? 0 : range[d2 | 0];
          const wt = spatial[k] * wr;
          sw += wt; sl += L[j] * wt; sa += A[j] * wt; sb += B[j] * wt;
        }
      }
      oL[i] = sl / sw; oA[i] = sa / sw; oB[i] = sb / sw;
    }
  }
  L.set(oL); A.set(oA); B.set(oB);
}

/** 3x3 の多数決フィルタ（ジャギー・ノイズ除去） */
function modeFilter(labels: Uint8Array, w: number, h: number, k: number) {
  const out = new Uint8Array(labels.length);
  const counts = new Uint16Array(k);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      counts.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          counts[labels[yy * w + xx]]++;
        }
      }
      const self = labels[y * w + x];
      let best = self, bc = counts[self];
      for (let c = 0; c < k; c++) if (counts[c] > bc) { best = c; bc = counts[c]; }
      out[y * w + x] = bc >= 5 ? best : self;
    }
  }
  labels.set(out);
}

/** 小さな島を、最も多く接している隣の色に吸収させる */
function absorbSmall(labels: Uint8Array, w: number, h: number, k: number, minArea: number) {
  if (minArea <= 1) return;
  const seen = new Int32Array(labels.length).fill(-1);
  const stack = new Int32Array(labels.length);
  const comp: number[] = [];
  const neigh = new Uint32Array(k);
  let compId = 0;
  for (let s = 0; s < labels.length; s++) {
    if (seen[s] !== -1) continue;
    const lab = labels[s];
    let sp = 0;
    stack[sp++] = s;
    seen[s] = compId;
    comp.length = 0;
    neigh.fill(0);
    while (sp) {
      const p = stack[--sp];
      comp.push(p);
      const x = p % w, y = (p / w) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q < 0) continue;
        if (labels[q] === lab) {
          if (seen[q] === -1) { seen[q] = compId; stack[sp++] = q; }
        } else neigh[labels[q]]++;
      }
    }
    if (comp.length < minArea) {
      let best = -1, bc = 0;
      for (let c = 0; c < k; c++) if (neigh[c] > bc) { bc = neigh[c]; best = c; }
      if (best >= 0) for (const p of comp) labels[p] = best;
    }
    compId++;
  }
}

/**
 * 外周から、布地と同じ色味が続く範囲を背景にする。
 * 明度はほぼ無視するので、布に落ちた影（暗いが色味は布と同じ）も背景に含まれる。
 */
function growBackground(L: Float32Array, A: Float32Array, B: Float32Array, w: number, h: number, tol: number) {
  const bg = new Uint8Array(w * h);
  if (tol <= 0) return bg;
  const edge: number[] = [];
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1);
  const med = (arr: Float32Array) => {
    const v = edge.map((i) => arr[i]).sort((p, q) => p - q);
    return v[v.length >> 1];
  };
  const rL = med(L), rA = med(A), rB = med(B);
  const t2 = tol * tol;
  const ok = (i: number) => {
    const dl = (L[i] - rL) * 0.15, da = A[i] - rA, db = B[i] - rB;
    return dl * dl + da * da + db * db <= t2;
  };
  const stack: number[] = [];
  const push = (i: number) => { if (!bg[i] && ok(i)) { bg[i] = 1; stack.push(i); } };
  for (const i of edge) push(i);
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  // 2段目：布に落ちた濃い影。暗くなるほど色味も薄くなるので、布の色味を明るさに比例して弱めた色と比べる。
  // 布の背景から一定の距離までしか広げない（縁取りを越えて中まで入らないように）
  const maxDepth = Math.round(Math.max(w, h) * 0.05);
  const st2 = tol * 0.6;
  const shadow = (i: number) => {
    if (L[i] > rL * 0.85) return false;
    const f = Math.max(0, L[i]) / rL;
    const ea = A[i] - rA * f, eb = B[i] - rB * f;
    return ea * ea + eb * eb <= st2 * st2;
  };
  let front: number[] = [];
  for (let i = 0; i < bg.length; i++) if (bg[i]) front.push(i);
  for (let depth = 0; depth < maxDepth && front.length; depth++) {
    const next: number[] = [];
    for (const p of front) {
      const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !bg[q] && shadow(q)) { bg[q] = 1; next.push(q); }
      }
    }
    front = next;
  }
  return bg;
}

/**
 * 境目にだけできる細い色（2色の中間色のふち）を、隣の色に溶かす。
 * 色ごとに「境目の画素の割合」を見て、ほとんどが境目なら消す。
 */
function dissolveFringes(labels: Uint8Array, w: number, h: number, k: number, protect: number) {
  for (let pass = 0; pass < 2; pass++) {
    const area = new Uint32Array(k), edge = new Uint32Array(k);
    for (let p = 0; p < labels.length; p++) {
      const c = labels[p];
      area[c]++;
      const x = p % w, y = (p / w) | 0;
      if ((x > 0 && labels[p - 1] !== c) || (x < w - 1 && labels[p + 1] !== c) || (y > 0 && labels[p - w] !== c) || (y < h - 1 && labels[p + w] !== c)) edge[c]++;
    }
    const thin = new Uint8Array(k);
    for (let c = 0; c < k; c++) if (c !== protect && area[c] > 0 && edge[c] / area[c] > 0.75) thin[c] = 1;
    if (!thin.some((v) => v)) return;
    // 細い色の画素は、周りで一番多い「細くない色」に置き換える（何周かで内側まで届く）
    for (let it = 0; it < 4; it++) {
      const out = labels.slice();
      const cnt = new Uint16Array(k);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (!thin[labels[p]]) continue;
          cnt.fill(0);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              const v = labels[yy * w + xx];
              if (!thin[v]) cnt[v]++;
            }
          let best = -1, bc = 0;
          for (let c = 0; c < k; c++) if (cnt[c] > bc) { bc = cnt[c]; best = c; }
          if (best >= 0) out[p] = best;
        }
      labels.set(out);
    }
  }
}

/**
 * 背景に大きく接している小さな島（パッチの側面や落ち影）を背景にする。
 * 縁取りのように大きな部分は面積で除外される。
 */
function dropShadowIslands(labels: Uint8Array, w: number, h: number, bgLabel: number) {
  let fg = 0;
  for (let p = 0; p < labels.length; p++) if (labels[p] !== bgLabel) fg++;
  const seen = new Uint8Array(labels.length);
  const comp: number[] = [];
  for (let s = 0; s < labels.length; s++) {
    if (seen[s] || labels[s] === bgLabel) continue;
    const c = labels[s];
    comp.length = 0;
    let edge = 0, edgeBg = 0;
    const st = [s];
    seen[s] = 1;
    while (st.length) {
      const p = st.pop()!;
      comp.push(p);
      const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0) { edge++; edgeBg++; continue; }
        if (labels[q] === c) {
          if (!seen[q]) { seen[q] = 1; st.push(q); }
        } else {
          edge++;
          if (labels[q] === bgLabel) edgeBg++;
        }
      }
    }
    if (comp.length < fg * 0.05 && edgeBg / edge >= 0.35) for (const p of comp) labels[p] = bgLabel;
  }
}

/** 写真のくすみを取る：明るい無彩色は白、暗い色は黒、色のある色は彩度を上げる */
export function idealize(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  let [l, a, b] = rgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
  const c = Math.hypot(a, b);
  if (l < 22) return '#1a1a1a';
  if (c < 14 && l > 72) return '#ffffff';
  if (c >= 14) {
    const k = Math.min(1.7, 60 / c + 0.35, Math.max(1, 70 / c));
    a *= k; b *= k;
    l = l > 60 ? l - 4 : l; // 明るい色は少し濃くして色をはっきり
  }
  // 色域に収まるまで彩度を戻す
  for (let i = 0; i < 12; i++) {
    const rgb = labToRgbRaw(l, a, b);
    if (rgb.every((v) => v >= -0.5 && v <= 255.5)) break;
    a *= 0.92; b *= 0.92;
  }
  return toHex(labToRgb(l, a, b));
}

function labToRgbRaw(L: number, a: number, b: number): number[] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const finv = (t: number) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = finv(fx) * 0.95047, y = finv(fy), z = finv(fz) * 1.08883;
  const lin = [x * 3.2406 - y * 1.5372 - z * 0.4986, -x * 0.9689 + y * 1.8758 + z * 0.0415, x * 0.0557 - y * 0.204 + z * 1.057];
  return lin.map((c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055));
}

/** 正方形の窓での最小値（false）／最大値（true）フィルタ。縦横に分けて計算 */
function minMax(src: Float32Array, w: number, h: number, r: number, max: boolean): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const pick = max ? Math.max : Math.min;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = src[y * w + x];
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < w) v = pick(v, src[y * w + xx]);
      }
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x];
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < h) v = pick(v, tmp[yy * w + x]);
      }
      out[y * w + x] = v;
    }
  return out;
}

export function quantize(img: ImageData, opt: QuantizeOptions): QuantizeResult {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    L[i] = l; A[i] = a; B[i] = b; alpha[i] = data[i * 4 + 3];
  }
  for (let s = 0; s < opt.smooth; s++) bilateral(L, A, B, w, h);
  const bg = growBackground(L, A, B, w, h, opt.background);
  for (let i = 0; i < n; i++) if (alpha[i] < 128) bg[i] = 1;
  const fg: number[] = [];
  for (let i = 0; i < n; i++) if (!bg[i]) fg.push(i);
  const hasBg = fg.length < n;

  // 陰影を打ち消すため、明度の重みを下げた空間でクラスタリング
  const wL = 1 - 0.85 * opt.shade;
  const k = Math.max(2, Math.min(24, opt.colors));
  const rand = mulberry32(12345);

  const pool = fg.length > k * 4 ? fg : [...Array(n).keys()];
  const sampleN = Math.min(pool.length, 24000);
  const step = pool.length / sampleN;
  const sL = new Float32Array(sampleN), sA = new Float32Array(sampleN), sB = new Float32Array(sampleN);
  for (let i = 0; i < sampleN; i++) {
    const j = pool[Math.floor(i * step)];
    sL[i] = L[j] * wL; sA[i] = A[j]; sB[i] = B[j];
  }

  // k-means++ 初期化
  const cL = new Float32Array(k), cA = new Float32Array(k), cB = new Float32Array(k);
  const d = new Float32Array(sampleN).fill(Infinity);
  let first = Math.floor(rand() * sampleN);
  cL[0] = sL[first]; cA[0] = sA[first]; cB[0] = sB[first];
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < sampleN; i++) {
      const dl = sL[i] - cL[c - 1], da = sA[i] - cA[c - 1], db = sB[i] - cB[c - 1];
      const dd = dl * dl + da * da + db * db;
      if (dd < d[i]) d[i] = dd;
      sum += d[i];
    }
    let t = rand() * sum, pick = 0;
    for (let i = 0; i < sampleN; i++) { t -= d[i]; if (t <= 0) { pick = i; break; } }
    cL[c] = sL[pick]; cA[c] = sA[pick]; cB[c] = sB[pick];
  }

  const assign = new Uint8Array(sampleN);
  for (let it = 0; it < 20; it++) {
    const tL = new Float64Array(k), tA = new Float64Array(k), tB = new Float64Array(k), tc = new Uint32Array(k);
    for (let i = 0; i < sampleN; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = sL[i] - cL[c], da = sA[i] - cA[c], db = sB[i] - cB[c];
        const dd = dl * dl + da * da + db * db;
        if (dd < bd) { bd = dd; best = c; }
      }
      assign[i] = best;
      tL[best] += sL[i]; tA[best] += sA[i]; tB[best] += sB[i]; tc[best]++;
    }
    let moved = 0;
    for (let c = 0; c < k; c++) {
      if (!tc[c]) continue;
      const nl = tL[c] / tc[c], na = tA[c] / tc[c], nb = tB[c] / tc[c];
      moved += Math.abs(nl - cL[c]) + Math.abs(na - cA[c]) + Math.abs(nb - cB[c]);
      cL[c] = nl; cA[c] = na; cB[c] = nb;
    }
    if (moved < 0.05) break;
  }

  let labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = L[i] * wL, a = A[i], b = B[i];
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const dl = l - cL[c], da = a - cA[c], db = b - cB[c];
      const dd = dl * dl + da * da + db * db;
      if (dd < bd) { bd = dd; best = c; }
    }
    labels[i] = best;
  }

  // 背景は専用ラベル k
  const K = hasBg ? k + 1 : k;
  if (hasBg) for (let i = 0; i < n; i++) if (bg[i]) labels[i] = k;
  modeFilter(labels, w, h, K);
  modeFilter(labels, w, h, K);
  absorbSmall(labels, w, h, K, opt.minArea);
  absorbSmall(labels, w, h, K, opt.minArea);
  dissolveFringes(labels, w, h, K, hasBg ? k : -1);
  if (hasBg) dropShadowIslands(labels, w, h, k);

  // 代表色：明度は中央値より少し明るめ（陰影ではなく「地の色」を採る）、色相は平均
  const lValues: number[][] = Array.from({ length: K }, () => []);
  const sumA = new Float64Array(K), sumB = new Float64Array(K), cnt = new Uint32Array(K);
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    cnt[c]++;
    sumA[c] += A[i]; sumB[c] += B[i];
    if ((i & 3) === 0) lValues[c].push(L[i]);
  }

  const order = [...Array(K).keys()].filter((c) => cnt[c] > 0).sort((p, q) => cnt[q] - cnt[p]);
  const remap = new Uint8Array(K).fill(255);
  order.forEach((c, i) => (remap[c] = i));
  for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
  labels = labels.map((v) => (v === 255 ? 0 : v));

  const pct = 0.5 + 0.2 * opt.shade;
  const clusters: Cluster[] = order.map((c, i) => {
    const ls = lValues[c].sort((p, q) => p - q);
    const lRep = ls.length ? ls[Math.min(ls.length - 1, Math.floor(ls.length * pct))] : 50;
    return {
      id: i,
      hex: toHex(labToRgb(lRep, sumA[c] / cnt[c], sumB[c] / cnt[c])),
      count: cnt[c],
      background: hasBg && c === k,
    };
  });

  const res = opt.flatten ? flattenTones(labels, clusters) : { width: w, height: h, labels, clusters };
  if (opt.details) addDetails(res);
  if (opt.vivid) for (const c of res.clusters) if (!c.background) c.hex = idealize(c.hex);
  return res;

  /**
   * 細く明るい線（髪の毛筋、縫い目のステッチなど）を見つけて、別の色として上に重ねる。
   * 明るさのトップハット（元の明るさ − 7px 幅で開いた明るさ）が大きい画素が対象。
   */
  function addDetails(r: QuantizeResult) {
    const bgId = r.clusters.findIndex((c) => c.background);
    // 白さ（明るさ − 彩度）で見る：水色の上の白い毛筋は、明るさより彩度の差が大きい
    const W = new Float32Array(n);
    for (let i = 0; i < n; i++) W[i] = L[i] - Math.hypot(A[i], B[i]) * 0.8;
    const open = minMax(minMax(W, w, h, 3, false), w, h, 3, true);
    const det = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (r.labels[i] === bgId) continue;
      if (W[i] - open[i] > 14) det[i] = 1;
    }
    // 小さすぎる点は捨てる
    const seen = new Uint8Array(n);
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    const keep: number[] = [];
    const labOf = r.clusters.map((c) => {
      const v = parseInt(c.hex.slice(1), 16);
      return rgbToLab((v >> 16) & 255, (v >> 8) & 255, v & 255);
    });
    const under = new Uint32Array(r.clusters.length);
    for (let s0 = 0; s0 < n; s0++) {
      if (!det[s0] || seen[s0]) continue;
      const comp: number[] = [];
      const st = [s0];
      seen[s0] = 1;
      while (st.length) {
        const p = st.pop()!;
        comp.push(p);
        const x = p % w, y = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const q = yy * w + xx;
            if (det[q] && !seen[q]) { seen[q] = 1; st.push(q); }
          }
      }
      if (comp.length < Math.max(12, opt.minArea)) continue;
      // 下地の色（線の下にいちばん多い色）と線の白さが近ければ、見えないので捨てる
      under.fill(0);
      let wsum = 0;
      for (const p of comp) { under[r.labels[p]]++; wsum += W[p]; }
      let u = 0;
      for (let c = 1; c < under.length; c++) if (under[c] > under[u]) u = c;
      const [ul, ua, ub] = labOf[u];
      if (wsum / comp.length - (ul - Math.hypot(ua, ub) * 0.8) < 12) continue;
      keep.push(...comp);
    }
    if (keep.length < Math.max(30, opt.minArea * 2)) return;
    // 色は、線の中でも白さの上位 3 割の画素から（境目のにじみを避ける）
    const sorted = keep.slice().sort((p, q) => W[q] - W[p]);
    for (const p of sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.3)))) {
      sr += data[p * 4]; sg += data[p * 4 + 1]; sb += data[p * 4 + 2]; cnt++;
    }
    const id = r.clusters.length;
    for (const p of keep) r.labels[p] = id;
    let hex = toHex([Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt)]);
    if (opt.vivid) hex = idealize(hex);
    r.clusters.push({ id, hex, count: keep.length, background: false });
  }

  /**
   * 色味（色相）が同じで明るさだけ違う色を 1 色にまとめる。代表色は面積がいちばん大きい色。
   * 白・灰・黒のような色味のない色は明るさが別の色として残す（目の黒と縁取りの灰など）。
   */
  function flattenTones(lab: Uint8Array, cs: Cluster[]): QuantizeResult {
    const HUE_TOL = 25, CHROMA_MIN = 12;
    const info = cs.map((c) => {
      const n = parseInt(c.hex.slice(1), 16);
      const [l, a, b] = rgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
      return { l, c: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI };
    });
    const parent = cs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        if (cs[i].background || cs[j].background) continue;
        const p = info[i], q = info[j];
        const dh = Math.abs(((p.h - q.h + 540) % 360) - 180);
        const sameHue = p.c >= CHROMA_MIN && q.c >= CHROMA_MIN && dh <= HUE_TOL;
        const sameNeutral = p.c < CHROMA_MIN && q.c < CHROMA_MIN && Math.abs(p.l - q.l) < 6;
        if (sameHue || sameNeutral) parent[find(i)] = find(j);
      }
    // グループごとに、面積最大の色を代表に
    const rep = new Map<number, number>();
    cs.forEach((c, i) => {
      const r = find(i);
      const cur = rep.get(r);
      if (cur === undefined || cs[cur].count < c.count) rep.set(r, i);
    });
    const groups = [...rep.entries()]
      .map(([root, ri]) => ({ root, ri, count: cs.reduce((s, c, i) => s + (find(i) === root ? c.count : 0), 0) }))
      .sort((a, b) => b.count - a.count);
    const newId = new Uint8Array(256);
    cs.forEach((_, i) => (newId[i] = groups.findIndex((g) => g.root === find(i))));
    const out = lab.map((v) => newId[v]);
    return {
      width: w,
      height: h,
      labels: out,
      clusters: groups.map((g, i) => ({ id: i, hex: cs[g.ri].hex, count: g.count, background: cs[g.ri].background })),
    };
  }
}
