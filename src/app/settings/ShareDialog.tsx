import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { ClickAction, ModuleConfig } from "../../types";
import { Modal } from "../components/Modal";
import { exportModules, parseImport, type ImportedModule } from "./share";
import { newId, TYPE_LABEL, targetOf } from "./moduleModel";

const COPIED_MS = 1800;

async function copyText(text: string, fallback: HTMLTextAreaElement | undefined): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 剪贴板接口不可用时退回选中 + 复制命令 */
  }
  if (!fallback) return false;
  fallback.focus();
  fallback.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

const describeClick = (c: ClickAction) => (c.kind === "url" ? `打开网址 ${c.target}` : `运行命令 ${c.target}`);

/** 一个模块导入后会做什么：给用户在点“添加”之前核对 */
function badges(m: ModuleConfig): string[] {
  const b = [TYPE_LABEL[m.type]];
  if (m.type === "command" && m.persistent) b.push("常驻进程");
  return b;
}

type Tab = "export" | "import";

/** 导出（复制成文本分享）与导入。导入的内容先逐条列出来，由用户确认后才加入列表，且仍需“保存并生效” */
export function ShareDialog(props: {
  modules: ModuleConfig[];
  selected: ModuleConfig | null;
  onImport: (mods: ModuleConfig[]) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>(props.modules.length ? "export" : "import");

  /* ---------- 导出 ---------- */
  const [scope, setScope] = createSignal<"one" | "all">(props.selected ? "one" : "all");
  const exported = createMemo(() => exportModules(scope() === "one" && props.selected ? [props.selected] : props.modules));
  const [copied, setCopied] = createSignal<boolean | null>(null);
  let copyTimer = 0;
  onCleanup(() => clearTimeout(copyTimer));
  let exportBox: HTMLTextAreaElement | undefined;
  const copy = async () => {
    setCopied(await copyText(exported(), exportBox));
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => setCopied(null), COPIED_MS);
  };

  /* ---------- 导入 ---------- */
  const [input, setInput] = createSignal("");
  const parsed = createMemo(() => (input().trim() ? parseImport(input()) : null));
  const [skipped, setSkipped] = createSignal<Set<number>>(new Set());
  createEffect(on(parsed, () => setSkipped(new Set<number>())));
  const toggle = (i: number) =>
    setSkipped((s) => {
      const next = new Set(s);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  const chosen = () => (parsed()?.items ?? []).filter((_, i) => !skipped().has(i));
  const runsCommands = () => chosen().some((it) => it.module.type === "command" || it.module.click?.kind === "command");
  const confirm = () => {
    const mods = chosen().map((it) => ({ ...it.module, id: newId() }));
    if (mods.length) props.onImport(mods);
  };

  return (
    <Modal title="导入 / 导出" wide onClose={props.onClose}>
      <div class="seg" role="tablist">
        <button type="button" role="tab" aria-selected={tab() === "export"} class="seg-btn" classList={{ active: tab() === "export" }} onClick={() => setTab("export")}>
          导出（分享给别人）
        </button>
        <button type="button" role="tab" aria-selected={tab() === "import"} class="seg-btn" classList={{ active: tab() === "import" }} onClick={() => setTab("import")}>
          导入
        </button>
      </div>

      <Show when={tab() === "export"}>
        <div class="share-pane">
          <Show when={props.modules.length > 0} fallback={<div class="help">还没有模块可以导出。</div>}>
            <Show when={props.selected}>
              <div class="seg small" role="radiogroup">
                <button type="button" role="radio" aria-checked={scope() === "one"} class="seg-btn" classList={{ active: scope() === "one" }} onClick={() => setScope("one")}>
                  当前模块
                </button>
                <button type="button" role="radio" aria-checked={scope() === "all"} class="seg-btn" classList={{ active: scope() === "all" }} onClick={() => setScope("all")}>
                  全部 {props.modules.length} 个模块
                </button>
              </div>
            </Show>
            <textarea
              ref={exportBox}
              class="share-text"
              readOnly
              spellcheck={false}
              value={exported()}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div class="help">
              把这段文本发给别人，对方在“导入”里粘贴即可。导出的只有模块配置本身（含尚未保存的修改）；
              如果命令或网址里写了密钥、令牌，它们也会被一并导出，分享前请先检查。
            </div>
            <div class="btnrow">
              <button type="button" class="primary" onClick={copy}>
                {copied() === true ? "✓ 已复制" : copied() === false ? "复制失败，请手动选中复制" : "复制到剪贴板"}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={tab() === "import"}>
        <div class="share-pane">
          <textarea
            class="share-text"
            spellcheck={false}
            placeholder={'在这里粘贴别人分享的模块配置（以 { 或 [ 开头的 JSON，也可以是带 ``` 的代码块）'}
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
          />

          <Show when={parsed()}>
            {(res) => (
              <>
                <Show when={res().errors.length}>
                  <div class="imp-errors">
                    <For each={res().errors}>{(e) => <div>⚠ {e}</div>}</For>
                  </div>
                </Show>
                <Show when={res().items.length}>
                  <div class="imp-warn" classList={{ strong: runsCommands() }}>
                    <Show
                      when={runsCommands()}
                      fallback={<>导入的模块会按下面列出的内容运行。请先看一遍再添加。</>}
                    >
                      <b>导入的命令会在你的电脑上直接运行</b>（保存后按刷新间隔反复执行，点击动作则在点击时执行）。
                      只导入来自可信来源的配置，并核对下面列出的每一条命令。
                    </Show>
                  </div>
                  <div class="imp-list">
                    <For each={res().items}>
                      {(it, i) => <ImportCard it={it} on={!skipped().has(i())} onToggle={() => toggle(i())} />}
                    </For>
                  </div>
                  <div class="btnrow">
                    <button type="button" class="primary" disabled={chosen().length === 0} onClick={confirm}>
                      添加 {chosen().length} 个模块到列表
                    </button>
                    <span class="help">添加后仍需点击“保存并生效”才会运行</span>
                  </div>
                </Show>
              </>
            )}
          </Show>
          <Show when={!parsed()}>
            <div class="help">支持：本对话框导出的文本、模块数组、单个模块，或完整的 config.json（只取其中的模块）。</div>
          </Show>
        </div>
      </Show>
    </Modal>
  );
}

function ImportCard(props: { it: ImportedModule; on: boolean; onToggle: () => void }) {
  const m = () => props.it.module;
  return (
    <div class="imp-card" classList={{ off: !props.on }}>
      {/* 只有勾选框和标题可点：命令文本要能选中复制，不应因此切换勾选 */}
      <label class="imp-head">
        <input type="checkbox" checked={props.on} onChange={props.onToggle} />
        <span class="imp-name">{m().name}</span>
        <For each={badges(m())}>{(b) => <span class="tpl-tag">{b}</span>}</For>
      </label>
      <pre class="imp-target">{targetOf(m())}</pre>
      <Show when={m().click}>{(c) => <div class="imp-line">点击时：{describeClick(c())}</div>}</Show>
      <Show when={m().thresholds.length}>
        <div class="imp-line">阈值着色：{m().thresholds.length} 条规则</div>
      </Show>
      <For each={props.it.notes}>{(n) => <div class="imp-note">⚠ {n}</div>}</For>
    </div>
  );
}
