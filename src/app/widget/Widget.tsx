import { createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { character, runners, initStores, getSmoothCpu } from "./stores";
import "./panel.css";

/** 悬浮图标窗口：固定 64×64、位置只由拖动改变；监控面板在独立的 panel 窗口里（见 PanelWindow.tsx） */
export function Widget() {
  initStores();
  const win = getCurrentWindow();

  let dragStart: { x: number; y: number } | null = null;
  let dragging = false;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragStart = { x: e.screenX, y: e.screenY };
    dragging = false;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragStart || dragging) return;
    if (Math.abs(e.screenX - dragStart.x) + Math.abs(e.screenY - dragStart.y) > 6) {
      dragging = true;
      win.startDragging();
    }
  };
  const onPointerUp = () => {
    if (dragStart && !dragging) invoke("toggle_panel");
    dragStart = null;
  };

  // 文件拖到图标上按住 4 秒即焚烧：网页拿不到文件路径，收到 dragenter 后让后端盖上原生接手窗（见 burn/catcher.rs）
  const onDragEnter = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) invoke("burn_catch");
  };
  // 拦下网页自己的放下，否则 WebView 会打开被拖的文件
  const stop = (e: DragEvent) => e.preventDefault();
  document.addEventListener("dragenter", onDragEnter);
  document.addEventListener("dragover", stop);
  document.addEventListener("drop", stop);
  onCleanup(() => {
    document.removeEventListener("dragenter", onDragEnter);
    document.removeEventListener("dragover", stop);
    document.removeEventListener("drop", stop);
  });

  return (
    <div
      class="widget"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        invoke("popup_widget_menu");
      }}
    >
      <Cat character={character} />
    </div>
  );
}

/**
 * 动画时钟：独立于指标推送频率运行，每一帧根据当前平滑 CPU 决定下一帧间隔。
 * （旧实现每收到一次指标就重建 setInterval，间隔长于推送周期时动画会完全冻结）
 */
function useFrameClock(frames: () => number) {
  const [frame, setFrame] = createSignal(0);
  let timer = 0;
  const tick = () => {
    const hidden = document.hidden;
    if (!hidden) setFrame((f) => (f + 1) % Math.max(1, frames()));
    const cpu = Math.min(100, Math.max(0, getSmoothCpu()));
    const interval = hidden ? 2000 : Math.max(80, 800 - 720 * (cpu / 100));
    timer = window.setTimeout(tick, interval);
  };
  timer = window.setTimeout(tick, 400);
  onCleanup(() => clearTimeout(timer));
  return frame;
}

const BUILTIN_FRAMES = Object.entries(
  import.meta.glob("../../assets/bonfire/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>,
)
  .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  .map(([, url]) => url);

function Cat(props: { character: () => string }) {
  // 自定义角色被删除或帧为空时回退到内置篝火
  const frames = () => {
    const ch = props.character();
    const r = ch.startsWith("custom:") ? runners().find((x) => x.id === ch.slice(7)) : undefined;
    return r && r.frames.length > 0 ? r.frames : BUILTIN_FRAMES;
  };
  const frame = useFrameClock(() => frames().length);
  return <img class="cat" width="64" height="64" draggable={false} src={frames()[frame() % frames().length]} />;
}
