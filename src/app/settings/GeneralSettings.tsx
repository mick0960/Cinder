import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, DriverConfig, DriverSource } from "../../types";
import { driver, initStores, metrics, moduleOutputs, modules } from "../widget/stores";
import { driveTarget } from "../widget/drive";

const SOURCES: { id: DriverSource; label: string }[] = [
  { id: "cpu", label: "CPU 占用（默认）" },
  { id: "mem", label: "内存占用" },
  { id: "gpu", label: "GPU 占用" },
  { id: "net_down", label: "网络下载速度" },
  { id: "net_up", label: "网络上传速度" },
  { id: "net", label: "网络总速度（上传 + 下载）" },
  { id: "module", label: "某个监控模块的数值" },
];
const isNet = (s: DriverSource) => s === "net_down" || s === "net_up" || s === "net";

export function GeneralSettings() {
  const [autostart, setAutostart] = createSignal(false);
  const [hideOnFullscreen, setHideOnFullscreen] = createSignal(true);
  const [error, setError] = createSignal("");
  const [driveError, setDriveError] = createSignal("");

  onMount(() => {
    // 篝火动画的实时预览需要订阅指标和模块输出
    initStores();
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

  /* ---------- 篝火动画 ---------- */

  const apply = (next: DriverConfig) => {
    setDriveError("");
    invoke("set_driver", { driver: next }).catch((e) => setDriveError(String(e)));
  };

  const changeSource = (source: DriverSource) => {
    const prev = driver();
    // 在同类来源之间切换时保留已填的范围
    const keep = (isNet(source) && isNet(prev.source)) || (source === "module" && prev.source === "module");
    const range = keep ? { min: prev.min, max: prev.max } : { min: 0, max: isNet(source) ? 10 : 100 };
    apply({ source, moduleId: source === "module" ? (prev.moduleId ?? modules()[0]?.id ?? null) : null, ...range });
  };

  const changeRange = (p: Partial<Pick<DriverConfig, "min" | "max">>, input: HTMLInputElement) => {
    const next = { ...driver(), ...p };
    if (!(next.max > next.min)) {
      setDriveError("最大值必须大于最小值");
      // 输入框还原成当前生效的值，免得界面上显示的和实际不一致
      input.value = String(p.min !== undefined ? driver().min : driver().max);
      return;
    }
    apply(next);
  };

  const source = () => driver().source;
  const target = createMemo(() => driveTarget(driver(), metrics(), moduleOutputs()));
  const driverModule = () => modules().find((m) => m.id === driver().moduleId);
  const moduleOut = () => (driver().moduleId ? moduleOutputs()[driver().moduleId!] : undefined);
  const noModules = () => modules().length === 0;
  const preview = () => {
    if (source() === "gpu" && metrics()?.gpu_percent == null) return "—";
    if (source() === "module" && moduleOut()?.kind !== "ok") return "—";
    return `${Math.round(target() * 100)}%`;
  };
  const currentValue = () => {
    const o = moduleOut();
    if (!o) return "等待第一次刷新…";
    if (o.kind === "error") return `出错：${o.text}`;
    return o.num == null ? "输出里没有数字" : `${o.num}${driverModule()?.unit ?? ""}`;
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

      <div class="upd-sep" />
      <div class="upd-title">篝火动画</div>
      <div class="drive">
        <label>动画速度由
          <select value={source()} onChange={(e) => changeSource(e.currentTarget.value as DriverSource)}>
            <For each={SOURCES}>
              {(s) => <option value={s.id} disabled={s.id === "module" && noModules()}>{s.label}</option>}
            </For>
          </select>
          决定
        </label>

        <Show when={isNet(source())}>
          <label>速度达到
            <input
              type="number"
              min={0.1}
              step={0.5}
              value={driver().max}
              onChange={(e) => changeRange({ max: +e.currentTarget.value || 10 }, e.currentTarget)}
            />
            MB/s 时烧得最旺
          </label>
        </Show>

        <Show when={source() === "module"}>
          <label>模块
            <select
              value={driver().moduleId ?? ""}
              onChange={(e) => apply({ ...driver(), moduleId: e.currentTarget.value || null })}
            >
              <For each={modules()}>{(m) => <option value={m.id}>{m.name}</option>}</For>
            </select>
          </label>
          <label>数值从
            <input type="number" step="any" value={driver().min} onChange={(e) => changeRange({ min: +e.currentTarget.value || 0 }, e.currentTarget)} />
            到
            <input type="number" step="any" value={driver().max} onChange={(e) => changeRange({ max: +e.currentTarget.value || 100 }, e.currentTarget)} />
            之间，对应从静止到最旺
          </label>
          <div class="drive-now">模块当前数值：{currentValue()}</div>
          <Show when={driverModule()?.type === "command" && !driverModule()?.persistent}>
            <div class="upd-status warn">
              这个模块是轮询命令：面板收起时它也会按刷新间隔反复启动 shell 来驱动篝火。
              建议在模块里勾选“常驻进程”，或改用 Ping / HTTP / GPU 这类不启动 shell 的类型。
            </div>
          </Show>
        </Show>

        <div class="drive-meter" title="当前篝火强度">
          <span class="drive-label">当前强度</span>
          <span class="drive-bar"><i style={{ width: `${target() * 100}%` }} /></span>
          <span class="drive-pct">{preview()}</span>
        </div>

        <small class="drive-help">
          <Show when={source() === "gpu"}>
            GPU 数据通常在开启后 2~3 秒出现，与任务管理器同源，各厂商显卡都适用；一直显示“—”说明这台电脑读不到 GPU 性能计数器（需要 Windows 10 1709 及以上和较新的显卡驱动）。
          </Show>
          <Show when={source() === "module" && noModules()}>先在“监控模块”里添加并保存一个模块。</Show>
          <Show when={source() === "module" && !noModules()}>
            选作驱动的模块在面板收起时也会继续运行，所以篝火始终有数据可用；篝火被隐藏（如全屏自动隐藏）期间则暂停。
          </Show>
          <Show when={source() === "cpu" || source() === "mem"}>
            强度越高，火苗动得越快；空闲时缓慢摇曳。
          </Show>
        </small>
      </div>
      <Show when={driveError()}>
        <div class="upd-status err">{driveError()}</div>
      </Show>
    </div>
  );
}
