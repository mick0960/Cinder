import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppConfig, ModuleConfig } from "../../types";

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

type Status = { kind: "info" | "ok" | "warn" | "error"; text: string } | null;

export function Settings() {
  const [modules, setModules] = createSignal<ModuleConfig[]>([]);
  const [saved, setSaved] = createSignal("[]");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<Status>(null);
  const [testResult, setTestResult] = createSignal<any>(null);
  const [testing, setTesting] = createSignal(false);
  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);

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
    if (pendingDelete() !== id) {
      setPendingDelete(id);
      clearTimeout(deleteTimer);
      deleteTimer = window.setTimeout(() => setPendingDelete(null), 3000);
      return;
    }
    clearTimeout(deleteTimer);
    setPendingDelete(null);
    setStatus(null);
    setModules((ms) => ms.filter((m) => m.id !== id));
    if (selected() === id) {
      setSelected(modules()[0]?.id ?? null);
      setTestResult(null);
    }
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

  const save = async () => {
    const empty = modules().find((m) => !m.name.trim() || !m.command.trim());
    if (empty) {
      select(empty.id);
      setStatus({ kind: "warn", text: "名称和命令不能为空" });
      return;
    }
    setStatus({ kind: "info", text: "保存中…" });
    try {
      await invoke("save_modules", { modules: modules() });
      setSaved(JSON.stringify(modules()));
      setStatus({ kind: "ok", text: "已保存并生效" });
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
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
        setTimeout(() => (warned = false), 5000);
      }
    });
    onCleanup(() => un.then((f) => f()));
  });

  const footerText = () => status()?.text ?? (dirty() ? "有未保存的修改" : "");
  const footerKind = () => status()?.kind ?? (dirty() ? "warn" : "info");

  return (
    <div class="settings">
      <div class="cols">
        <div class="left">
          <div class="left-head">
            <span>模块</span>
            <button onClick={add}>＋ 新增</button>
          </div>
          <div class="mlist">
            <For each={modules()}>
              {(m) => (
                <div
                  class="mitem"
                  classList={{ active: m.id === selected() }}
                  onClick={() => select(m.id)}
                >
                  <span class="mname">{m.name || "（未命名）"}</span>
                  <span class="mstyle">{STYLE_LABEL[m.style] ?? m.style}</span>
                  <button
                    class="del"
                    classList={{ confirm: pendingDelete() === m.id }}
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      askRemove(m.id);
                    }}
                  >
                    {pendingDelete() === m.id ? "确认删除" : "×"}
                  </button>
                </div>
              )}
            </For>
            <Show when={modules().length === 0}>
              <div class="empty">暂无模块，点击“新增”添加</div>
            </Show>
          </div>
        </div>

        <div class="right">
          <Show
            when={editing()}
            fallback={<div class="empty">选择或新增一个模块进行编辑</div>}
          >
            {(m) => (
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
                <div class="grid2">
                  <label>Shell
                    <select value={m().shell} onChange={(e) => patch({ shell: e.currentTarget.value as ModuleConfig["shell"] })}>
                      <For each={SHELLS}>{([v, t]) => <option value={v}>{t}</option>}</For>
                    </select>
                  </label>
                  <label>展示样式
                    <select value={m().style} onChange={(e) => patch({ style: e.currentTarget.value as ModuleConfig["style"] })}>
                      <For each={STYLES}>{([v, t]) => <option value={v}>{t}</option>}</For>
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
                  <label>输出格式
                    <select value={m().format} onChange={(e) => patch({ format: e.currentTarget.value as ModuleConfig["format"] })}>
                      <For each={FORMATS}>{([v, t]) => <option value={v}>{t}</option>}</For>
                    </select>
                  </label>
                  <label>单位（可选）
                    <input placeholder="如 °C、ms" value={m().unit ?? ""}
                      onInput={(e) => patch({ unit: e.currentTarget.value || null })} />
                  </label>
                  <label>颜色
                    <div class="color-row">
                      <input type="color" value={m().color ?? "#4cc2ff"}
                        onInput={(e) => patch({ color: e.currentTarget.value })} />
                      <span class="hint">{m().color ?? "默认"}</span>
                      <Show when={m().color}>
                        <button class="link" onClick={() => patch({ color: null })}>恢复默认</button>
                      </Show>
                    </div>
                  </label>
                </div>
                <div class="btnrow">
                  <button onClick={test} disabled={testing()}>{testing() ? "运行中…" : "测试运行"}</button>
                </div>
                <Show when={testResult()}>
                  {(r) => (
                    <div class="test-result" classList={{ fail: !r().ok }}>
                      <div class="meta">{r().ok ? "成功" : "失败"} · 耗时 {r().ms} ms</div>
                      <Show when={r().ok} fallback={<div class="err">{r().error}</div>}>
                        <div>文本：{r().output?.text || "—"}</div>
                        <div>数值：{r().output?.value ?? "—"}</div>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>

      <div class="footer">
        <span class={`status ${footerKind()}`}>{footerText()}</span>
        <button class="primary" onClick={save} title="Ctrl+S">保存并生效</button>
      </div>
    </div>
  );
}
