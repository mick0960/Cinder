import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UpdateStatus } from "../../types";
import "./toast.css";

/** 右下角更新气泡：发现新版本 / 下载中 / 已就绪 / 出错 */
export function Toast() {
  const [st, setSt] = createSignal<UpdateStatus | null>(null);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    invoke<UpdateStatus>("get_update_status").then(setSt);
    const un = listen<UpdateStatus>("update://status", (e) => setSt(e.payload));
    onCleanup(() => un.then((f) => f()));
  });

  const restart = async () => {
    setBusy(true);
    try {
      await invoke("install_update");
    } catch {
      setBusy(false);
    }
  };
  const download = () => invoke("download_update");
  const later = () => invoke("dismiss_update");

  return (
    <div class="toast-wrap">
      <Show when={st()} keyed>
        {(s) => (
          <div class="toast">
            <div class="toast-head">
              <span class="toast-ico">{s.state === "error" ? "!" : "↑"}</span>
              <span class="toast-title">
                {s.state === "ready" && `新版本 ${s.version} 已下载`}
                {s.state === "available" && `发现新版本 ${s.version}`}
                {s.state === "downloading" && `正在下载 ${s.version}…`}
                {s.state === "error" && "更新失败"}
              </span>
            </div>
            <div class="toast-body">
              {s.state === "ready" && "重启即可完成更新，也可以等下次再更新。"}
              {s.state === "available" && "是否现在下载？"}
              {s.state === "downloading" && (
                <div class="bar"><i style={{ width: `${s.progress}%` }} /></div>
              )}
              {s.state === "error" && (s.error ?? "未知错误")}
            </div>
            <div class="toast-actions">
              <Show when={s.state !== "downloading"}>
                <button class="ghost" onClick={later}>下次再说</button>
              </Show>
              <Show when={s.state === "ready"}>
                <button class="primary" disabled={busy()} onClick={restart}>
                  {busy() ? "正在重启…" : "立即重启更新"}
                </button>
              </Show>
              <Show when={s.state === "available" || s.state === "error"}>
                <button class="primary" onClick={download}>
                  {s.state === "error" ? "重试" : "立即下载"}
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
