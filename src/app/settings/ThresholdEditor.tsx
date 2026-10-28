import { For, Index, Show } from "solid-js";
import type { ThresholdRule } from "../../types";
import { nextRule, RULE_COLORS } from "./moduleModel";

/**
 * 阈值着色：不写 JSON 也能配置“超过 80% 变红”。
 * 数值取自输出里的数字（73% → 73，23 ms → 23）；多条规则同时命中时取最极端的一条。
 */
export function ThresholdEditor(props: { rules: ThresholdRule[]; unit: string | null; onChange: (rules: ThresholdRule[]) => void }) {
  const patch = (i: number, p: Partial<ThresholdRule>) =>
    props.onChange(props.rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const remove = (i: number) => props.onChange(props.rules.filter((_, j) => j !== i));

  return (
    <div class="rules">
      {/* Index：编辑数值时规则对象被替换，按位置复用节点，输入框才不会在每次按键后失去焦点 */}
      <Index each={props.rules}>
        {(r, i) => (
          <div class="rule">
            <select
              class="rule-op"
              value={r().op}
              aria-label="比较方式"
              onChange={(e) => patch(i, { op: e.currentTarget.value as ThresholdRule["op"] })}
            >
              <option value="gt">高于</option>
              <option value="lt">低于</option>
            </select>
            <input
              class="rule-val"
              type="number"
              step="any"
              aria-label="阈值"
              value={r().value}
              onInput={(e) => {
                // 清空或输入到一半时先不更新，保留用户正在输入的内容
                const n = e.currentTarget.valueAsNumber;
                if (Number.isFinite(n)) patch(i, { value: n });
              }}
            />
            <span class="rule-unit">{props.unit ?? ""}</span>
            <span class="rule-then">时显示为</span>
            <span class="rule-colors">
              <For each={RULE_COLORS}>
                {([c, name]) => (
                  <button
                    type="button"
                    class="swatch sm"
                    classList={{ active: r().color.toLowerCase() === c }}
                    style={{ "--sw": c }}
                    title={name}
                    onClick={() => patch(i, { color: c })}
                  />
                )}
              </For>
              <label
                class="swatch sm custom"
                classList={{ active: !RULE_COLORS.some(([c]) => c === r().color.toLowerCase()) }}
                title="自定义颜色"
                style={{ "--sw": r().color }}
              >
                <input type="color" value={r().color} onInput={(e) => patch(i, { color: e.currentTarget.value })} />
              </label>
            </span>
            <button type="button" class="rule-del" title="删除这条规则" onClick={() => remove(i)}>×</button>
          </div>
        )}
      </Index>
      <div class="rule-foot">
        <button type="button" class="link" onClick={() => props.onChange([...props.rules, nextRule(props.rules)])}>＋ 添加规则</button>
        <Show when={props.rules.length > 0} fallback={<span class="help">例如“高于 80 时显示为红色”。</span>}>
          <span class="help">
            数值取自输出里的数字（73% → 73，23 ms → 23）。多条规则同时命中时取最极端的一条；脚本用 JSON 自己给出的颜色优先。
          </span>
        </Show>
      </div>
    </div>
  );
}
