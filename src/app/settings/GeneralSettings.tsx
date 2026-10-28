import { createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "../../types";

export function GeneralSettings() {
  const [autostart, setAutostart] = createSignal(false);
  const [hideOnFullscreen, setHideOnFullscreen] = createSignal(true);
  const [error, setError] = createSignal("");

  onMount(() => {
    invoke<boolean>("get_autostart").then(setAutostart).catch((e) => setError(String(e)));
    invoke<AppConfig>("get_config").then((c) => setHideOnFullscreen(c.hideOnFullscreen ?? true));
  });

  const toggleAutostart = async (v: boolean) => {
    setError("");
    setAutostart(v);
    try {
      await invoke("set_autostart", { enabled: v });
    } catch (e) {
      setError(String(e));
      // 失败后以系统里的实际状态为准，不让勾选框撒谎
      invoke<boolean>("get_autostart").then(setAutostart).catch(() => setAutostart(!v));
    }
  };

  const toggleHideOnFullscreen = (v: boolean) => {
    setHideOnFullscreen(v);
    invoke("set_hide_on_fullscreen", { enabled: v });
  };

  return (
    <div class="upd pane-in">
      <div class="upd-title">启动</div>
      <label class="upd-opt">
        <input type="checkbox" checked={autostart()} onChange={(e) => toggleAutostart(e.currentTarget.checked)} />
        <span>
          开机自启
          <small>登录 Windows 后自动运行 Cinder；也可以在任务管理器的“启动应用”里关闭。</small>
        </span>
      </label>
      <Show when={error()}>
        <div class="upd-status err">{error()}</div>
      </Show>

      <div class="upd-sep" />
      <div class="upd-title">显示</div>
      <label class="upd-opt">
        <input type="checkbox" checked={hideOnFullscreen()} onChange={(e) => toggleHideOnFullscreen(e.currentTarget.checked)} />
        <span>
          全屏时自动隐藏
          <small>全屏游戏、全屏视频或演示模式运行时自动隐藏篝火，结束后恢复显示，避免挡住画面。</small>
        </span>
      </label>
    </div>
  );
}
