import { createSignal, onCleanup, onMount, For, Match, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  metrics, moduleOutputs, moduleHistory, modules, character,
  fmtRate, fmtMb, initStores, getSmoothCpu,
} from "./stores";
import { Sparkline, ProgressBar, usageColor, batteryColor } from "../components/ModuleStyles";
import type { ModuleConfig } from "../../types";

const CAT = 64;          // 猫的尺寸（逻辑像素）
const PANEL_W = 240;     // 面板宽度
const SIDE = 8;          // 面板左右留白（给阴影）
const GAP = 6;           // 猫与面板的间距
const SHADOW = 12;       // 面板远端留白（给阴影）
const WIN_W = PANEL_W + SIDE * 2;

export function Widget() {
  initStores();
  const win = getCurrentWindow();
  const [expanded, setExpanded] = createSignal(false);
  // 靠近屏幕右/下边缘时，面板改为向左/向上展开，猫保持在原位
  const [flipX, setFlipX] = createSignal(false);
  const [flipY, setFlipY] = createSignal(false);

  // 当前窗口逻辑尺寸
  let curW = CAT, curH = CAT, lastPanelH = 0;

  // 所有窗口几何操作串行执行，避免并发 setSize / setPosition 互相覆盖
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => Promise<unknown>) => (queue = queue.then(fn).catch(() => {}));

  /** 猫在屏幕上的物理坐标（不随展开方向变化） */
  const catAnchor = async () => {
    const [pos, sf] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    return {
      x: pos.x + (flipX() ? Math.round((curW - CAT) * sf) : 0),
      y: pos.y + (flipY() ? Math.round((curH - CAT) * sf) : 0),
      sf,
    };
  };

  const layoutExpanded = async (panelH: number) => {
    const { x, y, sf } = await catAnchor();
    const w = WIN_W, h = CAT + GAP + panelH + SHADOW;
    const mon = await currentMonitor();
    const area = mon ? (mon.workArea ?? { position: mon.position, size: mon.size }) : null;
    const fx = !!area && x + w * sf > area.position.x + area.size.width;
    const fy = !!area && y + h * sf > area.position.y + area.size.height;
    setFlipX(fx);
    setFlipY(fy);
    await win.setSize(new LogicalSize(w, h));
    curW = w;
    curH = h;
    await win.setPosition(new PhysicalPosition(
      Math.round(x - (fx ? (w - CAT) * sf : 0)),
      Math.round(y - (fy ? (h - CAT) * sf : 0)),
    ));
  };

  const collapse = async () => {
    const { x, y } = await catAnchor();
    // 先通知后端面板已收起，使接下来的 Moved 事件按猫的位置保存
    await invoke("set_panel_open", { open: false });
    setExpanded(false);
    setFlipX(false);
    setFlipY(false);
    lastPanelH = 0;
    await win.setSize(new LogicalSize(CAT, CAT));
    curW = curH = CAT;
    await win.setPosition(new PhysicalPosition(x, y));
  };

  const toggle = () => {
    if (expanded()) {
      enqueue(collapse);
    } else {
      // 面板渲染后由 ResizeObserver 触发 layoutExpanded，窗口一次调整到位
      enqueue(async () => {
        await invoke("set_panel_open", { open: true });
        setExpanded(true);
      });
    }
  };

  const onPanelResize = (el: HTMLElement) => {
    const h = el.offsetHeight;
    if (!expanded() || h === lastPanelH) return;
    lastPanelH = h;
    enqueue(() => layoutExpanded(h));
  };

  let dragStart: { x: number; y: number } | null = null;
  let dragging = false;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".panel")) return;
    dragStart = { x: e.screenX, y: e.screenY };
    dragging = false;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragStart || dragging) return;
    if (Math.abs(e.screenX - dragStart.x) + Math.abs(e.screenY - dragStart.y) > 6) {
      dragging = true;
      win.startDragging();
    }
  };
  const onPointerUp = () => {
    if (dragStart && !dragging) toggle();
    dragStart = null;
  };

  return (
    <div
      class="widget"
      classList={{ "flip-x": flipX(), "flip-y": flipY() }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        invoke("popup_widget_menu");
      }}
    >
      <Cat character={character} />
      <Show when={expanded()}>
        <Panel onResize={onPanelResize} />
      </Show>
    </div>
  );
}

/**
 * 动画时钟：独立于指标推送频率运行，每一帧根据当前平滑 CPU 决定下一帧间隔。
 * （旧实现每收到一次指标就重建 setInterval，间隔长于推送周期时动画会完全冻结）
 */
function useFrameClock(frames: number) {
  const [frame, setFrame] = createSignal(0);
  let timer = 0;
  const tick = () => {
    const hidden = document.hidden;
    if (!hidden) setFrame((f) => (f + 1) % frames);
    const cpu = Math.min(100, Math.max(0, getSmoothCpu()));
    const interval = hidden ? 2000 : Math.max(80, 800 - 720 * (cpu / 100));
    timer = window.setTimeout(tick, interval);
  };
  timer = window.setTimeout(tick, 400);
  onCleanup(() => clearTimeout(timer));
  return frame;
}

function Cat(props: { character: () => string }) {
  const frame = useFrameClock(LEG_FRAMES.length);
  const bob = () => (frame() % 2 === 0 ? 0 : -1.5);
  const legs = () => LEG_FRAMES[frame()];
  const dog = () => props.character() === "dog";
  return (
    <svg class="cat" viewBox="0 0 64 64" width="64" height="64">
      <g transform={`translate(0 ${bob()})`}>
        <path class="tail" d={dog() ? "M18 34 C14 30 13 23 16 19" : "M18 34 C10 32 7 24 12 19"} />
        <ellipse cx="30" cy="36" rx="14" ry="7" class="fur" />
        <circle cx="44" cy="28" r="6.5" class="fur" />
        <Show
          when={dog()}
          fallback={
            <>
              <path d="M40 23 l1.5 -5 3 4 z" class="fur" />
              <path d="M46 22.5 l3 -4 1.5 5 z" class="fur" />
            </>
          }
        >
          <ellipse cx="39.5" cy="23.5" rx="2.4" ry="5" transform="rotate(-15 39.5 23.5)" class="fur" />
          <ellipse cx="48.5" cy="23.5" rx="2.4" ry="5" transform="rotate(15 48.5 23.5)" class="fur" />
          <ellipse cx="50.3" cy="29.2" rx="1.6" ry="1.2" class="nose" />
        </Show>
        <circle cx="46.5" cy="27" r="1.1" class="eye" />
        <For each={legs()}>
          {(l) => <path class="leg" d={`M${l[0]} 41 Q${(l[0] + l[1]) / 2 + l[2]} 46 ${l[1]} 52`} />}
        </For>
      </g>
    </svg>
  );
}

const LEG_FRAMES: number[][][] = [
  [[22, 16, -1], [26, 24, 2], [36, 32, 1], [40, 44, -2]],
  [[22, 22, 1], [26, 18, -2], [36, 40, -1], [40, 36, 2]],
  [[22, 26, 2], [26, 20, 1], [36, 36, 2], [40, 42, -1]],
  [[22, 24, -2], [26, 28, -1], [36, 44, -2], [40, 34, 1]],
  [[22, 18, -1], [26, 22, 2], [36, 34, 1], [40, 38, -2]],
];

const diskName = (mount: string) => mount.replace(/[\\/]+$/, "") || "/";

function Panel(props: { onResize: (el: HTMLElement) => void }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(() => props.onResize(el));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  const m = () => metrics();
  const cpu = () => (m()?.cpu_percent ?? 0) / 100;
  const mem = () => (m() && m()!.mem_total_mb > 0 ? m()!.mem_used_mb / m()!.mem_total_mb : 0);

  return (
    <div class="panel" ref={el}>
      <div class="row"><span class="label">CPU</span><span class="value">{(cpu() * 100).toFixed(0)}%</span></div>
      <ProgressBar value={cpu()} color={usageColor(cpu())} />

      <div class="row"><span class="label">内存</span><span class="value">{m() ? `${fmtMb(m()!.mem_used_mb)} / ${fmtMb(m()!.mem_total_mb)}` : "—"}</span></div>
      <ProgressBar value={mem()} color={usageColor(mem())} />

      <Show when={m()?.battery}>
        {(b) => (
          <>
            <div class="row">
              <span class="label">电池</span>
              <span class="value">
                {(b().percent * 100).toFixed(0)}%
                <Show when={b().charging}><span class="sub"> · 充电中</span></Show>
              </span>
            </div>
            <ProgressBar value={b().percent} color={batteryColor(b().percent, b().charging)} />
          </>
        )}
      </Show>

      <div class="row net-row">
        <span class="label">网络</span>
        <span class="value net">
          <span><span class="arrow">↓</span>{fmtRate(m()?.net_down_bps ?? 0)}</span>
          <span><span class="arrow">↑</span>{fmtRate(m()?.net_up_bps ?? 0)}</span>
        </span>
      </div>

      <For each={m()?.disks ?? []}>
        {(d) => {
          const ratio = () => (d.total_gb > 0 ? d.used_gb / d.total_gb : 0);
          return (
            <>
              <div class="row"><span class="label">磁盘 {diskName(d.mount)}</span><span class="value">{d.used_gb.toFixed(0)} / {d.total_gb.toFixed(0)} GB</span></div>
              <ProgressBar value={ratio()} color={usageColor(ratio())} />
            </>
          );
        }}
      </For>

      <Show when={modules().length > 0}>
        <div class="divider" />
        <For each={modules()}>{(mod) => <ModuleRow mod={mod} />}</For>
      </Show>
    </div>
  );
}

function ModuleRow(props: { mod: ModuleConfig }) {
  const out = () => moduleOutputs()[props.mod.id];
  const isErr = () => out()?.kind === "error";
  const color = () => out()?.color ?? props.mod.color ?? undefined;
  const text = () => {
    const o = out();
    if (!o) return "…";
    if (o.kind === "error") return "—";
    const unit = props.mod.unit;
    return unit && !o.text.endsWith(unit) ? `${o.text}${unit}` : o.text;
  };
  const pct = () => {
    const v = out()?.value;
    return v != null && !isErr() ? `${(v * 100).toFixed(0)}%` : text();
  };

  return (
    <>
      <div class="row module" title={isErr() ? out()!.text : undefined}>
        <span class="label">{props.mod.name}</span>
        <Switch>
          <Match when={props.mod.style === "progress"}>
            <span class="value" classList={{ err: isErr() }}>{pct()}</span>
          </Match>
          <Match when={props.mod.style === "sparkline"}>
            <span class="value spark" classList={{ err: isErr() }}>
              <Sparkline values={moduleHistory()[props.mod.id] ?? []} color={color()} />
              <span class="spark-text">{text()}</span>
            </span>
          </Match>
          <Match when={true}>
            <span class="value" classList={{ err: isErr() }} style={{ color: isErr() ? undefined : color() }}>{text()}</span>
          </Match>
        </Switch>
      </div>
      {/* 进度条放在 .row 外面：在 flex 行内它会被压成 0 宽 */}
      <Show when={props.mod.style === "progress"}>
        <ProgressBar value={isErr() ? 0 : (out()?.value ?? 0)} color={color()} />
      </Show>
    </>
  );
}
