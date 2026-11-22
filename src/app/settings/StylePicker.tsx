import { For, Show } from "solid-js";
import type { ModuleConfig } from "../../types";
import { STYLES } from "./moduleModel";

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
      <Show when={props.style === "rings"}>
        <circle cx="8" cy="8" r="6" />
        <circle cx="8" cy="8" r="3.2" />
      </Show>
      <Show when={props.style === "cards"}>
        <rect x="1.5" y="3.5" width="5.5" height="9" rx="1.5" />
        <rect x="9" y="3.5" width="5.5" height="9" rx="1.5" />
      </Show>
      <Show when={props.style === "status"}>
        <circle class="solid" cx="3" cy="5.5" r="1.2" />
        <path d="M6 5.5h8" />
        <circle cx="3" cy="10.5" r="1.2" />
        <path d="M6 10.5h6" />
      </Show>
    </svg>
  );
}

/** 可视化的样式选择：每个选项带一个会动的小预览 */
export function StylePicker(props: { value: ModuleConfig["style"]; color: string; onChange: (v: ModuleConfig["style"]) => void }) {
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
                <svg viewBox="0 0 60 18" width="46" height="18"><polyline points="0,14 10,10 18,12 28,5 36,8 46,3 60,7" /></svg>
              </Show>
              <Show when={v === "rings"}>
                <svg viewBox="0 0 22 22" width="20" height="20">
                  <circle class="pv-ring-track" cx="11" cy="11" r="8.5" stroke-width="2.2" />
                  <circle class="pv-ring-arc pv-ring-out" cx="11" cy="11" r="8.5" stroke-width="2.2" stroke="#4cc2ff" transform="rotate(-90 11 11)" />
                  <circle class="pv-ring-track" cx="11" cy="11" r="4.8" stroke-width="2" />
                  <circle class="pv-ring-arc pv-ring-in" cx="11" cy="11" r="4.8" stroke-width="2" stroke="#a78bfa" transform="rotate(-90 11 11)" />
                </svg>
              </Show>
              <Show when={v === "cards"}>
                <span class="pv-cards"><i>4.8</i><i>12M</i></span>
              </Show>
              <Show when={v === "status"}>
                <span class="pv-status">
                  <span class="pv-status-row"><em class="on" /><i /></span>
                  <span class="pv-status-row"><em /><i class="half" /></span>
                </span>
              </Show>
            </span>
            <span class="pv-label">{t}</span>
          </button>
        )}
      </For>
    </div>
  );
}
