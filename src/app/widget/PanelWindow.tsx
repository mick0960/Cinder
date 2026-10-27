import { createSignal, onCleanup, onMount, Show, For, Match, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { metrics, moduleOutputs, moduleHistory, modules, initStores } from "./stores";
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

/**
 * 监控面板窗口。图标窗口不动，面板窗口贴在图标下方；靠近屏幕右/下边缘时改为向左/向上展开。
 * 窗口创建时隐藏，排好版、定位完成后才显示，所以不会有中间帧。
 */
export function PanelWindow() {
  initStores();
  const win = getCurrentWindow();
  const [open, setOpen] = createSignal(false);
  const [flipX, setFlipX] = createSignal(false);
  const [flipY, setFlipY] = createSignal(false);
  let panelH = 0;
  let shown = false;

  // 所有几何操作串行，避免并发读写互相覆盖
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => Promise<unknown>) => (queue = queue.then(fn).catch(() => {}));

  const layout = async () => {
    if (!open() || panelH === 0) return;
    const widget = await WebviewWindow.getByLabel("widget");
    if (!widget) return;
    const [pos, sf] = await Promise.all([widget.outerPosition(), widget.scaleFactor()]);
    const cat = Math.round(CAT * sf);
    const mon = await monitorFromPoint(pos.x + cat / 2, pos.y + cat / 2);
    const pw = Math.round(WIN_W * sf);
    const ph = Math.round((GAP + panelH + SHADOW) * sf);
    const area = mon ? (mon.workArea ?? { position: mon.position, size: mon.size }) : null;
    const fx = !!area && pos.x + pw > area.position.x + area.size.width;
    const fy = !!area && pos.y + cat + ph > area.position.y + area.size.height;
    setFlipX(fx);
    setFlipY(fy);
    await invoke("set_widget_rect", {
      x: fx ? pos.x + cat - pw : pos.x,
      y: fy ? pos.y - ph : pos.y + cat,
      w: pw,
      h: ph,
    });
    if (!shown) {
      shown = true;
      await win.show();
    }
  };

  const onShow = () => {
    shown = false;
    panelH = 0;
    setOpen(true);
  };
  const onHide = () => {
    setOpen(false);
    shown = false;
    panelH = 0;
  };

  onMount(async () => {
    const offs = await Promise.all([
      listen("panel://show", onShow),
      listen("panel://hide", onHide),
      listen("panel://anchor-moved", () => enqueue(layout)),
    ]);
    onCleanup(() => offs.forEach((f) => f()));
    if (await invoke<boolean>("is_panel_open")) onShow();
  });

  const onPanelResize = (el: HTMLElement) => {
    const h = el.offsetHeight;
    if (h === panelH) return;
    panelH = h;
    enqueue(layout);
  };

  return (
    <div class="widget" classList={{ "flip-x": flipX(), "flip-y": flipY() }}>
      <Show when={open()}>
        <Panel onResize={onPanelResize} />
      </Show>
    </div>
  );
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
