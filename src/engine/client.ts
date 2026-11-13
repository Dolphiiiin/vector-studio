import type { QuantizeOptions, QuantizeResult } from './quantize';
import type { BuildOptions, BuildResult, Layer } from './build';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.type === 'error') p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
  }
  return worker;
}

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

export const runQuantize = (image: ImageData, options: QuantizeOptions) =>
  call<QuantizeResult>({ type: 'quantize', image, options });

export const runBuild = (q: QuantizeResult, layers: Layer[], options: BuildOptions) =>
  call<BuildResult>({ type: 'build', labels: q.labels, width: q.width, height: q.height, layers, options });

export async function loadImage(file: Blob, maxDim: number): Promise<ImageData> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}
