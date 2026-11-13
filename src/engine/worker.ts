import { tasks, type Tasks } from './tasks';

self.onmessage = (e: MessageEvent<{ id: number; task: keyof Tasks; args: unknown[] }>) => {
  const { id, task, args } = e.data;
  try {
    const result = (tasks[task] as (...a: unknown[]) => unknown)(...args);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
