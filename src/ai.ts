import type { Layer } from './engine/build';
import type { ShapeMode } from './engine/shapes';
import type { LayerStats } from './engine/analyze';

type SampleFn = typeof Claude.sample;
type Downloads = typeof Claude.downloads;

const host = () => (window as unknown as { claude?: Window['claude'] }).claude;

/** claude.ai の Artifact 内で開いたときだけ使える。それ以外は null */
export async function getSample(): Promise<SampleFn | null> {
  try {
    const s = await host()?.use('sample');
    if (!s) return null;
    const lim = await s.limits().catch(() => null);
    return lim?.images ? s : null;
  } catch {
    return null;
  }
}

export async function getDownloads(): Promise<Downloads | null> {
  try {
    return (await host()?.use('downloads')) ?? null;
  } catch {
    return null;
  }
}

export interface AiLayer {
  id: string;
  name?: string;
  sew?: boolean;
  shape?: ShapeMode;
  mergeInto?: string | null;
}
export interface AiPlan {
  layers: AiLayer[];
  order?: string[];
}

export function buildPrompt(layers: Layer[], stats: LayerStats[]): string {
  const rows = layers.map((l, i) => {
    const s = stats[i];
    return {
      id: l.key,
      color: l.hex,
      sew: l.visible,
      shape: l.shape,
      areaPct: s?.areaPct,
      bboxPct: s?.bbox,
      islands: s?.islands,
      rectangularity: s?.rectangularity,
      nextToUnsewn: s?.nextToBackground,
    };
  });
  return `You are helping prepare an embroidery design (for a home embroidery machine) from a photo or illustration.
The app has already reduced the image to flat color regions. Image 1 is the original. Image 2 is the current flat-color preview (unsewn regions are not drawn).

Color regions (bboxPct is x0,y0,x1,y1 in % of the image; rectangularity near 1.0 means each island is a clean rectangle; nextToUnsewn is the share of the outline touching unsewn area):
${JSON.stringify(rows)}

Decide, for each region:
- sew: false for fabric/paper background, cast shadows, reflections, photo noise, anything that is not part of the design itself.
- mergeInto: the id of another region when both are the same thread color split only by lighting, shading or highlights (this design uses no gradients: every shade of one hue is one thread). null otherwise. Never merge distinct design colors.
- shape: "auto" lets the app pick the simplest fitting shape per island (rectangle, rounded rectangle, ellipse, polygon, curve) and is right for most regions. Override only when the intent is clear: "rect" for parts meant to be rectangles even if the photo is distorted, "straight" for straight-edged polygons, "smooth" for organic curves.
- name: a 1-4 word Japanese name of what the region is (e.g. 顔, 髪, 目, ほっぺ, 縁取り, 影).
Then give the stitching order of the regions that remain sewn: large base fills first, small details on top later, an outer border or outline last.

Reply with only JSON in this shape:
{"layers":[{"id":"c0","name":"顔","sew":true,"mergeInto":null,"shape":"auto"}],"order":["c0"]}`;
}

/** 返ってきた判断を、いまの色の一覧に当てはめる（不正な値は無視） */
export function applyPlan(layers: Layer[], plan: AiPlan): Layer[] {
  const byKey = new Map(layers.map((l) => [l.key, { ...l }]));
  const shapes: ShapeMode[] = ['auto', 'smooth', 'straight', 'rect'];
  const items = Array.isArray(plan?.layers) ? plan.layers : [];
  for (const a of items) {
    const l = byKey.get(String(a?.id));
    if (!l) continue;
    if (typeof a.name === 'string' && a.name.trim()) l.name = a.name.trim().slice(0, 12);
    if (typeof a.sew === 'boolean') l.visible = a.sew;
    if (shapes.includes(a.shape as ShapeMode)) l.shape = a.shape as ShapeMode;
  }
  // まとめる（連鎖をたどり、自分自身への結合は無視）
  const target = new Map<string, string>();
  for (const a of items) {
    const from = String(a?.id), to = a?.mergeInto == null ? '' : String(a.mergeInto);
    if (to && to !== from && byKey.has(from) && byKey.has(to)) target.set(from, to);
  }
  const resolve = (k: string) => {
    const seen = new Set<string>();
    while (target.has(k) && !seen.has(k)) { seen.add(k); k = target.get(k)!; }
    return k;
  };
  for (const [from] of target) {
    const to = resolve(from);
    if (to === from) continue;
    const src = byKey.get(from)!, dst = byKey.get(to)!;
    dst.members = [...dst.members, ...src.members];
    if (src.visible) dst.visible = true;
    byKey.delete(from);
  }
  // 順番：指定された順、その後に残り（縫わない色は先頭にまとめる）
  const order = Array.isArray(plan?.order) ? plan.order.map(String) : [];
  const out: Layer[] = [];
  const used = new Set<string>();
  const remaining = layers.map((l) => l.key).filter((k) => byKey.has(k));
  for (const k of remaining) if (!byKey.get(k)!.visible) { out.push(byKey.get(k)!); used.add(k); }
  for (const k of order) if (byKey.has(k) && !used.has(k)) { out.push(byKey.get(k)!); used.add(k); }
  for (const k of remaining) if (!used.has(k)) out.push(byKey.get(k)!);
  return out;
}

/** プレビュー用に SVG 文字列を PNG にする */
export async function svgToPng(svg: string, size = 768): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = size / Math.max(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('toBlob'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function imageDataToBlob(img: ImageData): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j(new Error('toBlob'))), 'image/jpeg', 0.85));
}

export function errorText(code: string): string {
  switch (code) {
    case 'rate_limited':
      return '混み合っています。少し待ってからもう一度';
    case 'refused':
    case 'empty_completion':
    case 'invalid_json':
      return '整えられませんでした。もう一度試すか手動で調整';
    case 'session_expired':
      return 'claude.ai に再ログインが必要です';
    default:
      return 'つながりませんでした。もう一度試してください';
  }
}
