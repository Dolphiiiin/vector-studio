import type { QuantizeOptions, QuantizeResult } from './quantize';
import type { BuildOptions, BuildResult, Layer } from './build';
import type { LayerStats } from './analyze';
import type { Tasks } from './tasks';

// Worker が使えない環境（埋め込み表示など）ではメインスレッドで実行する
let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void; msg: Msg }>();
type Msg = { task: keyof Tasks; args: unknown[] };

async function runInline({ task, args }: Msg) {
  const { tasks } = await import('./tasks');
  await new Promise((r) => setTimeout(r));
  return (tasks[task] as (...a: unknown[]) => unknown)(...args);
}

function fallBack() {
  worker?.terminate();
  worker = null;
  for (const [id, p] of pending) {
    pending.delete(id);
    runInline(p.msg).then(p.resolve, p.reject);
  }
}

function getWorker() {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data.result);
      };
      worker.onerror = fallBack;
    } catch {
      worker = null;
    }
  }
  return worker;
}

function call<T>(msg: Msg): Promise<T> {
  const w = getWorker();
  if (!w) return runInline(msg) as Promise<T>;
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject, msg });
    w.postMessage({ id, ...msg });
  });
}

export const runQuantize = (image: ImageData, options: QuantizeOptions) =>
  call<QuantizeResult>({ task: 'quantize', args: [image, options] });

export const runBuild = (q: QuantizeResult, layers: Layer[], options: BuildOptions) =>
  call<BuildResult>({ task: 'build', args: [q.labels, q.width, q.height, layers, options] });

export const runAnalyze = (q: QuantizeResult, layers: Layer[], minArea: number) =>
  call<LayerStats[]>({ task: 'analyze', args: [q.labels, q.width, q.height, layers, minArea] });

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
