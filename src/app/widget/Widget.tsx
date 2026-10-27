import { createSignal, onCleanup, onMount, For, Match, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
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

  const [hiding, setHiding] = createSignal(false);
  const nextFrames = () =>
    new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
  /** 等待新布局绘制完成后取消隐藏 */
  const reveal = async () => {
    await nextFrames();
    setHiding(false);
  };

  let lastPanelH = 0;
  // 期望的展开状态：点击时同步翻转，队列里的步骤据此判断自己是否已过期
  let wantOpen = false;

  // 所有窗口几何操作串行执行，避免并发操作互相覆盖
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => Promise<unknown>) => (queue = queue.then(fn).catch(() => {}));

  /** 猫在屏幕上的物理坐标（不随展开方向变化）；以窗口实际物理尺寸计算，避免取整累积漂移 */
  const catAnchor = async () => {
    const [pos, size, sf] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
    const cat = Math.round(CAT * sf);
    return {
      x: pos.x + (flipX() ? size.width - cat : 0),
      y: pos.y + (flipY() ? size.height - cat : 0),
      sf,
    };
  };

  /** 位置和大小一次性生效（后端 SetWindowPos），中间不会出现"新尺寸+旧位置"的帧 */
  const setRect = (x: number, y: number, w: number, h: number) =>
    invoke("set_widget_rect", { x, y, w, h });

  const layoutExpanded = async (panelH: number) => {
    if (!wantOpen) return;
    const { x, y, sf } = await catAnchor();
    const w = WIN_W, h = CAT + GAP + panelH + SHADOW;
    const pw = Math.round(w * sf), ph = Math.round(h * sf), cat = Math.round(CAT * sf);
    const mon = await currentMonitor();
    const area = mon ? (mon.workArea ?? { position: mon.position, size: mon.size }) : null;
    const fx = !!area && x + pw > area.position.x + area.size.width;
    const fy = !!area && y + ph > area.position.y + area.size.height;
    // 翻转方向变化时，猫在窗口内的对齐方式会改变；窗口几何与 DOM 重排并非原子，
    // 所以这段时间先隐藏，几何和布局都就位后再显示
    const flipChanged = fx !== flipX() || fy !== flipY();
    if (flipChanged) {
      setHiding(true);
      await nextFrames();
    }
    await setRect(fx ? x - (pw - cat) : x, fy ? y - (ph - cat) : y, pw, ph);
    setFlipX(fx);
    setFlipY(fy);
    if (flipChanged) await reveal();
  };

  const collapse = async () => {
    if (wantOpen) return;
    const { x, y, sf } = await catAnchor();
    // 先通知后端面板已收起，使接下来的 Moved 事件按猫的位置保存
    await invoke("set_panel_open", { open: false });
    // 翻转展开时，先重置 flip 会让猫在仍是宽窗口里瞬间跳走，故窗口收好后再重置
    const flipped = flipX() || flipY();
    if (flipped) {
      setHiding(true);
      await nextFrames();
    }
    setExpanded(false);
    lastPanelH = 0;
    const cat = Math.round(CAT * sf);
    await setRect(x, y, cat, cat);
    setFlipX(false);
    setFlipY(false);
    if (flipped) await reveal();
  };

  const toggle = () => {
    wantOpen = !wantOpen;
    if (!wantOpen) {
      enqueue(collapse);
    } else {
      // 面板渲染后由 ResizeObserver 触发 layoutExpanded，窗口一次调整到位
      enqueue(async () => {
        if (!wantOpen) return;
        await invoke("set_panel_open", { open: true });
        setExpanded(true);
      });
    }
  };

  const onPanelResize = (el: HTMLElement) => {
    const h = el.offsetHeight;
    if (!wantOpen || !expanded() || h === lastPanelH) return;
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
      classList={{ "flip-x": flipX(), "flip-y": flipY(), hiding: hiding() }}
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

const BUILTIN_FRAMES = Object.entries(
  import.meta.glob("../../assets/bonfire/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>,
)
  .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  .map(([, url]) => url);

function Cat(props: { character: () => string }) {
  // 自定义角色被删除或帧为空时回退到内置篝火
  const frames = () => {
    const ch = props.character();
    const r = ch.startsWith("custom:") ? runners().find((x) => x.id === ch.slice(7)) : undefined;
    return r && r.frames.length > 0 ? r.frames : BUILTIN_FRAMES;
  };
  const frame = useFrameClock(() => frames().length);
  return <img class="cat" width="64" height="64" draggable={false} src={frames()[frame() % frames().length]} />;
}

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
