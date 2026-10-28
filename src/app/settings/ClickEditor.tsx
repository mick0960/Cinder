import { For, Show } from "solid-js";
import type { ClickAction } from "../../types";
import { isHttpUrl, SHELLS } from "./moduleModel";

type Kind = "none" | ClickAction["kind"];

/** 点击面板里的模块行时：打开网址，或运行一条命令 */
export function ClickEditor(props: { click: ClickAction | null; onChange: (c: ClickAction | null) => void }) {
  const kind = (): Kind => props.click?.kind ?? "none";
  const setKind = (k: Kind) => {
    if (k === "none") return props.onChange(null);
    // 保留已填的内容：从“打开网址”切到“运行命令”时不必重新输入
    props.onChange({ kind: k, target: props.click?.target ?? "", shell: props.click?.shell ?? "powershell" });
  };
  const patch = (p: Partial<ClickAction>) => props.click && props.onChange({ ...props.click, ...p });
  const badUrl = () => props.click?.kind === "url" && props.click.target.trim() !== "" && !isHttpUrl(props.click.target);

  return (
    <div class="click-editor">
      <div class="grid2">
        <label>点击时
          <select value={kind()} onChange={(e) => setKind(e.currentTarget.value as Kind)}>
            <option value="none">什么都不做</option>
            <option value="url">打开网址</option>
            <option value="command">运行命令</option>
          </select>
        </label>
        <Show when={props.click?.kind === "command"}>
          <label>运行方式
            <select value={props.click!.shell} onChange={(e) => patch({ shell: e.currentTarget.value as ClickAction["shell"] })}>
              <For each={SHELLS}>{([v, t]) => <option value={v}>{t}</option>}</For>
            </select>
          </label>
        </Show>
      </div>
      <Show when={props.click}>
        {(c) => (
          <label>{c().kind === "url" ? "网址" : "命令"}
            <input
              spellcheck={false}
              placeholder={c().kind === "url" ? "https://example.com" : "如 taskmgr、wt、explorer D:\\"}
              value={c().target}
              onInput={(e) => patch({ target: e.currentTarget.value })}
            />
          </label>
        )}
      </Show>
      <Show when={badUrl()}>
        <div class="status warn">网址需要以 http:// 或 https:// 开头</div>
      </Show>
      <div class="help">
        <Show
          when={props.click}
          fallback="设置后，点击面板里这一行就会打开网址或运行命令（鼠标移到行上会变成手型）。"
        >
          命令启动后不等待结果，图形程序会正常弹出自己的窗口。
          <Show when={props.click?.kind === "url"}>只能打开 http / https 网址；其它协议请用“运行命令”。</Show>
        </Show>
      </div>
    </div>
  );
}
