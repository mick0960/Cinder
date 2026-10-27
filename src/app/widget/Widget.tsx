import { createSignal, onCleanup, onMount, For, Match, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  metrics, moduleOutputs, moduleHistory, modules, character, runners,
  initStores, getSmoothCpu,
} from "./stores";
import { Sparkline, ProgressBar } from "../components/ModuleStyles";
import { BatteryMeter, CpuMeter, DiskMeter, MemMeter, NetMeter } from "./Meters";
import "./panel.css";
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
function useFrameClock(frames: () => number) {
  const [frame, setFrame] = createSignal(0);
  let timer = 0;
  const tick = () => {
    const hidden = document.hidden;
    if (!hidden) setFrame((f) => (f + 1) % Math.max(1, frames()));
    const cpu = Math.min(100, Math.max(0, getSmoothCpu()));
    const interval = hidden ? 2000 : Math.max(80, 800 - 720 * (cpu / 100));
    timer = window.setTimeout(tick, interval);
  };
  timer = window.setTimeout(tick, 400);
  onCleanup(() => clearTimeout(timer));
  return frame;
}

function Cat(props: { character: () => string }) {
  const custom = () => {
    const id = props.character().startsWith("custom:") ? props.character().slice(7) : null;
    const r = id ? runners().find((x) => x.id === id) : undefined;
    return r && r.frames.length > 0 ? r : null;
  };
  return (
    <Show when={custom()} fallback={<BuiltinCat character={props.character} />}>
      {(r) => <CustomRunner frames={r().frames} />}
    </Show>
  );
}

function CustomRunner(props: { frames: string[] }) {
  const frame = useFrameClock(() => props.frames.length);
  return <img class="cat custom" width="64" height="64" draggable={false} src={props.frames[frame() % props.frames.length]} />;
}

function BuiltinCat(props: { character: () => string }) {
  const frame = useFrameClock(() => LEG_FRAMES.length);
  const bob = () => (frame() % 2 === 0 ? 0 : -1.2);
  const legs = () => LEG_FRAMES[frame()];
  const dog = () => props.character() === "dog";
  return (
    <svg class="cat" classList={{ dog: dog() }} viewBox="0 0 64 64" width="64" height="64">
      <g transform={`translate(0 ${bob()})`}>
        {/* 远侧的腿画在身体后面，近侧的腿画在前面，有层次感 */}
        <For each={legs().slice(0, 2)}>
          {(l) => <path class="leg far" d={`M${l[0]} 41 Q${(l[0] + l[1]) / 2 + l[2]} 46 ${l[1]} 53`} />}
        </For>
        <path class="tail" d={dog() ? "M17 35 C12 32 11 25 14 21" : "M17 36 C8 36 5 27 10 21 C12 19 14 20 14 22"} />
        <ellipse cx="30" cy="36" rx="15" ry="8" class="fur" />
        <ellipse cx="31" cy="39.5" rx="10" ry="4" class="belly" />
        <For each={legs().slice(2)}>
          {(l) => <path class="leg" d={`M${l[0]} 41 Q${(l[0] + l[1]) / 2 + l[2]} 46 ${l[1]} 53`} />}
        </For>
        <circle cx="45" cy="27" r="8" class="fur" />
        <Show
          when={dog()}
          fallback={
            <>
              <path d="M38.5 24 L39 15.5 L45 21 Z" class="fur" />
              <path d="M45 21 L51 15.5 L51.5 24 Z" class="fur" />
              <path d="M40 21.5 L40.3 18.2 L43 20.7 Z" class="ear-in" />
              <path d="M47 20.7 L49.7 18.2 L50 21.5 Z" class="ear-in" />
              <path d="M44 30 q1 1.3 2 0 M47 30 q1 1.3 2 0" class="mouth" />
              <path d="M49 28.5 l6 -1.2 M49 29.7 l6 1.2" class="whisker" />
              <ellipse cx="48.8" cy="28" rx="1.1" ry="0.8" class="nose" />
            </>
          }
        >
          <ellipse cx="39" cy="24" rx="2.8" ry="6" transform="rotate(-18 39 24)" class="ear-dog" />
          <ellipse cx="51" cy="24" rx="2.8" ry="6" transform="rotate(18 51 24)" class="ear-dog" />
          <ellipse cx="50" cy="30" rx="3.6" ry="2.8" class="belly" />
          <ellipse cx="51.5" cy="29" rx="1.6" ry="1.2" class="nose" />
        </Show>
        <circle cx="46.5" cy="25.8" r="1.5" class="eye-w" />
        <circle cx="46.9" cy="25.8" r="0.9" class="eye" />
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

function Panel(props: { onResize: (el: HTMLElement) => void }) {
  let el!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(() => props.onResize(el));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  const m = () => metrics();

  return (
    <div class="panel" ref={el}>
      <CpuMeter m={m()} />
      <MemMeter m={m()} />
      <Show when={m()?.battery}>{(b) => <BatteryMeter b={b()} />}</Show>
      <NetMeter m={m()} />
      <Show when={(m()?.disks.length ?? 0) > 0}>
        <DiskMeter disks={m()!.disks} />
      </Show>

      <Show when={modules().length > 0}>
        <section class="sec modules">
          <For each={modules()}>{(mod) => <ModuleRow mod={mod} />}</For>
        </section>
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
