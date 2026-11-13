import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionButton,
  Button,
  DropZone,
  FileTrigger,
  Heading,
  IllustratedMessage,
  Item,
  Picker,
  ProgressCircle,
  TabList,
  TabPanels,
  Tabs,
  Text,
  NumberField,
  Switch,
  ToggleButton,
} from '@adobe/react-spectrum';
import ImageAdd from '@spectrum-icons/workflow/ImageAdd';
import SaveFloppy from '@spectrum-icons/workflow/SaveFloppy';
import Share from '@spectrum-icons/workflow/Share';
import Compare from '@spectrum-icons/workflow/Compare';
import MagicWand from '@spectrum-icons/workflow/MagicWand';
import Undo from '@spectrum-icons/workflow/Undo';
import AlertCircle from '@spectrum-icons/workflow/AlertCircle';
import { loadImage, runAnalyze, runBuild, runQuantize } from './engine/client';
import { applyPlan, buildPrompt, errorText, getDownloads, getSample, imageDataToBlob, svgToPng, type AiPlan } from './ai';
import { toSvg, type BuildOptions, type BuildResult, type Layer } from './engine/build';
import type { QuantizeResult } from './engine/quantize';
import { LayerList } from './LayerList';
import { LiveSlider } from './LiveSlider';

interface ShapeOptions {
  colors: number;
  shade: number;
  smooth: number;
  detail: number; // 解析解像度(px)
  minDetailMm2: number;
  background: number;
  flatten: boolean;
}

const HOOPS = [
  { key: '100x100', w: 100, h: 100 },
  { key: '130x180', w: 130, h: 180 },
  { key: '160x260', w: 160, h: 260 },
];

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [image, setImage] = useState<ImageData | null>(null);
  const [shape, setShape] = useState<ShapeOptions>({ colors: 6, shade: 0.7, smooth: 2, detail: 420, minDetailMm2: 1.5, background: 8, flatten: true });
  const [build, setBuild] = useState<Omit<BuildOptions, 'minAreaPx'> & { lineWidthMm: number }>({
    sizeMm: 90,
    overlapMm: 0.8,
    cleanup: 3,
    snap: true,
    lineWidthMm: 0.6,
  });
  const [hoopKey, setHoopKey] = useState('100x100');
  const [quant, setQuant] = useState<QuantizeResult | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState(0);
  const quantSeq = useRef(0);
  const buildSeq = useRef(0);
  const [sample, setSample] = useState<Awaited<ReturnType<typeof getSample>>>(null);
  const [downloads, setDownloads] = useState<Awaited<ReturnType<typeof getDownloads>>>(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [beforeAi, setBeforeAi] = useState<Layer[] | null>(null);
  const aiCtl = useRef<AbortController | null>(null);

  useEffect(() => {
    getSample().then((s) => setSample(() => s));
    getDownloads().then(setDownloads);
  }, []);

  const hoop = HOOPS.find((h) => h.key === hoopKey)!;

  const pickFile = useCallback((f: File | null | undefined) => {
    if (!f) return;
    setFile(f);
    setSrcUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(f);
    });
    setSelected(null);
  }, []);

  useEffect(() => {
    if (!file) return;
    let alive = true;
    loadImage(file, shape.detail).then((img) => alive && setImage(img));
    return () => {
      alive = false;
    };
  }, [file, shape.detail]);

  // 減色（陰影の打ち消し込み）
  useEffect(() => {
    if (!image) return;
    const seq = ++quantSeq.current;
    const pxPerMm = Math.max(image.width, image.height) / build.sizeMm;
    const t = setTimeout(() => {
      setBusy((b) => b + 1);
      runQuantize(image, {
        colors: shape.colors,
        shade: shape.shade,
        smooth: shape.smooth,
        minArea: Math.round(shape.minDetailMm2 * pxPerMm * pxPerMm),
        background: shape.background,
        flatten: shape.flatten,
      })
        .then((q) => {
          if (seq !== quantSeq.current) return;
          setQuant(q);
          setBeforeAi(null);
          setAiError(null);
          const init: Layer[] = q.clusters.map((c) => ({
              key: `c${c.id}`,
              members: [c.id],
              hex: c.hex,
              origHex: c.hex,
              visible: !c.background,
              mode: 'fill',
              shape: 'auto',
              offsetMm: 0,
            }));
          setLayers(init);
        })
        .finally(() => setBusy((b) => b - 1));
    }, 200);
    return () => clearTimeout(t);
    // sizeMm は小領域の判定にだけ使うので、変更のたびに作り直さない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, shape.colors, shape.shade, shape.smooth, shape.minDetailMm2, shape.background, shape.flatten]);

  // ベクター化
  useEffect(() => {
    if (!quant || !layers.length) return;
    const seq = ++buildSeq.current;
    const pxPerMm = Math.max(quant.width, quant.height) / build.sizeMm;
    const t = setTimeout(() => {
      setBusy((b) => b + 1);
      runBuild(quant, layers, { ...build, minAreaPx: shape.minDetailMm2 * pxPerMm * pxPerMm })
        .then((r) => seq === buildSeq.current && setResult(r))
        .finally(() => setBusy((b) => b - 1));
    }, 80);
    return () => clearTimeout(t);
  }, [quant, layers, build, shape.minDetailMm2]);

  const svgText = useMemo(
    () => (result ? toSvg(layers, result.layers, result.widthMm, result.heightMm, build.lineWidthMm) : ''),
    [result, layers, build.lineWidthMm],
  );

  const fileName = () => {
    const base = file?.name.replace(/\.[^.]+$/, '') || 'embroidery';
    return `${base}-${layers.filter((l) => l.visible).length}c.svg`;
  };

  const save = async () => {
    if (downloads) {
      await downloads.save({ filename: fileName(), data: svgText }).catch(() => {});
      return;
    }
    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const shareFile = useMemo(() => (svgText ? new File([svgText], fileName(), { type: 'image/svg+xml' }) : null), [svgText]); // eslint-disable-line react-hooks/exhaustive-deps
  const canShare = !downloads && !!shareFile && typeof navigator.canShare === 'function' && navigator.canShare({ files: [shareFile] });
  const share = () => shareFile && navigator.share({ files: [shareFile] }).catch(() => {});

  const runAi = async () => {
    if (!sample || !quant || !image || !svgText) return;
    const ctl = new AbortController();
    aiCtl.current = ctl;
    setAiRunning(true);
    setAiError(null);
    const base = layers;
    try {
      const pxPerMm = Math.max(quant.width, quant.height) / build.sizeMm;
      const stats = await runAnalyze(quant, base, Math.round(shape.minDetailMm2 * pxPerMm * pxPerMm));
      const images = [await imageDataToBlob(image), await svgToPng(svgText)];
      const plan = await sample.json<AiPlan>(buildPrompt(base, stats), { images, modelTier: 'quick', signal: ctl.signal });
      setBeforeAi(base);
      setLayers(applyPlan(base, plan));
      setSelected(null);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? '';
      if (code === 'not_granted' || code === 'sampling_disabled' || code === 'images_unavailable') setSample(null);
      else if (code !== 'cancelled') setAiError(errorText(code));
    } finally {
      setAiRunning(false);
    }
  };

  const updateLayer = (key: string, patch: Partial<Layer>) =>
    setLayers((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const picker = (
    <FileTrigger acceptedFileTypes={ACCEPT} onSelect={(fl) => pickFile(fl?.[0])}>
      <ActionButton aria-label="画像を変更" isQuiet>
        <ImageAdd />
      </ActionButton>
    </FileTrigger>
  );

  if (!file) {
    return (
      <div className="app">
        <header className="topbar">
          <h1>刺繍SVG</h1>
        </header>
        <div className="empty">
          <DropZone
            flex
            minHeight="60dvh"
            getDropOperation={(types) => (ACCEPT.some((t) => types.has(t)) ? 'copy' : 'cancel')}
            onDrop={async (e) => {
              for (const item of e.items) {
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                  pickFile(await item.getFile());
                  break;
                }
              }
            }}
          >
            <IllustratedMessage>
              <ImageAdd size="XXL" />
              <Heading>写真・イラスト</Heading>
              <FileTrigger acceptedFileTypes={ACCEPT} onSelect={(fl) => pickFile(fl?.[0])}>
                <Button variant="accent" marginTop="size-200">
                  画像を選ぶ
                </Button>
              </FileTrigger>
            </IllustratedMessage>
          </DropZone>
        </div>
      </div>
    );
  }

  const W = result?.widthMm ?? hoop.w;
  const H = result?.heightMm ?? hoop.h;
  const vbW = Math.max(W, hoop.w), vbH = Math.max(H, hoop.h);
  const ox = (vbW - W) / 2, oy = (vbH - H) / 2;
  const fits = W <= hoop.w + 0.01 && H <= hoop.h + 0.01;

  return (
    <div className="app">
      <header className="topbar">
        <h1>刺繍SVG</h1>
        {picker}
        {canShare && (
          <ActionButton aria-label="共有" isQuiet onPress={share}>
            <Share />
          </ActionButton>
        )}
        <Button variant="accent" onPress={save} isDisabled={!svgText}>
          <SaveFloppy />
          <Text>SVGを保存</Text>
        </Button>
      </header>

      <div className="stage">
        <svg viewBox={`0 0 ${vbW} ${vbH}`} onClick={() => setSelected(null)}>
          <rect className="hoop" x={(vbW - hoop.w) / 2} y={(vbH - hoop.h) / 2} width={hoop.w} height={hoop.h} rx={4} vectorEffect="non-scaling-stroke" />
          <g transform={`translate(${ox} ${oy})`}>
            {showOriginal && srcUrl ? (
              <image href={srcUrl} width={W} height={H} preserveAspectRatio="xMidYMid slice" />
            ) : (
              result &&
              layers.map((l, i) => {
                const b = result.layers[i];
                if (!l.visible || !b?.d) return null;
                const dim = selected && selected !== l.key ? 0.18 : 1;
                return l.mode === 'line' ? (
                  <path
                    key={l.key}
                    d={b.d}
                    fill="none"
                    stroke={l.hex}
                    strokeWidth={build.lineWidthMm}
                    strokeLinejoin="round"
                    opacity={dim}
                    onClick={(e) => (e.stopPropagation(), setSelected(l.key))}
                  />
                ) : (
                  <path
                    key={l.key}
                    d={b.d}
                    fill={l.hex}
                    fillRule="evenodd"
                    opacity={dim}
                    onClick={(e) => (e.stopPropagation(), setSelected(l.key))}
                  />
                );
              })
            )}
          </g>
        </svg>
        <div className="stage-info">
          {result && (
            <span className="size-chip" style={fits ? undefined : { color: 'var(--spectrum-semantic-negative-color-text-small)' }}>
              {W.toFixed(1)} × {H.toFixed(1)} mm
            </span>
          )}
          {busy > 0 && <ProgressCircle size="S" isIndeterminate aria-label="処理中" />}
        </div>
        <div className="stage-tools">
          <ToggleButton aria-label="元画像" isSelected={showOriginal} onChange={setShowOriginal}>
            <Compare />
          </ToggleButton>
        </div>
      </div>

      <Tabs aria-label="編集" defaultSelectedKey="colors" isEmphasized onSelectionChange={() => setSelected(null)}>
        <TabList marginX="size-200">
          <Item key="colors">色と順番</Item>
          <Item key="shape">形</Item>
          <Item key="size">サイズ</Item>
        </TabList>
        <TabPanels>
          <Item key="colors">
            <div className="panel">
              {sample && (
                <div className="ai-row">
                  {aiRunning ? (
                    <>
                      <ProgressCircle size="S" isIndeterminate aria-label="整えています" />
                      <ActionButton isQuiet onPress={() => aiCtl.current?.abort()}>
                        止める
                      </ActionButton>
                    </>
                  ) : (
                    <Button variant="primary" style="outline" onPress={runAi} isDisabled={!svgText}>
                      <MagicWand />
                      <Text>おまかせで整える</Text>
                    </Button>
                  )}
                  {beforeAi && !aiRunning && (
                    <ActionButton
                      isQuiet
                      onPress={() => {
                        setLayers(beforeAi);
                        setBeforeAi(null);
                      }}
                    >
                      <Undo />
                      <Text>元に戻す</Text>
                    </ActionButton>
                  )}
                </div>
              )}
              {aiError && (
                <div className="ai-error">
                  <AlertCircle size="S" />
                  <span>{aiError}</span>
                </div>
              )}
              <LayerList
                layers={layers}
                areas={result?.layers}
                selected={selected}
                onSelect={setSelected}
                onUpdate={updateLayer}
                onReorder={setLayers}
              />
            </div>
          </Item>
          <Item key="shape">
            <div className="panel stack">
              <LiveSlider label="色数" min={2} max={16} step={1} value={shape.colors} onCommit={(v) => setShape((s) => ({ ...s, colors: v }))} />
              <Switch isSelected={shape.flatten} onChange={(v) => setShape((s) => ({ ...s, flatten: v }))}>
                グラデーションを1色にまとめる
              </Switch>
              <LiveSlider
                label="陰影を消す"
                min={0}
                max={1}
                step={0.05}
                value={shape.shade}
                format={(v) => `${Math.round(v * 100)}%`}
                onCommit={(v) => setShape((s) => ({ ...s, shade: v }))}
              />
              <LiveSlider
                label="背景を取り除く"
                min={0}
                max={20}
                step={1}
                value={shape.background}
                format={(v) => (v === 0 ? 'オフ' : String(v))}
                onCommit={(v) => setShape((s) => ({ ...s, background: v }))}
              />
              <LiveSlider label="ムラを均す" min={0} max={4} step={1} value={shape.smooth} onCommit={(v) => setShape((s) => ({ ...s, smooth: v }))} />
              <LiveSlider
                label="小さな部分を消す"
                min={0}
                max={10}
                step={0.5}
                value={shape.minDetailMm2}
                format={(v) => `${v} mm²`}
                onCommit={(v) => setShape((s) => ({ ...s, minDetailMm2: v }))}
              />
              <LiveSlider
                label="形を整える"
                min={0}
                max={4}
                step={0.5}
                value={build.cleanup}
                format={(v) => v.toFixed(1)}
                onCommit={(v) => setBuild((s) => ({ ...s, cleanup: v }))}
              />
              <LiveSlider
                label="解析の細かさ"
                min={200}
                max={800}
                step={20}
                value={shape.detail}
                format={(v) => `${v} px`}
                onCommit={(v) => setShape((s) => ({ ...s, detail: v }))}
              />
              <Switch isSelected={build.snap} onChange={(v) => setBuild((s) => ({ ...s, snap: v }))}>
                水平・垂直にそろえる
              </Switch>
            </div>
          </Item>
          <Item key="size">
            <div className="panel stack">
              <Picker label="刺繍枠" selectedKey={hoopKey} onSelectionChange={(k) => setHoopKey(String(k))} width="100%">
                {HOOPS.map((h) => (
                  <Item key={h.key}>{`${h.w} × ${h.h} mm`}</Item>
                ))}
              </Picker>
              <NumberField
                label="長辺"
                value={build.sizeMm}
                minValue={10}
                maxValue={Math.max(hoop.w, hoop.h)}
                step={1}
                formatOptions={{ style: 'unit', unit: 'millimeter' }}
                onChange={(v) => Number.isFinite(v) && setBuild((s) => ({ ...s, sizeMm: v }))}
                width="100%"
              />
              <LiveSlider
                label="色どうしの重なり"
                min={0}
                max={3}
                step={0.1}
                value={build.overlapMm}
                format={(v) => `${v.toFixed(1)} mm`}
                onCommit={(v) => setBuild((s) => ({ ...s, overlapMm: v }))}
              />
              <LiveSlider
                label="線の太さ"
                min={0.2}
                max={3}
                step={0.1}
                value={build.lineWidthMm}
                format={(v) => `${v.toFixed(1)} mm`}
                onCommit={(v) => setBuild((s) => ({ ...s, lineWidthMm: v }))}
              />
            </div>
          </Item>
        </TabPanels>
      </Tabs>
    </div>
  );
}

