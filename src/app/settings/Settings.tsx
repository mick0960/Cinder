import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppConfig, ModuleConfig } from "../../types";
import { RunnerSettings } from "./RunnerSettings";
import { AboutSettings } from "./AboutSettings";
import { COLOR_OK } from "../components/ModuleStyles";
import "./settings.css";

let nextId = Date.now();
const newModule = (): ModuleConfig => ({
  id: "m" + nextId++,
  type: "command",
  name: "新模块",
  command: "Write-Output 'hello'",
  shell: "powershell",
  intervalMs: 5000,
  timeoutMs: 3000,
  style: "text",
  format: "plain",
  color: null,
  unit: null,
});

const SHELLS: [ModuleConfig["shell"], string][] = [
  ["powershell", "Windows PowerShell"],
  ["pwsh", "PowerShell 7 (pwsh)"],
  ["cmd", "命令提示符 (cmd)"],
  ["direct", "直接运行程序"],
];
const STYLES: [ModuleConfig["style"], string][] = [
  ["text", "文本"],
  ["progress", "进度条"],
  ["sparkline", "趋势折线"],
];
const FORMATS: [ModuleConfig["format"], string][] = [
  ["plain", "纯文本"],
  ["json", "JSON（text / value / color）"],
];
const STYLE_LABEL = Object.fromEntries(STYLES) as Record<string, string>;
const PRESET_COLORS = ["#4cc2ff", "#4cd97b", "#ffb547", "#ff5d5d", "#c58cff", "#ff7ac6", "#5eead4"];
const DELETE_CONFIRM_MS = 3000;

type Status = { kind: "info" | "ok" | "warn" | "error"; text: string } | null;

/** 列表里的样式小图标 */
export function StyleGlyph(props: { style: ModuleConfig["style"] }) {
  return (
    <svg class="glyph" viewBox="0 0 16 16" width="14" height="14">
      <Show when={props.style === "text"}>
        <path d="M3 4h10M8 4v9" />
      </Show>
      <Show when={props.style === "progress"}>
        <rect x="1.5" y="6" width="13" height="4" rx="2" />
        <path class="solid" d="M3.5 8h5" />
      </Show>
      <Show when={props.style === "sparkline"}>
        <path d="M1.5 12l3.5-4 3 2.5 5.5-7" />
      </Show>
    </svg>
  );
}

/** 可视化的样式选择：每个选项带一个会动的小预览 */
function StylePicker(props: { value: ModuleConfig["style"]; color: string; onChange: (v: ModuleConfig["style"]) => void }) {
  return (
    <div class="style-picker" role="radiogroup" style={{ "--c": props.color }}>
      <For each={STYLES}>
        {([v, t]) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === v}
            class="style-card"
            classList={{ active: props.value === v }}
            onClick={() => props.onChange(v)}
          >
            <span class={`pv pv-${v}`}>
              <Show when={v === "text"}><span class="pv-text">42<small>°C</small></span></Show>
              <Show when={v === "progress"}><span class="pv-bar"><i /></span></Show>
              <Show when={v === "sparkline"}>
                <svg viewBox="0 0 60 18" width="60" height="18"><polyline points="0,14 10,10 18,12 28,5 36,8 46,3 60,7" /></svg>
              </Show>
            </span>
            <span class="pv-label">{t}</span>
          </button>
        )}
      </For>
    </div>
  );
}

export function Settings() {
  const [tab, setTab] = createSignal<"modules" | "runners" | "about">("modules");
  const [modules, setModules] = createSignal<ModuleConfig[]>([]);
  const [saved, setSaved] = createSignal("[]");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<Status>(null);
  const [testResult, setTestResult] = createSignal<any>(null);
  const [testing, setTesting] = createSignal(false);
  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);
  const [leaving, setLeaving] = createSignal<string | null>(null);
  const [justSaved, setJustSaved] = createSignal(false);
  const [saveShake, setSaveShake] = createSignal(false);

  invoke<AppConfig>("get_config").then((c) => {
    setModules(c.modules ?? []);
    setSaved(JSON.stringify(c.modules ?? []));
    if (c.modules?.length) setSelected(c.modules[0].id);
  });

  const dirty = createMemo(() => JSON.stringify(modules()) !== saved());
  const editing = () => modules().find((m) => m.id === selected()) ?? null;

  const patch = (p: Partial<ModuleConfig>) => {
    setStatus(null);
    setModules((ms) => ms.map((m) => (m.id === selected() ? { ...m, ...p } : m)));
  };

  const select = (id: string) => {
    setSelected(id);
    setTestResult(null);
  };

  const add = () => {
    const m = newModule();
    setStatus(null);
    setModules((ms) => [...ms, m]);
    select(m.id);
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
      setTestResult(await invoke("test_module", { cfg: m }));
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
    const empty = modules().find((m) => !m.name.trim() || !m.command.trim());
    if (empty) {
      select(empty.id);
      setStatus({ kind: "warn", text: "名称和命令不能为空" });
      flashSaveError();
      return;
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

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));

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

  const Tab = (p: { id: "modules" | "runners" | "about"; children: string }) => (
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
        <Tab id="about">关于</Tab>
        <span class="tab-ink" style={{ transform: `translateX(${ink().x}px)`, width: `${ink().w}px` }} />
      </div>
      <Show when={tab() === "runners"}>
        <RunnerSettings />
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
          <div class="mlist">
            {/* Index：编辑时模块对象会被替换，按位置复用节点，避免整行重建、入场动画重播 */}
            <Index each={modules()}>
              {(m) => (
                <div
                  class="mitem"
                  classList={{ active: m().id === selected(), leaving: leaving() === m().id }}
                  onClick={() => select(m().id)}
                >
                  <span class="mdot" style={{ background: m().color ?? COLOR_OK }} />
                  <span class="mname">{m().name || "（未命名）"}</span>
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
                <div class="form">
                  <label>名称
                    <input value={m().name} onInput={(e) => patch({ name: e.currentTarget.value })} />
                  </label>
                  <label>命令
                    <textarea
                      rows={4}
                      spellcheck={false}
                      value={m().command}
                      onInput={(e) => patch({ command: e.currentTarget.value })}
                    />
                  </label>
                  <div class="field">
                    <span class="field-label">展示样式</span>
                    <StylePicker value={m().style} color={m().color ?? COLOR_OK} onChange={(style) => patch({ style })} />
                  </div>
                  <div class="grid2">
                    <label>Shell
                      <select value={m().shell} onChange={(e) => patch({ shell: e.currentTarget.value as ModuleConfig["shell"] })}>
                        <For each={SHELLS}>{([v, t]) => <option value={v}>{t}</option>}</For>
                      </select>
                    </label>
                    <label>输出格式
                      <select value={m().format} onChange={(e) => patch({ format: e.currentTarget.value as ModuleConfig["format"] })}>
                        <For each={FORMATS}>{([v, t]) => <option value={v}>{t}</option>}</For>
                      </select>
                    </label>
                    <label>刷新间隔（毫秒）
                      <input type="number" min={500} step={500} value={m().intervalMs}
                        onChange={(e) => patch({ intervalMs: Math.max(500, +e.currentTarget.value || 500) })} />
                    </label>
                    <label>超时（毫秒）
                      <input type="number" min={500} step={500} value={m().timeoutMs}
                        onChange={(e) => patch({ timeoutMs: Math.max(500, +e.currentTarget.value || 500) })} />
                    </label>
                    <label>单位（可选）
                      <input placeholder="如 °C、ms" value={m().unit ?? ""}
                        onInput={(e) => patch({ unit: e.currentTarget.value || null })} />
                    </label>
                  </div>
                  <div class="field">
                    <span class="field-label">颜色</span>
                    <div class="color-row">
                      <button
                        type="button"
                        class="swatch auto"
                        classList={{ active: !m().color }}
                        title="默认"
                        onClick={() => patch({ color: null })}
                      >A</button>
                      <For each={PRESET_COLORS}>
                        {(c) => (
                          <button
                            type="button"
                            class="swatch"
                            classList={{ active: m().color?.toLowerCase() === c }}
                            style={{ "--sw": c }}
                            title={c}
                            onClick={() => patch({ color: c })}
                          />
                        )}
                      </For>
                      <label
                        class="swatch custom"
                        classList={{ active: !!m().color && !PRESET_COLORS.includes(m().color!.toLowerCase()) }}
                        title="自定义颜色"
                        style={{ "--sw": m().color ?? COLOR_OK }}
                      >
                        <input type="color" value={m().color ?? COLOR_OK}
                          onInput={(e) => patch({ color: e.currentTarget.value })} />
                      </label>
                      <span class="hint">{m().color ?? "默认"}</span>
                    </div>
                  </div>
                  <div class="btnrow">
                    <button class="test-btn" classList={{ busy: testing() }} onClick={test} disabled={testing()}>
                      <span class="spinner" />
                      <span class="play">▶</span>
                      {testing() ? "运行中…" : "测试运行"}
                    </button>
                  </div>
                  <Show when={testResult()} keyed>
                    {(r) => (
                      <div class="test-result" classList={{ fail: !r.ok }}>
                        <div class="meta">
                          <span class="result-ico">{r.ok ? "✓" : "✕"}</span>
                          {r.ok ? "成功" : "失败"} · 耗时 {r.ms} ms
                        </div>
                        <Show when={r.ok} fallback={<div class="err">{r.error}</div>}>
                          <div>文本：{r.output?.text || "—"}</div>
                          <div>数值：{r.output?.value ?? "—"}</div>
                          <Show when={r.output?.items?.length}>
                            <div>条目：{r.output.items.length}</div>
                            <For each={r.output.items}>
                              {(it: any) => (
                                <div class="item">
                                  {it.group ? `${it.group} / ` : ""}{it.label}：{it.text || "—"}
                                  {it.value != null ? ` (${it.value})` : ""}
                                </div>
                              )}
                            </For>
                          </Show>
                        </Show>
                      </div>
                    )}
                  </Show>
                </div>
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
    </div>
  );
}
