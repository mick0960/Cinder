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
      <div class="bar-fill" style={{ width: `${pct()}%`, "--c": props.color ?? COLOR_OK }} />
    </div>
  );
}

let sparkId = 0;

export function Sparkline(props: { values: number[]; color?: string }) {
  const w = 64, h = 16, pad = 2.5;
  const gid = `sp${++sparkId}`;
  const coords = () => {
    const vs = props.values;
    if (vs.length < 2) return null;
    const min = Math.min(...vs), max = Math.max(...vs);
    const range = max - min || 1;
    return vs.map((v, i) => [(i / (vs.length - 1)) * (w - pad), pad + (h - 2 * pad) * (1 - (v - min) / range)]);
  };
  return (
    <Show when={coords()}>
      {(c) => {
        const line = () => c().map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        const end = () => c()[c().length - 1];
        return (
          <svg width={w} height={h} class="sparkline" style={{ color: props.color ?? COLOR_OK }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="currentColor" stop-opacity="0.4" />
                <stop offset="1" stop-color="currentColor" stop-opacity="0" />
              </linearGradient>
            </defs>
            <polygon points={`0,${h} ${line()} ${end()[0].toFixed(1)},${h}`} fill={`url(#${gid})`} />
            <polyline points={line()} />
            <circle class="halo" cx={end()[0]} cy={end()[1]} r="2.6" />
            <circle cx={end()[0]} cy={end()[1]} r="1.5" />
          </svg>
        );
      }}
    </Show>
  );
}
