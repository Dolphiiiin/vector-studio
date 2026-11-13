import { quantize, type QuantizeOptions } from './quantize';
import { buildLayers, type BuildOptions, type Layer } from './build';

export type Req =
  | { type: 'quantize'; id: number; image: ImageData; options: QuantizeOptions }
  | { type: 'build'; id: number; labels: Uint8Array; width: number; height: number; layers: Layer[]; options: BuildOptions };

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  try {
    if (msg.type === 'quantize') {
      const r = quantize(msg.image, msg.options);
      (self as unknown as Worker).postMessage({ type: 'quantize', id: msg.id, result: r });
    } else {
      const r = buildLayers(msg.labels, msg.width, msg.height, msg.layers, msg.options);
      (self as unknown as Worker).postMessage({ type: 'build', id: msg.id, result: r });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', id: msg.id, error: String(err) });
  }
};
