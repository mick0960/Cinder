import { createSignal, onCleanup, onMount, Show, For, Match, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { metrics, moduleOutputs, moduleHistory, modules, initStores } from "./stores";
import { Sparkline, ProgressBar, usageColor } from "../components/ModuleStyles";
import { BatteryMeter, CpuMeter, DiskMeter, MemMeter, NetMeter } from "./Meters";
import "./panel.css";
import type { ModuleConfig, ModuleOutput } from "../../types";

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

const CLICK_FLASH_MS = 700;

/**
 * 模块行的点击动作（打开网址 / 运行命令）。
 * 只告诉后端“点了哪个模块”，要执行什么由后端按已保存的配置决定，网页内容无法指定命令。
 */
function useModuleClick(mod: () => ModuleConfig) {
  const [flash, setFlash] = createSignal<"ok" | "err" | null>(null);
  const [failure, setFailure] = createSignal("");
  let timer = 0;
  onCleanup(() => clearTimeout(timer));

  const enabled = () => !!mod().click?.target.trim();
  const hint = () => {
    const c = mod().click;
    if (!c || !enabled()) return undefined;
    return c.kind === "url" ? `点击打开 ${c.target}` : `点击运行：${c.target}`;
  };
  const run = async () => {
    if (!enabled()) return;
    try {
      await invoke("module_click", { id: mod().id });
      setFailure("");
      setFlash("ok");
    } catch (e) {
      setFailure(String(e));
      setFlash("err");
    }
    clearTimeout(timer);
    timer = window.setTimeout(() => setFlash(null), CLICK_FLASH_MS);
  };
  return { enabled, hint, flash, failure, run };
}

type ModuleClick = ReturnType<typeof useModuleClick>;

function ModuleRow(props: { mod: ModuleConfig }) {
  const out = () => moduleOutputs()[props.mod.id];
  const click = useModuleClick(() => props.mod);
  const isErr = () => out()?.kind === "error";
  const rowTitle = () => [isErr() ? out()!.text : undefined, click.flash() === "err" ? click.failure() : click.hint()].filter(Boolean).join("\n") || undefined;
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
    // JSON 输出自带 text 时优先显示（如“8.8 / 512 GB”），否则显示百分比
    if (props.mod.format === "json" && out()?.text && !isErr()) return text();
    return v != null && !isErr() ? `${(v * 100).toFixed(0)}%` : text();
  };
  const items = () => (isErr() ? undefined : out()?.items) ?? [];

  return (
    <Show when={items().length === 0} fallback={<ModuleItems mod={props.mod} out={out()!} click={click} title={rowTitle()} />}>
      <div
        class="row module"
        classList={{ clickable: click.enabled(), "click-ok": click.flash() === "ok", "click-err": click.flash() === "err" }}
        title={rowTitle()}
        onClick={click.run}
      >
        <span class="label" title={props.mod.name}>{props.mod.name}</span>
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
    </Show>
  );
}

/** 多行模块：标题行 + 按 group 分组的条目，每条有数值时带进度条 */
function ModuleItems(props: { mod: ModuleConfig; out: ModuleOutput; click: ModuleClick; title?: string }) {
  const items = () => props.out.items ?? [];
  return (
    <>
      <div
        class="row module"
        classList={{ clickable: props.click.enabled(), "click-ok": props.click.flash() === "ok", "click-err": props.click.flash() === "err" }}
        title={props.title}
        onClick={props.click.run}
      >
        <span class="label" title={props.mod.name}>{props.mod.name}</span>
        <span class="value module-sum">{props.out.text}</span>
      </div>
      <For each={items()}>
        {(it, i) => {
          const color = () => it.color ?? (it.value != null ? usageColor(it.value) : undefined);
          const newGroup = () => it.group != null && it.group !== items()[i() - 1]?.group;
          return (
            <>
              <Show when={newGroup()}>
                <div class="row module-group">{it.group}</div>
              </Show>
              <div class="row module item" classList={{ grouped: it.group != null }}>
                <span class="label">{it.label}</span>
                <span class="value" style={{ color: it.value == null ? undefined : color() }}>{it.text}</span>
              </div>
              <Show when={it.value != null}>
                <div classList={{ "item-bar": true, grouped: it.group != null }}>
                  <ProgressBar value={it.value!} color={color()} />
                </div>
              </Show>
            </>
          );
        }}
      </For>
    </>
  );
}
