import { createEffect, createSignal, For, Index, on, onCleanup, onMount, Show } from "solid-js";
import { metricHistory, fmtRate, fmtMb } from "./stores";
import { usageColor, batteryColor } from "../components/ModuleStyles";
import type { BatteryInfo, DiskInfo, MetricsSnapshot } from "../../types";

/** 面板内容区宽度：240 - 左右 padding 12*2 - 边框 1*2 */
const INNER_W = 214;
const CHART_POINTS = 48;
const COLOR_DOWN = "#4cc2ff";
const COLOR_UP = "#c58cff";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

let uid = 0;
const nextId = (p: string) => `${p}${++uid}`;

/** 数值缓动：目标变化时用 ease-out 过渡到新值 */
export function useTween(target: () => number, ms = 260) {
  const [v, setV] = createSignal(target());
  let raf = 0;
  createEffect(
    on(target, (to) => {
      cancelAnimationFrame(raf);
      const from = v();
      if (!Number.isFinite(to) || Math.abs(to - from) < 1e-6) {
        setV(to);
        return;
      }
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / ms);
        setV(from + (to - from) * (1 - Math.pow(1 - k, 3)));
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, { defer: true }),
  );
  onCleanup(() => cancelAnimationFrame(raf));
  return v;
}

/* ---------- 实时滚动图 ---------- */

interface Series {
  values: number[];
  color: string;
  /** 镜像模式下画在中线下方 */
  below?: boolean;
}

/**
 * 最新的点固定在右边缘；每次新快照到达时整体先右移一格，再在一个采样周期内线性滑回，
 * 看起来就是连续向左滚动，而不是每次跳一格。
 */
function LiveChart(props: { series: Series[]; max: number; height: number; mirror?: boolean }) {
  const W = INNER_W;
  const step = W / (CHART_POINTS - 2);
  const H = () => props.height;
  const base = () => (props.mirror ? H() / 2 : H() - 1);
  const amp = () => (props.mirror ? H() / 2 - 1.5 : H() - 3);

  const pts = (s: Series) => {
    const vs = s.values;
    const n = vs.length;
    const max = props.max || 1;
    return vs.map((v, i) => {
      const k = clamp(v / max, 0, 1);
      return [W - (n - 1 - i) * step, base() + (s.below ? 1 : -1) * k * amp()] as const;
    });
  };
  const line = (s: Series) => pts(s).map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const area = (s: Series) => {
    const p = pts(s);
    if (p.length < 2) return "";
    return `${line(s)}L${p[p.length - 1][0].toFixed(1)} ${base()}L${p[0][0].toFixed(1)} ${base()}Z`;
  };
  const last = (s: Series) => {
    const p = pts(s);
    return p[p.length - 1];
  };

  const gid = nextId("lc");
  let g!: SVGGElement;
  createEffect(
    on(() => metricHistory().at, () => {
      const ms = Math.min(2000, metricHistory().stepMs);
      g.style.transition = "none";
      g.style.transform = `translateX(${step}px)`;
      void g.getBoundingClientRect();
      g.style.transition = `transform ${ms.toFixed(0)}ms linear`;
      g.style.transform = "translateX(0)";
    }),
  );

  return (
    <svg class="live-chart" width={W} height={H()} viewBox={`0 0 ${W} ${H()}`}>
      <defs>
        {/* Index：series 每次都是新数组，按位置复用节点 */}
        <Index each={props.series}>
          {(s, i) => (
            <linearGradient id={`${gid}-${i}`} x1="0" y1={s().below ? "1" : "0"} x2="0" y2={s().below ? "0" : "1"}>
              <stop offset="0" stop-color={s().color} stop-opacity="0.45" />
              <stop offset="1" stop-color={s().color} stop-opacity="0" />
            </linearGradient>
          )}
        </Index>
        {/* 左侧渐隐，旧数据淡出 */}
        <linearGradient id={`${gid}-fade`} x1="0" x2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0" />
          <stop offset="0.18" stop-color="#fff" stop-opacity="1" />
        </linearGradient>
        <mask id={`${gid}-mask`}>
          <rect width={W} height={H()} fill={`url(#${gid}-fade)`} />
        </mask>
      </defs>
      <line class="grid" x1="0" x2={W} y1={H() / 2} y2={H() / 2} />
      <g mask={`url(#${gid}-mask)`}>
        <g ref={g}>
          <Index each={props.series}>
            {(s, i) => (
              <>
                <path d={area(s())} fill={`url(#${gid}-${i})`} />
                <path d={line(s())} class="stroke" style={{ stroke: s().color }} />
              </>
            )}
          </Index>
          <Index each={props.series}>
            {(s) => (
              <Show when={last(s())}>
                {(p) => (
                  <>
                    <circle class="halo" cx={p()[0]} cy={p()[1]} r="3.2" style={{ fill: s().color }} />
                    <circle cx={p()[0]} cy={p()[1]} r="1.8" style={{ fill: s().color }} />
                  </>
                )}
              </Show>
            )}
          </Index>
        </g>
      </g>
    </svg>
  );
}

/* ---------- 图标 ---------- */

const ChipIcon = () => (
  <svg class="ico chip" viewBox="0 0 14 14" width="13" height="13">
    <path class="pins" d="M4.5 1v2M7 1v2M9.5 1v2M4.5 11v2M7 11v2M9.5 11v2M1 4.5h2M1 7h2M1 9.5h2M11 4.5h2M11 7h2M11 9.5h2" />
    <rect x="3" y="3" width="8" height="8" rx="1.6" class="body" />
    <rect x="5.2" y="5.2" width="3.6" height="3.6" rx="0.6" class="core" />
  </svg>
);

const RamIcon = () => (
  <svg class="ico" viewBox="0 0 14 14" width="13" height="13">
    <rect x="1" y="3.5" width="12" height="6" rx="1" class="body" />
    <path class="pins" d="M3 9.5v2M5 9.5v2M7 9.5v2M9 9.5v2M11 9.5v2" />
    <rect x="2.8" y="5.2" width="2" height="2.6" class="fillc" />
    <rect x="6" y="5.2" width="2" height="2.6" class="fillc" />
    <rect x="9.2" y="5.2" width="2" height="2.6" class="fillc" />
  </svg>
);

const NetIcon = () => (
  <svg class="ico" viewBox="0 0 14 14" width="13" height="13">
    <path class="wave w3" d="M1.5 5.5a8 8 0 0 1 11 0" />
    <path class="wave w2" d="M3.5 7.8a5 5 0 0 1 7 0" />
    <circle cx="7" cy="10.6" r="1.3" class="fillc" />
  </svg>
);

const DiskIcon = () => (
  <svg class="ico" viewBox="0 0 14 14" width="13" height="13">
    <ellipse cx="7" cy="4" rx="5" ry="2" class="body" />
    <path class="body" d="M2 4v6c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
    <path class="pins" d="M2 7c0 1.1 2.2 2 5 2s5-.9 5-2" />
  </svg>
);

const BoltIcon = (p: { class?: string }) => (
  <svg class={`ico ${p.class ?? ""}`} viewBox="0 0 14 14" width="13" height="13">
    <path class="fillc" d="M8 1 3 8h3.4L5.6 13 11 5.6H7.4z" />
  </svg>
);

/* ---------- CPU：芯片图标随负载“心跳”，下方为滚动面积图 ---------- */

export function CpuMeter(props: { m: MetricsSnapshot | null }) {
  const cpu = () => (props.m?.cpu_percent ?? 0) / 100;
  const shown = useTween(() => cpu() * 100);
  const color = () => usageColor(cpu());
  // 负载越高心跳越快：空闲 2.4s 一拍，满载 0.35s
  const beat = () => `${(2.4 - 2.05 * clamp(cpu(), 0, 1)).toFixed(2)}s`;
  return (
    <section class="sec cpu" classList={{ hot: cpu() >= 0.9 }} style={{ "--c": color(), "--beat": beat() }}>
      <div class="row">
        <span class="label"><ChipIcon />CPU</span>
        <span class="value big">{shown().toFixed(0)}<small>%</small></span>
      </div>
      <LiveChart series={[{ values: metricHistory().cpu, color: color() }]} max={1} height={24} />
    </section>
  );
}

/* ---------- 内存：内存条颗粒逐格点亮，带流光 ---------- */

const RAM_CELLS = 24;
const CELL_IDX = Array.from({ length: RAM_CELLS }, (_, i) => i);

export function MemMeter(props: { m: MetricsSnapshot | null }) {
  const ratio = () => (props.m && props.m.mem_total_mb > 0 ? props.m.mem_used_mb / props.m.mem_total_mb : 0);
  const lit = () => Math.round(clamp(ratio(), 0, 1) * RAM_CELLS);
  const pct = useTween(() => ratio() * 100);
  return (
    <section class="sec mem" style={{ "--c": usageColor(ratio()), "--fill": `${(lit() / RAM_CELLS) * 100}%` }}>
      <div class="row">
        <span class="label"><RamIcon />内存</span>
        <span class="value">
          {props.m ? `${fmtMb(props.m.mem_used_mb)} / ${fmtMb(props.m.mem_total_mb)}` : "—"}
          <span class="pct">{pct().toFixed(0)}%</span>
        </span>
      </div>
      <div class="ram">
        <For each={CELL_IDX}>
          {(i) => (
            <i
              classList={{ on: i < lit(), head: i === lit() - 1 }}
              style={{ "transition-delay": `${i * 14}ms`, opacity: i < lit() ? 0.55 + (0.45 * (i + 1)) / RAM_CELLS : undefined }}
            />
          )}
        </For>
      </div>
    </section>
  );
}

/* ---------- 电池：电池外形，充电时流动条纹 + 闪电，低电量闪烁 ---------- */

const fmtLeft = (secs: number) => {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
};

export function BatteryMeter(props: { b: BatteryInfo }) {
  const pct = () => clamp(props.b.percent, 0, 1);
  const shown = useTween(() => pct() * 100);
  const low = () => !props.b.charging && pct() <= 0.15;
  const sub = () => {
    const s = props.b.secs_left;
    if (props.b.charging) return s ? `充满约 ${fmtLeft(s)}` : "充电中";
    return s ? `剩余 ${fmtLeft(s)}` : "";
  };
  return (
    <section
      class="sec bat"
      classList={{ charging: props.b.charging, low: low() }}
      style={{ "--c": batteryColor(pct(), props.b.charging) }}
    >
      <div class="row">
        <span class="label">
          <Show when={props.b.charging} fallback={<BoltIcon class="dim" />}><BoltIcon class="zap" /></Show>电池
        </span>
        <span class="value"><span class="sub">{sub()}</span></span>
      </div>
      <div class="battery">
        <div class="bat-fill" style={{ width: `${pct() * 100}%` }} />
        <span class="bat-text">{shown().toFixed(0)}%</span>
      </div>
    </section>
  );
}

/* ---------- 网络：上下行镜像滚动图，箭头随速率流动 ---------- */

/** 速率越高箭头流动越快（对数刻度），几乎无流量时静止 */
const flowDur = (bps: number) => (bps < 2048 ? 0 : clamp(1.6 - Math.log10(bps / 1024) * 0.42, 0.3, 1.6));

export function NetMeter(props: { m: MetricsSnapshot | null }) {
  const down = () => props.m?.net_down_bps ?? 0;
  const up = () => props.m?.net_up_bps ?? 0;
  // 纵轴上限取窗口内峰值（至少 32KB/s），并做缓动，避免刻度突变
  const peak = () => {
    const h = metricHistory();
    return Math.max(32 * 1024, ...h.down, ...h.up) * 1.15;
  };
  const max = useTween(peak, 500);
  const Rate = (p: { bps: number; dir: "down" | "up" }) => {
    const d = () => flowDur(p.bps);
    return (
      <span class={`rate ${p.dir}`} classList={{ active: d() > 0 }} style={{ "--flow": `${d() || 1}s` }}>
        <span class="arrow">{p.dir === "down" ? "↓" : "↑"}</span>
        {fmtRate(p.bps)}
      </span>
    );
  };
  return (
    <section class="sec net">
      <div class="row">
        <span class="label"><NetIcon />网络</span>
        <span class="value net">
          <Rate bps={down()} dir="down" />
          <Rate bps={up()} dir="up" />
        </span>
      </div>
      <LiveChart
        mirror
        height={28}
        max={max()}
        series={[
          { values: metricHistory().down, color: COLOR_DOWN },
          { values: metricHistory().up, color: COLOR_UP, below: true },
        ]}
      />
    </section>
  );
}

/* ---------- 磁盘：环形仪表，中间有缓慢旋转的“盘片” ---------- */

const diskName = (mount: string) => mount.replace(/[\\/]+$/, "") || "/";

function DiskRing(props: { d: DiskInfo }) {
  const R = 14, C = 2 * Math.PI * R;
  const ratio = () => (props.d.total_gb > 0 ? clamp(props.d.used_gb / props.d.total_gb, 0, 1) : 0);
  // 首次挂载从 0 开始，下一帧再设为真实值，让圆环“画”出来
  const [ready, setReady] = createSignal(false);
  onMount(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    onCleanup(() => cancelAnimationFrame(id));
  });
  const color = () => usageColor(ratio());
  return (
    <div class="disk" style={{ "--c": color() }}>
      <svg viewBox="0 0 36 36" width="34" height="34">
        <circle class="track" cx="18" cy="18" r={R} />
        <circle
          class="arc"
          cx="18" cy="18" r={R}
          stroke-dasharray={`${C}`}
          stroke-dashoffset={`${C * (1 - (ready() ? ratio() : 0))}`}
        />
        <circle class="platter" cx="18" cy="18" r="9" />
        <text x="18" y="18.6">{(ratio() * 100).toFixed(0)}</text>
      </svg>
      <div class="disk-text">
        <span class="disk-name">{diskName(props.d.mount)}</span>
        <span class="disk-size">{props.d.used_gb.toFixed(0)}/{props.d.total_gb.toFixed(0)}G</span>
      </div>
    </div>
  );
}

export function DiskMeter(props: { disks: DiskInfo[] }) {
  return (
    <section class="sec disks">
      <div class="row"><span class="label"><DiskIcon />磁盘</span></div>
      <div class="rings">
        {/* Index：快照每次都是新对象，按位置复用节点，避免圆环动画反复重播 */}
        <Index each={props.disks}>{(d) => <DiskRing d={d()} />}</Index>
      </div>
    </section>
  );
}
