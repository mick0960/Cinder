import { createEffect, createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppConfig, ModuleConfig } from "../../types";
import { RunnerSettings } from "./RunnerSettings";
import { GeneralSettings } from "./GeneralSettings";
import { AboutSettings } from "./AboutSettings";
import { ModuleForm, type TestResult } from "./ModuleForm";
import { TemplateDialog } from "./TemplateDialog";
import { ShareDialog } from "./ShareDialog";
import { StyleGlyph } from "./StylePicker";
import { blankModule, moduleProblem, STYLE_LABEL, TYPE_LABEL, targetOf } from "./moduleModel";
import { fromTemplate, type ModuleTemplate } from "./templates";
import { COLOR_OK } from "../components/ModuleStyles";
import "./settings.css";

const DELETE_CONFIRM_MS = 3000;

type Status = { kind: "info" | "ok" | "warn" | "error"; text: string } | null;
type Dialog = "templates" | "share" | null;

/** 列表里模块名旁边的小标签：非默认的类型 / 常驻进程 */
const typeTag = (m: ModuleConfig) => (m.type === "command" ? (m.persistent ? "常驻" : null) : TYPE_LABEL[m.type]);

export function Settings() {
  const [tab, setTab] = createSignal<"modules" | "runners" | "general" | "about">("modules");
  const [modules, setModules] = createSignal<ModuleConfig[]>([]);
  const [saved, setSaved] = createSignal("[]");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<Status>(null);
  const [testResult, setTestResult] = createSignal<TestResult | null>(null);
  const [testing, setTesting] = createSignal(false);
  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);
  const [leaving, setLeaving] = createSignal<string | null>(null);
  const [justSaved, setJustSaved] = createSignal(false);
  const [saveShake, setSaveShake] = createSignal(false);
  const [dialog, setDialog] = createSignal<Dialog>(null);
  const [dragFrom, setDragFrom] = createSignal<number | null>(null);
  const [dropPos, setDropPos] = createSignal<{ index: number; after: boolean } | null>(null);
  let listEl!: HTMLDivElement;

  invoke<AppConfig>("get_config").then((c) => {
    setModules(c.modules ?? []);
    setSaved(JSON.stringify(c.modules ?? []));
    if (c.modules?.length) setSelected(c.modules[0].id);
  });

  const dirty = createMemo(() => JSON.stringify(modules()) !== saved());
  const editing = () => modules().find((m) => m.id === selected()) ?? null;

  const update = (fn: (m: ModuleConfig) => ModuleConfig) => {
    setStatus(null);
    setModules((ms) => ms.map((m) => (m.id === selected() ? fn(m) : m)));
  };

  const select = (id: string) => {
    setSelected(id);
    setTestResult(null);
  };

  /** 把新模块追加到列表末尾、选中它，并滚动到可见位置 */
  const append = (added: ModuleConfig[], message: string) => {
    setModules((ms) => [...ms, ...added]);
    select(added[0].id);
    setStatus({ kind: "info", text: message });
    requestAnimationFrame(() => document.querySelector(".mitem.active")?.scrollIntoView({ block: "nearest" }));
  };

  const add = () => append([blankModule()], "已新增一个模块，填好后点击“保存并生效”");

  const addFromTemplate = (t: ModuleTemplate) => {
    const m = fromTemplate(t);
    setDialog(null);
    append([m], `已添加「${m.name}」，点击“保存并生效”后出现在面板里`);
  };

  const importModules = (mods: ModuleConfig[]) => {
    setDialog(null);
    append(mods, `已导入 ${mods.length} 个模块，请检查后点击“保存并生效”`);
  };

  // 删除需要二次确认：第一次点击变为“确认删除”，3 秒内再点一次才生效
  let deleteTimer = 0;
  const askRemove = (id: string) => {
    if (leaving()) return;
    if (pendingDelete() !== id) {
      setPendingDelete(id);
      clearTimeout(deleteTimer);
      deleteTimer = window.setTimeout(() => setPendingDelete(null), DELETE_CONFIRM_MS);
      return;
    }
    clearTimeout(deleteTimer);
    setPendingDelete(null);
    // 先播放收起动画再真正移除
    setLeaving(id);
    window.setTimeout(() => {
      setLeaving(null);
      setStatus(null);
      setModules((ms) => ms.filter((m) => m.id !== id));
      if (selected() === id) {
        setSelected(modules()[0]?.id ?? null);
        setTestResult(null);
      }
    }, 220);
  };

  const test = async () => {
    const m = editing();
    if (!m || testing()) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await invoke<TestResult>("test_module", { cfg: m }));
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  let savedTimer = 0;
  const flashSaveError = () => {
    setSaveShake(false);
    requestAnimationFrame(() => setSaveShake(true));
  };
  const save = async () => {
    for (const m of modules()) {
      const problem = moduleProblem(m);
      if (problem) {
        select(m.id);
        setStatus({ kind: "warn", text: problem });
        flashSaveError();
        return;
      }
    }
    setStatus({ kind: "info", text: "保存中…" });
    try {
      await invoke("save_modules", { modules: modules() });
      setSaved(JSON.stringify(modules()));
      setStatus({ kind: "ok", text: "已保存并生效" });
      setJustSaved(true);
      clearTimeout(savedTimer);
      savedTimer = window.setTimeout(() => setJustSaved(false), 1600);
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
      flashSaveError();
    }
  };

  // 拖动排序（Pointer Events）：避开 WebView2 原生文件拖放冲突，兼顾点击选中与自动滚动
  const DRAG_THRESHOLD = 5;
  const SCROLL_ZONE = 28;
  let drag: {
    pointerId: number;
    el: HTMLElement;
    from: number;
    startY: number;
    lastY: number;
    active: boolean;
    slot: number;
    raf: number;
  } | null = null;
  let suppressClick = false;

  const updateDropTarget = (clientY: number) => {
    if (!drag || !listEl) return;
    const rows = listEl.querySelectorAll<HTMLElement>(".mitem");
    let slot = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        slot = i;
        break;
      }
    }
    drag.slot = slot;
    if (slot === drag.from || slot === drag.from + 1) {
      setDropPos(null);
    } else if (slot < rows.length) {
      setDropPos({ index: slot, after: false });
    } else if (rows.length > 0) {
      setDropPos({ index: rows.length - 1, after: true });
    }
  };

  const tickAutoScroll = () => {
    if (!drag?.active || !listEl) return;
    const rect = listEl.getBoundingClientRect();
    let delta = 0;
    if (drag.lastY < rect.top + SCROLL_ZONE) {
      delta = -Math.max(2, Math.round(((rect.top + SCROLL_ZONE - drag.lastY) / SCROLL_ZONE) * 10));
    } else if (drag.lastY > rect.bottom - SCROLL_ZONE) {
      delta = Math.max(2, Math.round(((drag.lastY - (rect.bottom - SCROLL_ZONE)) / SCROLL_ZONE) * 10));
    }
    if (delta !== 0) {
      const prev = listEl.scrollTop;
      listEl.scrollTop += delta;
      if (listEl.scrollTop !== prev) updateDropTarget(drag.lastY);
    }
    drag.raf = requestAnimationFrame(tickAutoScroll);
  };

  const onDragMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastY = e.clientY;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      clearTimeout(deleteTimer);
      setPendingDelete(null);
      setDragFrom(drag.from);
      document.body.classList.add("dragging-modules");
      try {
        drag.el.setPointerCapture(drag.pointerId);
      } catch {
        /* 忽略 capture 异常 */
      }
      drag.raf = requestAnimationFrame(tickAutoScroll);
    }
    updateDropTarget(e.clientY);
  };

  const finishDrag = (commit: boolean) => {
    if (!drag) return;
    const state = drag;
    drag = null;
    cancelAnimationFrame(state.raf);
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragUp);
    window.removeEventListener("pointercancel", onDragCancel);
    window.removeEventListener("keydown", onDragKey);
    document.body.classList.remove("dragging-modules");
    try {
      if (state.el.hasPointerCapture(state.pointerId)) {
        state.el.releasePointerCapture(state.pointerId);
      }
    } catch {
      /* 忽略 */
    }
    setDragFrom(null);
    setDropPos(null);

    if (state.active) {
      suppressClick = true;
      window.setTimeout(() => (suppressClick = false), 0);
      if (commit && state.slot !== state.from && state.slot !== state.from + 1) {
        const to = state.slot > state.from ? state.slot - 1 : state.slot;
        setModules((ms) => {
          if (state.from < 0 || state.from >= ms.length || to < 0 || to >= ms.length) return ms;
          const next = [...ms];
          const [moved] = next.splice(state.from, 1);
          next.splice(to, 0, moved);
          return next;
        });
        setStatus(null);
      }
    }
  };

  const onDragUp = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId) finishDrag(true);
  };
  const onDragCancel = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId) finishDrag(false);
  };
  const onDragKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && drag?.active) {
      e.preventDefault();
      finishDrag(false);
    }
  };

  const onItemPointerDown = (e: PointerEvent, index: number) => {
    if (e.button !== 0 || leaving() || modules().length <= 1) return;
    if ((e.target as HTMLElement | null)?.closest(".del")) return;
    finishDrag(false);
    drag = {
      pointerId: e.pointerId,
      el: e.currentTarget as HTMLElement,
      from: index,
      startY: e.clientY,
      lastY: e.clientY,
      active: false,
      slot: index,
      raf: 0,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
    window.addEventListener("pointercancel", onDragCancel);
    window.addEventListener("keydown", onDragKey);
  };

  onCleanup(() => finishDrag(false));

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));

    // 面板内折叠状态变化时同步到当前列表与已保存基线，避免误判未保存或保存时覆盖
    const unCollapsed = listen<{ id: string; collapsed: boolean }>("module://collapsed", (e) => {
      const { id, collapsed } = e.payload;
      setModules((ms) => ms.map((m) => (m.id === id ? { ...m, collapsed } : m)));
      setSaved((prev) => {
        try {
          const list = JSON.parse(prev) as ModuleConfig[];
          return JSON.stringify(list.map((m) => (m.id === id ? { ...m, collapsed } : m)));
        } catch {
          return prev;
        }
      });
    });
    onCleanup(() => unCollapsed.then((f) => f()));

    // 有未保存修改时拦截一次关闭
    let warned = false;
    const un = getCurrentWindow().onCloseRequested((e) => {
      if (dirty() && !warned) {
        e.preventDefault();
        warned = true;
        setStatus({ kind: "warn", text: "有未保存的修改，再次关闭将放弃修改" });
        flashSaveError();
        setTimeout(() => (warned = false), 5000);
      }
    });
    onCleanup(() => un.then((f) => f()));
  });

  const footerText = () => status()?.text ?? (dirty() ? "有未保存的修改" : "");
  const footerKind = () => status()?.kind ?? (dirty() ? "warn" : "info");

  // 标签页下划线：跟随当前标签滑动
  const tabEls: Record<string, HTMLButtonElement> = {};
  const [ink, setInk] = createSignal({ x: 0, w: 0 });
  const measureInk = () => {
    const el = tabEls[tab()];
    if (el) setInk({ x: el.offsetLeft, w: el.offsetWidth });
  };
  createEffect(() => {
    tab();
    measureInk();
  });
  onMount(() => {
    measureInk();
    document.fonts?.ready.then(measureInk);
  });

  const Tab = (p: { id: "modules" | "runners" | "general" | "about"; children: string }) => (
    <button
      ref={(el) => (tabEls[p.id] = el)}
      class="tab"
      classList={{ active: tab() === p.id }}
      onClick={() => setTab(p.id)}
    >
      {p.children}
    </button>
  );

  return (
    <div class="settings">
      <div class="tabs">
        <Tab id="modules">监控模块</Tab>
        <Tab id="runners">角色 / Runner</Tab>
        <Tab id="general">通用</Tab>
        <Tab id="about">关于</Tab>
        <span class="tab-ink" style={{ transform: `translateX(${ink().x}px)`, width: `${ink().w}px` }} />
      </div>
      <Show when={tab() === "runners"}>
        <RunnerSettings />
      </Show>
      <Show when={tab() === "general"}>
        <GeneralSettings />
      </Show>
      <Show when={tab() === "about"}>
        <AboutSettings />
      </Show>
      <div class="cols pane-in" style={{ display: tab() === "modules" ? "flex" : "none" }}>
        <div class="left">
          <div class="left-head">
            <span>模块 <span class="count">{modules().length}</span></span>
            <button class="add" onClick={add}><span class="plus">＋</span> 新增</button>
          </div>
          <div class="left-tools">
            <button onClick={() => setDialog("templates")} title="一键添加常用模块">📚 模板库</button>
            <button onClick={() => setDialog("share")} title="复制模块配置分享给别人，或导入别人分享的配置">⇄ 导入 / 导出</button>
          </div>
          <div class="mlist" classList={{ dragging: dragFrom() !== null }} ref={listEl}>
            {/* Index：编辑时模块对象会被替换，按位置复用节点，避免整行重建、入场动画重播 */}
            <Index each={modules()}>
              {(m, i) => (
                <div
                  class="mitem"
                  classList={{
                    active: m().id === selected(),
                    leaving: leaving() === m().id,
                    dragging: dragFrom() === i,
                    "drop-before": dropPos()?.index === i && !dropPos()?.after,
                    "drop-after": dropPos()?.index === i && !!dropPos()?.after,
                  }}
                  title={targetOf(m())}
                  onPointerDown={(e) => onItemPointerDown(e, i)}
                  onClick={() => {
                    if (suppressClick) return;
                    select(m().id);
                  }}
                >
                  <Show when={modules().length > 1}>
                    <span class="mhandle" title="拖动排序" aria-hidden="true">
                      <svg viewBox="0 0 8 14" width="8" height="14">
                        <circle cx="2" cy="3" r="1.1" />
                        <circle cx="6" cy="3" r="1.1" />
                        <circle cx="2" cy="7" r="1.1" />
                        <circle cx="6" cy="7" r="1.1" />
                        <circle cx="2" cy="11" r="1.1" />
                        <circle cx="6" cy="11" r="1.1" />
                      </svg>
                    </span>
                  </Show>
                  <span class="mdot" style={{ background: m().color ?? COLOR_OK }} />
                  <span class="mname">{m().name || "（未命名）"}</span>
                  <Show when={typeTag(m())}>{(tag) => <span class="mtag">{tag()}</span>}</Show>
                  <span class="mstyle" title={STYLE_LABEL[m().style] ?? m().style}><StyleGlyph style={m().style} /></span>
                  <button
                    class="del"
                    classList={{ confirm: pendingDelete() === m().id }}
                    style={{ "--confirm-ms": `${DELETE_CONFIRM_MS}ms` }}
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      askRemove(m().id);
                    }}
                  >
                    {pendingDelete() === m().id ? "确认删除" : "×"}
                  </button>
                </div>
              )}
            </Index>
            <Show when={modules().length === 0}>
              <div class="empty">
                <div class="empty-ico">📡</div>
                暂无模块，点击“新增”添加
                <br />
                或者 <button class="link" onClick={() => setDialog("templates")}>从模板库一键添加</button>
              </div>
            </Show>
          </div>
        </div>

        <div class="right">
          <Show
            when={editing()}
            fallback={
              <div class="empty">
                <div class="empty-ico">🛠️</div>
                选择或新增一个模块进行编辑
              </div>
            }
          >
            {(m) => (
              // 按模块 id 重新挂载：切换模块时表单逐项浮现，编辑时不重建
              <Show when={m().id} keyed>
                <ModuleForm m={m} update={update} test={test} testing={testing} result={testResult} />
              </Show>
            )}
          </Show>
        </div>
      </div>

      <div class="footer" style={{ display: tab() === "modules" ? "flex" : "none" }}>
        <Show when={footerText()} keyed fallback={<span class="status" />}>
          {(t) => <span class={`status ${footerKind()}`}>{t}</span>}
        </Show>
        <button
          class="primary save-btn"
          classList={{ dirty: dirty(), saved: justSaved(), shake: saveShake() }}
          onClick={save}
          onAnimationEnd={() => setSaveShake(false)}
          title="Ctrl+S"
        >
          <span class="save-dot" />
          {justSaved() ? "✓ 已保存" : "保存并生效"}
        </button>
      </div>

      <Show when={dialog() === "templates"}>
        <TemplateDialog onPick={addFromTemplate} onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog() === "share"}>
        <ShareDialog modules={modules()} selected={editing()} onImport={importModules} onClose={() => setDialog(null)} />
      </Show>
    </div>
  );
}
