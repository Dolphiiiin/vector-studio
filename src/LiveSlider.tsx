import { useEffect, useState } from 'react';
import { Slider } from '@adobe/react-spectrum';

interface Props {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onCommit: (v: number) => void;
}

/** ドラッグ中は表示だけ更新し、指を離したときに確定する */
export function LiveSlider({ label, min, max, step, value, format, onCommit }: Props) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Slider
      label={label}
      minValue={min}
      maxValue={max}
      step={step}
      value={v}
      onChange={setV}
      onChangeEnd={onCommit}
      getValueLabel={format}
      width="100%"
    />
  );
}
