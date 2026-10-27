import { Show } from "solid-js";

export const COLOR_OK = "#4cc2ff";
export const COLOR_WARN = "#ffb547";
export const COLOR_DANGER = "#ff5d5d";
export const COLOR_GOOD = "#4cd97b";

/** 占用类指标：越高越危险 */
export function usageColor(v: number): string {
  if (v >= 0.9) return COLOR_DANGER;
  if (v >= 0.75) return COLOR_WARN;
  return COLOR_OK;
}

/** 电量：越低越危险，充电中为绿色 */
export function batteryColor(v: number, charging: boolean): string {
  if (charging) return COLOR_GOOD;
  if (v <= 0.15) return COLOR_DANGER;
  if (v <= 0.3) return COLOR_WARN;
  return COLOR_OK;
}

export function ProgressBar(props: { value: number; color?: string }) {
  const pct = () => Math.min(100, Math.max(0, props.value * 100));
  return (
    <div class="bar">
      <div class="bar-fill" style={{ width: `${pct()}%`, background: props.color ?? COLOR_OK }} />
    </div>
  );
}

export function Sparkline(props: { values: number[]; color?: string }) {
  const w = 64, h = 16, pad = 1.5;
  const points = () => {
    const vs = props.values;
    if (vs.length < 2) return "";
    const min = Math.min(...vs), max = Math.max(...vs);
    const range = max - min || 1;
    return vs
      .map((v, i) => `${((i / (vs.length - 1)) * w).toFixed(1)},${(pad + (h - 2 * pad) * (1 - (v - min) / range)).toFixed(1)}`)
      .join(" ");
  };
  return (
    <Show when={points()}>
      {(p) => (
        <svg width={w} height={h} class="sparkline" style={{ color: props.color ?? COLOR_OK }}>
          <polyline points={p()} />
        </svg>
      )}
    </Show>
  );
}
