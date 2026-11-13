import { quantize } from './quantize';
import { buildLayers } from './build';
import { analyzeLayers } from './analyze';

/** Worker でもメインスレッドでも同じように呼べる処理一覧 */
export const tasks = {
  quantize,
  build: buildLayers,
  analyze: analyzeLayers,
};
export type Tasks = typeof tasks;
