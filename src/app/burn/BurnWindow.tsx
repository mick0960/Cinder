import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { BurnFx, type Anchor } from "./fx";
import "./burn.css";

const CAT = 64;     // 图标尺寸（逻辑像素）
const WIN_W = 200;  // 覆盖窗口尺寸，与 burn.rs 保持一致
const WIN_H = 260;

type Snapshot =
  | { kind: "burning"; name: string; isDir: boolean; count: number; durationMs: number; elapsedMs: number }
  | { kind: "refused"; reason: string };

/**
 * 焚烧覆盖窗口：透明、鼠标穿透，盖住图标及其上方。只负责动画——计时和删除在后端（burn.rs）。
 * 平时隐藏；收到 burn://start 后摆到图标处再显示，动画全部结束后自行隐藏。
 */
export function BurnWindow() {
  const win = getCurrentWindow();
  const [tip, setTip] = createSignal<{ text: string; x: number; y: number } | null>(null);
  let canvas!: HTMLCanvasElement;
  let fx!: BurnFx;
  let shown = false;

  // 事件按到达顺序串行处理：定位是异步的，避免“取消”先于“开始”生效
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => unknown) => (queue = queue.then(fn).catch(() => {}));

  /** 窗口底边对齐图标底边、水平居中，越界时夹回显示器内；返回图标在窗口内的位置 */
  const place = async (): Promise<Anchor | null> => {
    const widget = await WebviewWindow.getByLabel("widget");
    if (!widget) return null;
    const [pos, sf] = await Promise.all([widget.outerPosition(), widget.scaleFactor()]);
    const cat = Math.round(CAT * sf);
    const w = Math.round(WIN_W * sf);
    const h = Math.round(WIN_H * sf);
    let x = pos.x + Math.round((cat - w) / 2);
    let y = pos.y + cat - h;
    const mon = await monitorFromPoint(pos.x + cat / 2, pos.y + cat / 2);
    if (mon) {
      // 鼠标穿透的窗口可以盖住任务栏，按整个显示器而不是工作区夹取
      x = Math.min(Math.max(x, mon.position.x), mon.position.x + mon.size.width - w);
      y = Math.min(Math.max(y, mon.position.y), mon.position.y + mon.size.height - h);
    }
    await invoke("set_widget_rect", { x, y, w, h });
    return { cx: (pos.x - x) / sf + CAT / 2, top: (pos.y - y) / sf, size: CAT };
  };

  const showTip = (text: string) => {
    const p = fx.tipPos();
    // 气泡居中于卡片上方，贴边时向内收，避免被窗口裁掉
    setTip({ text, x: Math.min(Math.max(p.x, 72), WIN_W - 72), y: p.y });
  };

  const onStart = async (s: Snapshot, receivedAt: number) => {
    const anchor = await place();
    if (!anchor) return;
    fx.setAnchor(anchor);
    if (s.kind === "burning") {
      setTip(null);
      fx.start(s, s.durationMs, s.elapsedMs + performance.now() - receivedAt);
    } else {
      fx.refuse();
      showTip(s.reason);
    }
    if (!shown) {
      shown = true;
      await win.show();
    }
  };

  onMount(async () => {
    fx = new BurnFx(canvas);
    fx.onIdle = () => {
      setTip(null);
      shown = false;
      win.hide();
    };
    const offs = await Promise.all([
      listen<Snapshot>("burn://start", (e) => {
        const at = performance.now();
        enqueue(() => onStart(e.payload, at));
      }),
      listen("burn://cancel", () => enqueue(() => fx.cancel())),
      listen<{ error: string | null }>("burn://done", (e) =>
        enqueue(() => {
          if (e.payload.error) {
            fx.fail();
            showTip(`没烧掉：${e.payload.error}`);
          } else {
            fx.finish();
            showTip("已移到回收站");
          }
        }),
      ),
    ]);
    onCleanup(() => offs.forEach((f) => f()));
    // 首次创建窗口时可能错过了 burn://start，主动补取并按已过去的时间追上进度
    const s = await invoke<Snapshot | null>("burn_state");
    if (s) {
      const at = performance.now();
      enqueue(() => onStart(s, at));
    }
  });

  return (
    <div class="burn">
      <canvas ref={canvas} />
      <Show when={tip()}>
        {(t) => (
          <div class="burn-tip" style={{ left: `${t().x}px`, top: `${t().y}px` }}>
            {t().text}
          </div>
        )}
      </Show>
    </div>
  );
}
