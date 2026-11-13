export type Lab = [number, number, number];

const toLinear = (c: number) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const fromLinear = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

const LIN = new Float32Array(256).map((_, i) => toLinear(i));

const Xn = 0.95047, Yn = 1, Zn = 1.08883;
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const finv = (t: number) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);

export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / Xn;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / Yn;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / Zn;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = finv(fx) * Xn, y = finv(fy) * Yn, z = finv(fz) * Zn;
  const R = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const G = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const B = x * 0.0557 + y * -0.204 + z * 1.057;
  return [fromLinear(R), fromLinear(G), fromLinear(B)];
}

export const toHex = ([r, g, b]: [number, number, number]) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
