import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import type { AppConfig, UpdateStatus } from "../../types";

const REPO = "https://github.com/mick0960/Cinder";

export function AboutSettings() {
  const [version, setVersion] = createSignal("");
  const [auto, setAuto] = createSignal(true);
  const [st, setSt] = createSignal<UpdateStatus | null>(null);

  onMount(() => {
    getVersion().then(setVersion);
    invoke<AppConfig>("get_config").then((c) => setAuto(c.update?.auto ?? true));
    invoke<UpdateStatus>("get_update_status").then(setSt);
    const un = listen<UpdateStatus>("update://status", (e) => setSt(e.payload));
    onCleanup(() => un.then((f) => f()));
  });

  const toggleAuto = (v: boolean) => {
    setAuto(v);
    invoke("set_update_auto", { auto: v });
  };

  const statusText = () => {
    const s = st();
    if (!s) return "";
    switch (s.state) {
      case "checking": return "正在检查更新…";
      case "uptodate": return "已是最新版本";
      case "available": return `发现新版本 ${s.version}`;
      case "downloading": return `正在下载 ${s.version}… ${s.progress}%`;
      case "ready": return `新版本 ${s.version} 已下载，等待重启安装`;
      case "error": return `检查/下载失败：${s.error ?? "未知错误"}`;
      default: return "";
    }
  };
  const busy = () => ["checking", "downloading"].includes(st()?.state ?? "");

  return (
    <div class="upd pane-in">
      <div class="about-head">
        <div class="about-name">Cinder</div>
        <div class="upd-sub">v{version()}</div>
      </div>
      <div class="about-rows">
        <div class="about-row"><span>作者</span><span>mick0960</span></div>
        <div class="about-row">
          <span>仓库</span>
          <a href="#" onClick={(e) => { e.preventDefault(); invoke("open_repo"); }}>{REPO}</a>
        </div>
      </div>

      <div class="upd-sep" />
      <div class="upd-title">更新</div>
      <label class="upd-opt">
        <input type="checkbox" checked={auto()} onChange={(e) => toggleAuto(e.currentTarget.checked)} />
        <span>
          自动更新
          <small>发现新版本后在后台静默下载，下载完成后提示你选择何时重启；关闭则仅提示，由你手动下载。</small>
        </span>
      </label>
      <div class="upd-row">
        <div class="upd-status" classList={{ err: st()?.state === "error" }}>{statusText()}</div>
        <button class="primary" disabled={busy()} onClick={() => invoke("check_update")}>
          {st()?.state === "checking" ? "检查中…" : "检查更新"}
        </button>
      </div>
      <Show when={st()?.state === "ready"}>
        <button class="primary" onClick={() => invoke("install_update")}>立即重启更新</button>
      </Show>
      <Show when={st()?.state === "available"}>
        <button class="primary" onClick={() => invoke("download_update")}>立即下载</button>
      </Show>
    </div>
  );
}
