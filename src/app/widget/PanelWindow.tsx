import { createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { metrics, moduleOutputs, moduleHistory, modules, initStores } from "./stores";
import { Sparkline, ProgressBar, usageColor } from "../components/ModuleStyles";
import { BatteryMeter, CpuMeter, DiskMeter, MemMeter, NetMeter } from "./Meters";
import "./panel.css";
import type { ModuleConfig, ModuleItem, ModuleOutput } from "../../types";

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
  const [maxH, setMaxH] = createSignal<number | undefined>(undefined);
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
    const area = mon ? (mon.workArea ?? { position: mon.position, size: mon.size }) : null;
    const availBelow = area ? area.position.y + area.size.height - (pos.y + cat) : Infinity;
    const availAbove = area ? pos.y - area.position.y : Infinity;
    const desiredPh = Math.round((GAP + panelH + SHADOW) * sf);
    const fx = !!area && pos.x + pw > area.position.x + area.size.width;
    const fy = !!area && desiredPh > availBelow && availAbove > availBelow;
    const maxWinH = area
      ? Math.max(Math.round(160 * sf), Math.floor(fy ? availAbove : availBelow))
      : desiredPh;
    const ph = Math.min(desiredPh, maxWinH);
    const maxPanelCssH = Math.max(120, Math.floor(ph / sf - GAP - SHADOW));
    setMaxH(ph < desiredPh ? maxPanelCssH : undefined);
    setFlipX(fx);
    setFlipY(fy);
    const rawX = fx ? pos.x + cat - pw : pos.x;
    const rawY = fy ? pos.y - ph : pos.y + cat;
    const x = area
      ? Math.min(Math.max(area.position.x, area.position.x + area.size.width - pw), Math.max(area.position.x, rawX))
      : rawX;
    const y = area
      ? Math.min(Math.max(area.position.y, area.position.y + area.size.height - ph), Math.max(area.position.y, rawY))
      : rawY;
    await invoke("set_widget_rect", { x, y, w: pw, h: ph });
    if (!shown) {
      shown = true;
      await win.show();
    }
  };

  const onShow = () => {
    shown = false;
    panelH = 0;
    setMaxH(undefined);
    setOpen(true);
  };
  const onHide = () => {
    setOpen(false);
    shown = false;
    panelH = 0;
    setMaxH(undefined);
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

  const onPanelResize = (h: number) => {
    if (h === panelH) return;
    panelH = h;
    enqueue(layout);
  };

  return (
    <div class="widget" classList={{ "flip-x": flipX(), "flip-y": flipY() }}>
      <Show when={open()}>
        <Panel onResize={onPanelResize} maxH={maxH()} />
      </Show>
    </div>
  );
}

function Panel(props: { onResize: (h: number) => void; maxH: number | undefined }) {
  let el!: HTMLDivElement;
  let bodyEl!: HTMLDivElement;
  onMount(() => {
    const measure = () => {
      const cs = getComputedStyle(el);
      const chrome =
        (parseFloat(cs.paddingTop) || 0) +
        (parseFloat(cs.paddingBottom) || 0) +
        (parseFloat(cs.borderTopWidth) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0);
      props.onResize(Math.ceil(bodyEl.offsetHeight + chrome));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(bodyEl);
    onCleanup(() => ro.disconnect());
  });

  const m = () => metrics();

  return (
    <div
      class="panel"
      ref={el}
      style={{ "--panel-max-h": props.maxH != null ? `${props.maxH}px` : undefined }}
    >
      <div class="panel-body" ref={bodyEl}>
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
  const ringFallbackItem = (): ModuleItem[] => {
    const o = out();
    if (!o || o.kind === "error" || o.value == null) return [];
    return [{ group: null, label: "", text: text(), value: o.value, color: color() ?? null }];
  };

  return (
    <Show
      when={items().length === 0}
      fallback={
        <Switch fallback={<ModuleItems mod={props.mod} out={out()!} click={click} title={rowTitle()} />}>
          <Match when={props.mod.style === "rings"}>
            <ModuleRings mod={props.mod} out={out()!} click={click} title={rowTitle()} />
          </Match>
          <Match when={props.mod.style === "cards"}>
            <ModuleCards mod={props.mod} out={out()!} click={click} title={rowTitle()} />
          </Match>
        </Switch>
      }
    >
      <Switch
        fallback={
          <>
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
          </>
        }
      >
        <Match when={props.mod.style === "rings"}>
          <div
            class="ring-card"
            classList={{ clickable: click.enabled(), "click-ok": click.flash() === "ok", "click-err": click.flash() === "err" }}
            title={rowTitle()}
            onClick={click.run}
          >
            <RingSvg size={36} items={ringFallbackItem()} loading={!out()} />
            <div class="ring-meta">
              <div class="ring-head">
                <span class="ring-name" title={props.mod.name}>{props.mod.name}</span>
              </div>
              <div class="ring-line">
                <span class="ring-line-left">
                  <Show when={!isErr() && ringFallbackItem()[0]}>
                    {(it) => <span class="ring-dot" style={{ background: ringItemColor(it(), 0) }} />}
                  </Show>
                  <span class="ring-v" classList={{ err: isErr() }} style={{ color: isErr() ? undefined : (color() ?? "#4cc2ff") }}>
                    {text()}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </Match>
        <Match when={props.mod.style === "cards"}>
          <div
            class="stat-card single"
            classList={{ clickable: click.enabled(), "click-ok": click.flash() === "ok", "click-err": click.flash() === "err" }}
            title={rowTitle()}
            onClick={click.run}
          >
            <div class="stat-card-head">
              <span class="stat-card-label">{props.mod.name}</span>
            </div>
            <div class="stat-card-val" classList={{ err: isErr() }} style={{ color: isErr() ? undefined : (color() ?? "#4cd97b") }}>
              {text()}
            </div>
          </div>
        </Match>
      </Switch>
    </Show>
  );
}

function ModuleHeader(props: { mod: ModuleConfig; sum: string; click: ModuleClick; title?: string }) {
  return (
    <div
      class="row module"
      classList={{ clickable: props.click.enabled(), "click-ok": props.click.flash() === "ok", "click-err": props.click.flash() === "err" }}
      title={props.title}
      onClick={props.click.run}
    >
      <span class="label" title={props.mod.name}>{props.mod.name}</span>
      <span class="value module-sum">{props.sum}</span>
    </div>
  );
}

/** 多行模块：标题行 + 按 group 分组的条目，每条有数值时带进度条 */
function ModuleItems(props: { mod: ModuleConfig; out: ModuleOutput; click: ModuleClick; title?: string }) {
  const items = () => props.out.items ?? [];
  return (
    <>
      <ModuleHeader mod={props.mod} sum={props.out.text} click={props.click} title={props.title} />
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

/* ---------- 嵌套圆环样式（style: "rings"） ---------- */

const RING_BLUE = "#4cc2ff";
const RING_PURPLE = "#a78bfa";
const RING_TEAL = "#5eead4";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function ringItemColor(it: ModuleItem, idx: number): string {
  if (it.color) return it.color;
  const lbl = it.label.trim().toLowerCase();
  if (lbl === "7d" || lbl === "weekly" || lbl === "周") return RING_PURPLE;
  return idx === 0 ? RING_BLUE : idx === 1 ? RING_PURPLE : RING_TEAL;
}

const isWarnBadge = (b?: string | null) => !!b && /暂停|停|限|错/.test(b);
const isPausedBadge = (b?: string | null) => !!b && /暂停/.test(b);

interface RingSpec {
  r: number;
  sw: number;
}

const RING_LAYOUTS: Record<30 | 36, Record<1 | 2 | 3, RingSpec[]>> = {
  36: {
    1: [{ r: 14.5, sw: 3.2 }],
    2: [{ r: 17.5, sw: 3.2 }, { r: 11.8, sw: 2.8 }],
    3: [{ r: 18.5, sw: 2.6 }, { r: 13.5, sw: 2.4 }, { r: 8.5, sw: 2.2 }],
  },
  30: {
    1: [{ r: 12, sw: 2.8 }],
    2: [{ r: 14, sw: 2.8 }, { r: 9.2, sw: 2.5 }],
    3: [{ r: 14.5, sw: 2.4 }, { r: 10.5, sw: 2.2 }, { r: 6.5, sw: 2.0 }],
  },
};

function useRingReady() {
  const [ready, setReady] = createSignal(false);
  onMount(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    onCleanup(() => cancelAnimationFrame(id));
  });
  return ready;
}

function RingSvg(props: { size: 30 | 36; items: ModuleItem[]; loading?: boolean }) {
  const ready = useRingReady();
  const vb = () => (props.size === 30 ? 36 : 44);
  const cx = () => vb() / 2;
  const numeric = () => props.items.filter((it) => it.value != null).slice(0, 3);
  const specs = () => {
    const n = numeric().length;
    const key = (n >= 3 ? 3 : n === 2 ? 2 : 1) as 1 | 2 | 3;
    return RING_LAYOUTS[props.size][key];
  };

  return (
    <svg class="ring-svg" viewBox={`0 0 ${vb()} ${vb()}`} width={props.size} height={props.size}>
      <Show
        when={numeric().length > 0}
        fallback={
          <>
            <circle class="ring-track" cx={cx()} cy={cx()} r={specs()[0].r} stroke-width={specs()[0].sw} />
            <Show when={!props.loading}>
              <text class="ring-err-mark" x={cx()} y={cx() + 0.5}>!</text>
            </Show>
          </>
        }
      >
        <Index each={numeric()}>
          {(it, i) => {
            const spec = () => specs()[i] ?? specs()[specs().length - 1];
            const circ = () => 2 * Math.PI * spec().r;
            const ratio = () => clamp01(it().value ?? 0);
            const dashOffset = () => circ() * (1 - (ready() ? ratio() : 0));
            return (
              <>
                <circle class="ring-track" cx={cx()} cy={cx()} r={spec().r} stroke-width={spec().sw} />
                <circle
                  class="ring-arc"
                  cx={cx()}
                  cy={cx()}
                  r={spec().r}
                  stroke={ringItemColor(it(), i)}
                  stroke-width={spec().sw}
                  transform={`rotate(-90 ${cx()} ${cx()})`}
                  stroke-dasharray={circ().toFixed(2)}
                  stroke-dashoffset={dashOffset().toFixed(2)}
                />
              </>
            );
          }}
        </Index>
      </Show>
    </svg>
  );
}

interface PoolBlock {
  name: string;
  desc: string | null;
  items: ModuleItem[];
}

interface GroupBlock {
  name: string;
  badge: string | null;
  items: ModuleItem[];
  pools: PoolBlock[];
}

function groupRingItems(items: ModuleItem[]): GroupBlock[] {
  const groups: GroupBlock[] = [];
  for (const it of items) {
    const name = it.group?.trim() || "默认";
    let g = groups[groups.length - 1];
    if (!g || g.name !== name) {
      g = { name, badge: it.badge ?? null, items: [], pools: [] };
      groups.push(g);
    } else if (!g.badge && it.badge) {
      g.badge = it.badge;
    }
    g.items.push(it);
  }
  for (const g of groups) {
    if (g.items.some((it) => !!it.subgroup?.trim())) {
      for (const it of g.items) {
        const subName = it.subgroup?.trim() || it.label || g.name;
        let p = g.pools[g.pools.length - 1];
        if (!p || p.name !== subName) {
          p = { name: subName, desc: it.desc ?? null, items: [] };
          g.pools.push(p);
        } else if (!p.desc && it.desc) {
          p.desc = it.desc;
        }
        p.items.push(it);
      }
    }
  }
  return groups;
}

function formatTooltip(title: string, items: ModuleItem[], desc?: string | null): string {
  const lines = [title];
  if (desc) lines.push(desc);
  for (const it of items) {
    const parts = [it.label, it.text, it.sub].filter(Boolean);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

function ModuleRings(props: { mod: ModuleConfig; out: ModuleOutput; click: ModuleClick; title?: string }) {
  const groups = () => groupRingItems(props.out.items ?? []);
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
  const toggleGroup = (name: string) =>
    setCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));

  return (
    <>
      <ModuleHeader mod={props.mod} sum={props.out.text} click={props.click} title={props.title} />
      <div class="ring-list">
        <Index each={groups()}>
          {(g) => (
            <Show
              when={g().pools.length > 0}
              fallback={<SinglePoolRingCard group={g()} />}
            >
              <MultiPoolRingGroup
                group={g()}
                collapsed={!!collapsed()[g().name]}
                onToggle={() => toggleGroup(g().name)}
              />
            </Show>
          )}
        </Index>
      </div>
    </>
  );
}

function SinglePoolRingCard(props: { group: GroupBlock }) {
  const paused = () => isPausedBadge(props.group.badge);
  const tip = () => formatTooltip(props.group.name, props.group.items);
  return (
    <div class="ring-card" classList={{ dimmed: paused() }} title={tip()}>
      <RingSvg size={36} items={props.group.items} />
      <div class="ring-meta">
        <div class="ring-head">
          <span class="ring-name">{props.group.name}</span>
          <Show when={props.group.badge}>
            {(b) => (
              <span class="ring-badge" classList={{ warn: isWarnBadge(b()) }}>{b()}</span>
            )}
          </Show>
        </div>
        <Index each={props.group.items}>
          {(it, i) => {
            const col = () => ringItemColor(it(), i);
            return (
              <div class="ring-line">
                <span class="ring-line-left">
                  <Show when={it().value != null}>
                    <span class="ring-dot" style={{ background: col() }} />
                  </Show>
                  <Show when={it().label && it().label !== "—"}>
                    <span class="ring-k">{it().label}</span>
                  </Show>
                  <span class="ring-v" style={{ color: it().value != null ? col() : "#9a9aa4" }}>{it().text}</span>
                </span>
                <Show when={it().sub}>
                  {(s) => <span class="ring-sub">{s()}</span>}
                </Show>
              </div>
            );
          }}
        </Index>
      </div>
    </div>
  );
}

function MultiPoolRingGroup(props: { group: GroupBlock; collapsed: boolean; onToggle: () => void }) {
  const [hoveredPool, setHoveredPool] = createSignal<string | null>(null);
  const activePool = () => {
    const key = hoveredPool();
    return key ? props.group.pools.find((p) => p.name === key) ?? null : null;
  };
  const tightest = () => {
    let best: ModuleItem | null = null;
    for (const it of props.group.items) {
      if (it.value == null) continue;
      if (!best || it.value < best.value!) best = it;
    }
    return best;
  };
  const cols = () => (props.group.pools.length >= 3 ? 3 : Math.max(1, props.group.pools.length));

  return (
    <div class="ring-grp" classList={{ dimmed: isPausedBadge(props.group.badge) }}>
      <div
        class="ring-grp-head"
        title="点击折叠 / 展开模型池"
        onClick={props.onToggle}
      >
        <div class="ring-grp-left">
          <span class="ring-chev">{props.collapsed ? "▸" : "▾"}</span>
          <span class="ring-name">{props.group.name}</span>
          <Show when={props.group.badge}>
            {(b) => (
              <span class="ring-badge" classList={{ warn: isWarnBadge(b()) }}>{b()}</span>
            )}
          </Show>
        </div>
        <span
          class="ring-grp-sum"
          style={{ color: props.collapsed ? (tightest()?.color ?? undefined) : undefined }}
        >
          {props.collapsed && tightest()
            ? `最低 ${(clamp01(tightest()!.value!) * 100).toFixed(0)}% · ${props.group.pools.length} 池`
            : `${props.group.pools.length} 模型池`}
        </span>
      </div>

      <Show when={!props.collapsed}>
        <div class="ring-mini-grid" style={{ "grid-template-columns": `repeat(${cols()}, minmax(0, 1fr))` }}>
          <Index each={props.group.pools}>
            {(pool) => (
              <div
                class="ring-mini"
                title={formatTooltip(`${props.group.name} · ${pool().name}`, pool().items, pool().desc)}
                onMouseEnter={() => setHoveredPool(pool().name)}
                onMouseLeave={() => setHoveredPool((cur) => (cur === pool().name ? null : cur))}
              >
                <RingSvg size={30} items={pool().items} />
                <span class="ring-mini-name">{pool().name}</span>
                <div class="ring-mini-vals">
                  <Index each={pool().items}>
                    {(it, idx) => (
                      <>
                        <Show when={idx > 0}><span class="ring-mini-sep">/</span></Show>
                        <span style={{ color: it().value != null ? ringItemColor(it(), idx) : "#9a9aa4" }}>{it().text}</span>
                      </>
                    )}
                  </Index>
                </div>
              </div>
            )}
          </Index>
        </div>
      </Show>

      <Show when={!props.collapsed && activePool()}>
        {(pool) => (
          <div class="ring-tip">
            <div class="ring-tip-title">
              <span>{props.group.name} · {pool().name}</span>
            </div>
            <Show when={pool().desc}>
              {(d) => <div class="ring-tip-desc">{d()}</div>}
            </Show>
            <Index each={pool().items}>
              {(it, i) => {
                const col = () => ringItemColor(it(), i);
                return (
                  <div class="ring-tip-row">
                    <span>
                      <Show when={it().value != null}>
                        <span class="ring-dot inline" style={{ background: col() }} />
                      </Show>
                      {it().label} {it().text}
                    </span>
                    <Show when={it().sub}>
                      {(s) => <span class="ring-tip-sub">{s() === "已重置" ? "已重置" : `${s()} 后重置`}</span>}
                    </Show>
                  </div>
                );
              }}
            </Index>
          </div>
        )}
      </Show>
    </div>
  );
}

/* ---------- 指标卡样式（style: "cards"） ---------- */

const CARD_PALETTE = ["#4cd97b", "#4cc2ff", "#a78bfa", "#5eead4"];

function cardItemColor(it: ModuleItem, idx: number): string {
  return it.color ?? CARD_PALETTE[idx % CARD_PALETTE.length];
}

function ModuleCards(props: { mod: ModuleConfig; out: ModuleOutput; click: ModuleClick; title?: string }) {
  const items = () => props.out.items ?? [];
  const [hoveredIdx, setHoveredIdx] = createSignal<number | null>(null);
  const hoveredItem = () => {
    const idx = hoveredIdx();
    return idx != null ? items()[idx] ?? null : null;
  };
  const cols = () => {
    const n = items().length;
    if (n <= 1) return 1;
    return n === 2 || n === 4 ? 2 : 3;
  };

  return (
    <>
      <ModuleHeader mod={props.mod} sum={props.out.text} click={props.click} title={props.title} />
      <div class="stat-wrap">
        <div class="stat-grid" style={{ "grid-template-columns": `repeat(${cols()}, minmax(0, 1fr))` }}>
          <Index each={items()}>
            {(it, idx) => (
              <div
                class="stat-card"
                title={it().desc ? `${it().label}\n${it().desc}` : it().label}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx((cur) => (cur === idx ? null : cur))}
              >
                <div class="stat-card-head">
                  <span class="stat-card-label">{it().label}</span>
                  <Show when={it().badge}>
                    {(b) => (
                      <span class="ring-badge" classList={{ warn: isWarnBadge(b()) }}>{b()}</span>
                    )}
                  </Show>
                </div>
                <div class="stat-card-val" style={{ color: cardItemColor(it(), idx) }}>{it().text}</div>
                <Show when={it().sub}>
                  {(s) => <div class="stat-card-sub">{s()}</div>}
                </Show>
              </div>
            )}
          </Index>
        </div>
        <Show when={hoveredItem()?.desc}>
          {(desc) => (
            <div class="stat-tip">
              <div class="ring-tip-title">{hoveredItem()!.label}</div>
              <div class="stat-tip-desc">{desc()}</div>
            </div>
          )}
        </Show>
      </div>
    </>
  );
}
