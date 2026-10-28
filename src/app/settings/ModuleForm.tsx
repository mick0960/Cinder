import { For, Show } from "solid-js";
import type { ModuleConfig, ModuleOutput } from "../../types";
import { COLOR_OK } from "../components/ModuleStyles";
import { FORMATS, MODULE_TYPES, PRESET_COLORS, SHELLS, withPersistent, withType } from "./moduleModel";
import { StylePicker } from "./StylePicker";

export interface TestResult {
  ok: boolean;
  ms: number;
  output?: ModuleOutput;
  error?: string;
}

/** 右侧的模块编辑表单。按模块 id 重新挂载（见 Settings.tsx）：切换模块时逐项浮现，编辑时不重建 */
export function ModuleForm(props: {
  m: () => ModuleConfig;
  update: (fn: (m: ModuleConfig) => ModuleConfig) => void;
  test: () => void;
  testing: () => boolean;
  result: () => TestResult | null;
}) {
  const m = props.m;
  const patch = (p: Partial<ModuleConfig>) => props.update((x) => ({ ...x, ...p }));

  const typeHint = () => MODULE_TYPES.find((t) => t.id === m().type)?.hint;
  const timeoutLabel = () =>
    m().type === "command" ? (m().persistent ? "无输出超时（毫秒）" : "超时（毫秒）") : "请求超时（毫秒）";
  const minInterval = () => (m().type === "http" ? 1000 : 500);

  return (
    <div class="form">
      <label>名称
        <input value={m().name} onInput={(e) => patch({ name: e.currentTarget.value })} />
      </label>

      <div class="field">
        <span class="field-label">数据来源</span>
        <div class="seg" role="radiogroup">
          <For each={MODULE_TYPES}>
            {(t) => (
              <button
                type="button"
                role="radio"
                aria-checked={m().type === t.id}
                class="seg-btn"
                classList={{ active: m().type === t.id }}
                onClick={() => props.update((x) => withType(x, t.id))}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
        <span class="help">{typeHint()}</span>
      </div>

      <Show when={m().type === "command"}>
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
          <label>输出格式
            <select value={m().format} onChange={(e) => patch({ format: e.currentTarget.value as ModuleConfig["format"] })}>
              <For each={FORMATS}>{([v, t]) => <option value={v}>{t}</option>}</For>
            </select>
          </label>
        </div>
        <label class="check">
          <input
            type="checkbox"
            checked={m().persistent}
            onChange={(e) => props.update((x) => withPersistent(x, e.currentTarget.checked))}
          />
          <span>
            常驻进程
            <small>
              命令只启动一次，之后每输出一行就刷新一次（如 <code>nvidia-smi -l 2</code>、带循环的脚本）。
              不用反复启动 shell，面板里的 CPU 曲线也不会被启动开销干扰。
            </small>
          </span>
        </label>
      </Show>

      <Show when={m().type === "http"}>
        <label>网址
          <input
            spellcheck={false}
            placeholder="https://api.example.com/status"
            value={m().url}
            onInput={(e) => patch({ url: e.currentTarget.value })}
          />
        </label>
        <label>JSON 字段路径（可选）
          <input
            spellcheck={false}
            placeholder="如 data.items[0].value；留空则显示整个响应文本"
            value={m().jsonPath}
            onInput={(e) => patch({ jsonPath: e.currentTarget.value })}
          />
        </label>
        <div class="help">
          发送 GET 请求，响应最大 1 MB，跟随系统代理。路径写法：<code>ip</code>、<code>data.temp</code>、<code>items[0].name</code>、
          <code>items[-1]</code>（最后一项）。
        </div>
      </Show>

      <Show when={m().type === "ping"}>
        <label>主机
          <input
            spellcheck={false}
            placeholder="域名或 IPv4 地址，如 223.5.5.5"
            value={m().host}
            onInput={(e) => patch({ host: e.currentTarget.value })}
          />
        </label>
        <div class="help">每次刷新发送一个 ICMP 回显请求，显示往返毫秒数。暂不支持 IPv6。</div>
      </Show>

      <div class="field">
        <span class="field-label">展示样式</span>
        <StylePicker value={m().style} color={m().color ?? COLOR_OK} onChange={(style) => patch({ style })} />
      </div>

      <div class="grid2">
        <Show when={!(m().type === "command" && m().persistent)}>
          <label>刷新间隔（毫秒）
            <input
              type="number"
              min={minInterval()}
              step={500}
              value={m().intervalMs}
              onChange={(e) => patch({ intervalMs: Math.max(minInterval(), +e.currentTarget.value || minInterval()) })}
            />
          </label>
        </Show>
        <Show when={m().type !== "gpu"}>
          <label>{timeoutLabel()}
            <input
              type="number"
              min={500}
              step={500}
              value={m().timeoutMs}
              onChange={(e) => patch({ timeoutMs: Math.max(500, +e.currentTarget.value || 500) })}
            />
          </label>
        </Show>
        <label>单位（可选）
          <input placeholder="如 °C、ms" value={m().unit ?? ""} onInput={(e) => patch({ unit: e.currentTarget.value || null })} />
        </label>
      </div>
      <Show when={m().type === "command" && m().persistent}>
        <div class="help">
          常驻进程按它自己的节奏输出，每行一次更新（输出格式为 JSON 时每行一个 JSON 对象）。
          “无输出超时”内一行都没有，就认为进程卡死并重启。面板收起 20 秒后进程会被结束，再次展开时重新启动。
        </div>
      </Show>

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
            <input type="color" value={m().color ?? COLOR_OK} onInput={(e) => patch({ color: e.currentTarget.value })} />
          </label>
          <span class="hint">{m().color ?? "默认"}</span>
        </div>
      </div>

      <div class="btnrow">
        <button class="test-btn" classList={{ busy: props.testing() }} onClick={props.test} disabled={props.testing()}>
          <span class="spinner" />
          <span class="play">▶</span>
          {props.testing() ? "运行中…" : "测试运行"}
        </button>
      </div>
      <Show when={props.result()} keyed>
        {(r) => (
          <div class="test-result" classList={{ fail: !r.ok }}>
            <div class="meta">
              <span class="result-ico">{r.ok ? "✓" : "✕"}</span>
              {r.ok ? "成功" : "失败"} · {m().type === "command" && m().persistent ? "首行输出耗时" : "耗时"} {r.ms} ms
            </div>
            <Show when={r.ok} fallback={<div class="err">{r.error}</div>}>
              <div>文本：{r.output?.text || "—"}</div>
              <div>
                数值：{r.output?.num ?? "—"}
                <Show when={r.output?.value != null}>（比例 {(r.output!.value! * 100).toFixed(0)}%）</Show>
              </div>
              <Show when={r.output?.color}>
                <div>颜色：<span class="color-chip" style={{ background: r.output!.color! }} /> {r.output!.color}</div>
              </Show>
              <Show when={r.output?.items?.length}>
                <div>条目：{r.output!.items!.length}</div>
                <For each={r.output!.items!}>
                  {(it) => (
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
  );
}
