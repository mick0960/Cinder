import { For, Index, Show } from "solid-js";
import type { HttpHeader, HttpMethod, ModuleConfig, ModuleOutput } from "../../types";
import { COLOR_OK } from "../components/ModuleStyles";
import { ClickEditor } from "./ClickEditor";
import { FORMATS, HTTP_METHODS, MODULE_TYPES, PRESET_COLORS, SHELLS, withPersistent, withType } from "./moduleModel";
import { StylePicker } from "./StylePicker";
import { ThresholdEditor } from "./ThresholdEditor";

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

  // 折叠区只按“打开表单时是否已有配置”决定展开；之后增删规则不会让它突然收起
  const openThresholds = m().thresholds.length > 0;
  const openClick = m().click != null;
  const openHttpOpts = (m().httpHeaders?.length ?? 0) > 0 || !!m().httpNoProxy || !!m().httpInsecure;

  const headers = () => m().httpHeaders ?? [];
  const patchHeader = (i: number, p: Partial<HttpHeader>) =>
    patch({ httpHeaders: headers().map((h, j) => (j === i ? { ...h, ...p } : h)) });
  const addHeader = () => patch({ httpHeaders: [...headers(), { name: "", value: "" }] });
  const removeHeader = (i: number) => patch({ httpHeaders: headers().filter((_, j) => j !== i) });

  const httpOptsSummary = () => {
    const parts: string[] = [];
    if (headers().length > 0) parts.push(`${headers().length} 个请求头`);
    if (m().httpNoProxy) parts.push("直连");
    if (m().httpInsecure) parts.push("跳过 TLS 校验");
    return parts.length ? parts.join(" · ") : "默认";
  };

  const typeHint = () => MODULE_TYPES.find((t) => t.id === m().type)?.hint;
  const timeoutLabel = () => {
    if (m().type === "command") return m().persistent ? "无输出超时（毫秒）" : "超时（毫秒）";
    if (m().type === "tcp") return "连接超时（毫秒）";
    return "请求超时（毫秒）";
  };
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
        <div class="http-req-row">
          <label class="http-method">请求方法
            <select
              value={m().httpMethod ?? "GET"}
              onChange={(e) => patch({ httpMethod: e.currentTarget.value as HttpMethod })}
            >
              <For each={HTTP_METHODS}>{(method) => <option value={method}>{method}</option>}</For>
            </select>
          </label>
          <label class="http-url">网址
            <input
              spellcheck={false}
              placeholder="https://api.example.com/status"
              value={m().url}
              onInput={(e) => patch({ url: e.currentTarget.value })}
            />
          </label>
        </div>
        <label>响应头字段（可选）
          <input
            spellcheck={false}
            placeholder="留空读正文；如 Subscription-Userinfo"
            value={m().httpResponseHeader ?? ""}
            onInput={(e) => patch({ httpResponseHeader: e.currentTarget.value })}
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
        <Show when={(m().httpMethod ?? "GET") === "POST"}>
          <label>请求体（可选）
            <textarea
              rows={3}
              spellcheck={false}
              placeholder="JSON 或文本正文"
              value={m().httpBody ?? ""}
              onInput={(e) => patch({ httpBody: e.currentTarget.value })}
            />
          </label>
        </Show>
        <div class="help">
          响应最大 1 MB；<code>HEAD</code> 未填响应头字段时返回状态码；<code>POST</code> 正文以 <code>{"{"}</code> 或 <code>[</code> 开头且未自定义 Content-Type 时自动设为 JSON。
          路径写法：<code>ip</code>、<code>data.temp</code>、<code>items[0].name</code>、<code>items[-1]</code>（最后一项）。
        </div>
        <details class="fold" open={openHttpOpts}>
          <summary>
            请求头与连接选项
            <span class="fold-sum">{httpOptsSummary()}</span>
          </summary>
          <div class="fold-body http-opts">
            <div class="http-headers">
              <Index each={headers()}>
                {(h, i) => (
                  <div class="hdr-row">
                    <input
                      class="hdr-name"
                      spellcheck={false}
                      placeholder="请求头名称，如 Authorization"
                      aria-label="请求头名称"
                      value={h().name}
                      onInput={(e) => patchHeader(i, { name: e.currentTarget.value })}
                    />
                    <input
                      class="hdr-val"
                      spellcheck={false}
                      placeholder="值"
                      aria-label="请求头值"
                      value={h().value}
                      onInput={(e) => patchHeader(i, { value: e.currentTarget.value })}
                    />
                    <button
                      type="button"
                      class="rule-del"
                      title="删除这条请求头"
                      onClick={() => removeHeader(i)}
                    >×</button>
                  </div>
                )}
              </Index>
              <div class="rule-foot">
                <button type="button" class="link" onClick={addHeader}>＋ 添加请求头</button>
              </div>
            </div>
            <label class="check">
              <input
                type="checkbox"
                checked={!!m().httpNoProxy}
                onChange={(e) => patch({ httpNoProxy: e.currentTarget.checked })}
              />
              <span>
                直连（绕过系统代理）
                <small>开启 Clash 等系统代理时，访问本机（127.0.0.1）、局域网或 NAS 服务建议勾选此项。</small>
              </span>
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={!!m().httpInsecure}
                onChange={(e) => patch({ httpInsecure: e.currentTarget.checked })}
              />
              <span>
                跳过 TLS 证书校验
                <small>访问局域网自签名 HTTPS 服务（如路由器、NAS 管理页）时勾选；公网接口不建议开启。</small>
              </span>
            </label>
          </div>
        </details>
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

      <Show when={m().type === "tcp"}>
        <div class="grid2">
          <label>主机
            <input
              spellcheck={false}
              placeholder="127.0.0.1 或域名"
              value={m().host}
              onInput={(e) => patch({ host: e.currentTarget.value })}
            />
          </label>
          <label>端口
            <input
              type="number"
              min={1}
              max={65535}
              step={1}
              placeholder="80"
              value={m().port || ""}
              onInput={(e) => {
                const raw = e.currentTarget.value.trim();
                if (!raw) {
                  patch({ port: 0 });
                  return;
                }
                const n = Number(raw);
                if (Number.isFinite(n)) patch({ port: Math.trunc(n) });
              }}
            />
          </label>
        </div>
        <div class="help">每次刷新尝试建立 TCP 连接并测量握手延迟，支持 IPv4、IPv6（如 <code>::1</code>）与域名；连接成功后立即断开。</div>
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

      <details class="fold" open={openThresholds}>
        <summary>
          阈值着色
          <span class="fold-sum">{m().thresholds.length ? `${m().thresholds.length} 条规则` : "未设置"}</span>
        </summary>
        <div class="fold-body">
          <ThresholdEditor rules={m().thresholds} unit={m().unit} onChange={(thresholds) => patch({ thresholds })} />
        </div>
      </details>

      <details class="fold" open={openClick}>
        <summary>
          点击动作
          <span class="fold-sum">{m().click ? (m().click!.kind === "url" ? "打开网址" : "运行命令") : "未设置"}</span>
        </summary>
        <div class="fold-body">
          <ClickEditor click={m().click} onChange={(click) => patch({ click })} />
        </div>
      </details>

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
