import {
  ActionButton,
  ActionGroup,
  ColorEditor,
  ColorPicker,
  ColorSwatch,
  ColorSwatchPicker,
  Flex,
  Item,
  Menu,
  MenuTrigger,
  Switch,
  Text,
} from '@adobe/react-spectrum';
import ChevronUp from '@spectrum-icons/workflow/ChevronUp';
import ChevronDown from '@spectrum-icons/workflow/ChevronDown';
import Merge from '@spectrum-icons/workflow/Merge';
import Undo from '@spectrum-icons/workflow/Undo';
import type { BuiltLayer, Layer } from './engine/build';
import { LiveSlider } from './LiveSlider';

const THREADS = [
  '#ffffff', '#f3ead6', '#c9c9c9', '#5e5e5e', '#1a1a1a',
  '#d3263a', '#f29bb0', '#f08a24', '#f6d330', '#6a3f22',
  '#3a9a48', '#45b8c2', '#4a90d9', '#1f3a7a', '#7b4fa8',
];

interface Props {
  layers: Layer[];
  areas?: BuiltLayer[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  onUpdate: (key: string, patch: Partial<Layer>) => void;
  onReorder: (layers: Layer[]) => void;
}

export function LayerList({ layers, areas, selected, onSelect, onUpdate, onReorder }: Props) {
  let n = 0;
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= layers.length) return;
    const next = layers.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onReorder(next);
  };
  const merge = (from: string, into: string) => {
    const src = layers.find((l) => l.key === from)!;
    onReorder(
      layers
        .filter((l) => l.key !== from)
        .map((l) => (l.key === into ? { ...l, members: [...l.members, ...src.members] } : l)),
    );
    onSelect(into);
  };

  return (
    <div>
      {layers.map((l, i) => {
        const num = l.visible ? ++n : null;
        const isSel = selected === l.key;
        const area = areas?.[i]?.areaMm2 ?? 0;
        return (
          <div key={l.key} className={`layer${l.visible ? '' : ' off'}${isSel ? ' selected' : ''}`}>
            <div className="layer-row" onClick={() => onSelect(isSel ? null : l.key)}>
              <span className="layer-num">{num ?? '–'}</span>
              <ColorPicker
                aria-label="糸の色"
                value={l.hex}
                size="S"
                onChange={(c) => onUpdate(l.key, { hex: c.toString('hex').toLowerCase() })}
              >
                <ColorEditor hideAlphaChannel />
                <ColorSwatchPicker size="S" density="compact" aria-label="よく使う色">
                  {[l.origHex, ...THREADS].map((c, k) => (
                    <ColorSwatch key={c + k} color={c} />
                  ))}
                </ColorSwatchPicker>
              </ColorPicker>
              <div className="layer-meta">
                <span className="hex">{l.hex.toUpperCase()}</span>
                <span className="sub">
                  {l.mode === 'line' ? '線' : '塗り'}
                  {l.visible && area > 0 ? `  ${area.toFixed(0)} mm²` : ''}
                </span>
              </div>
              <Switch
                aria-label="縫う"
                isSelected={l.visible}
                onChange={(v) => onUpdate(l.key, { visible: v })}
                marginEnd="-size-100"
              />
            </div>

            {isSel && (
              <div className="layer-detail">
                <ActionGroup
                  aria-label="縫い方"
                  selectionMode="single"
                  disallowEmptySelection
                  selectedKeys={[l.mode]}
                  onSelectionChange={(s) => onUpdate(l.key, { mode: [...s][0] as Layer['mode'] })}
                  density="compact"
                  isJustified
                >
                  <Item key="fill">塗り</Item>
                  <Item key="line">線</Item>
                </ActionGroup>
                <LiveSlider
                  label="余白"
                  min={-1}
                  max={1}
                  step={0.1}
                  value={l.offsetMm}
                  format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} mm`}
                  onCommit={(v) => onUpdate(l.key, { offsetMm: v })}
                />
                <Switch isSelected={l.underlay} onChange={(v) => onUpdate(l.key, { underlay: v })}>
                  内側の色の下も縫う
                </Switch>
                <Flex gap="size-100" wrap>
                  <ActionButton onPress={() => move(i, -1)} isDisabled={i === 0}>
                    <ChevronUp />
                    <Text>先に縫う</Text>
                  </ActionButton>
                  <ActionButton onPress={() => move(i, 1)} isDisabled={i === layers.length - 1}>
                    <ChevronDown />
                    <Text>後に縫う</Text>
                  </ActionButton>
                  <MenuTrigger>
                    <ActionButton isDisabled={layers.length < 2}>
                      <Merge />
                      <Text>色をまとめる</Text>
                    </ActionButton>
                    <Menu onAction={(k) => merge(l.key, String(k))}>
                      {layers
                        .filter((o) => o.key !== l.key)
                        .map((o) => (
                          <Item key={o.key} textValue={o.hex}>
                            <Text>
                              <span className="menu-dot" style={{ background: o.hex }} />
                              {o.hex.toUpperCase()}
                            </Text>
                          </Item>
                        ))}
                    </Menu>
                  </MenuTrigger>
                  {l.hex !== l.origHex && (
                    <ActionButton onPress={() => onUpdate(l.key, { hex: l.origHex })} aria-label="元の色に戻す">
                      <Undo />
                    </ActionButton>
                  )}
                </Flex>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
