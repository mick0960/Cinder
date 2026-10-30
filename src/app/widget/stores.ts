import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppConfig, DriverConfig, MetricsSnapshot, ModuleConfig, ModuleOutput, RunnerConfig } from "../../types";
import { DEFAULT_DRIVER, driveTarget } from "./drive";

const HISTORY_LEN = 30;
const METRIC_HISTORY = 48;

export interface MetricHistory {
  cpu: number[];
  down: number[];
  up: number[];
  /** 最近一次快照到达的时间（performance.now），供图表滚动动画对齐 */
  at: number;
  /** 估算的快照间隔（毫秒） */
  stepMs: number;
}

const [metrics, setMetrics] = createSignal<MetricsSnapshot | null>(null);
const [moduleOutputs, setModuleOutputs] = createSignal<Record<string, ModuleOutput>>({});
const [moduleHistory, setModuleHistory] = createSignal<Record<string, number[]>>({});
const [modules, setModules] = createSignal<ModuleConfig[]>([]);
const [runners, setRunners] = createSignal<RunnerConfig[]>([]);
const [character, setCharacter] = createSignal<string>("bonfire");
const [idle, setIdle] = createSignal(false);
const [driver, setDriver] = createSignal<DriverConfig>(DEFAULT_DRIVER);
const [metricHistory, setMetricHistory] = createSignal<MetricHistory>({ cpu: [], down: [], up: [], at: 0, stepMs: 1000 });

const pushCapped = (arr: number[], v: number, cap: number) => {
  const next = [...arr, v];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
};

// 篝火强度（0~1）的平滑：由动画时钟每一帧推进一步。
// 用时间常数而不是“每次新数据乘一个系数”，这样 1 秒一次的系统指标和 5 秒一次的模块手感一致。
const DRIVE_TAU_MS = 3000;
let driveLevel = 0;
let driveAt = 0;
export function stepDriveLevel(now: number): number {
  const target = driveTarget(driver(), metrics(), moduleOutputs());
  // 第一次调用直接跳到目标值；动画时钟被长时间挂起（窗口隐藏）后也只按有限的时间推进
  const dt = driveAt ? Math.min(now - driveAt, 10_000) : Infinity;
  driveAt = now;
  driveLevel += (target - driveLevel) * (1 - Math.exp(-dt / DRIVE_TAU_MS));
  return driveLevel;
}

let started = false;
export function initStores() {
  if (started) return;
  started = true;

  invoke<AppConfig>("get_config").then((c) => {
    setModules(c.modules ?? []);
    setRunners(c.runners ?? []);
    if (c.character) setCharacter(c.character);
    setDriver(c.driver ?? DEFAULT_DRIVER);
  });

  listen<MetricsSnapshot>("metrics://snapshot", (e) => {
    const snap = e.payload;
    setMetrics(snap);
    const now = performance.now();
    setMetricHistory((h) => {
      const dt = h.at ? now - h.at : h.stepMs;
      return {
        cpu: pushCapped(h.cpu, snap.cpu_percent / 100, METRIC_HISTORY),
        down: pushCapped(h.down, snap.net_down_bps, METRIC_HISTORY),
        up: pushCapped(h.up, snap.net_up_bps, METRIC_HISTORY),
        at: now,
        // 面板收起时推送变慢，间隔过长的样本不参与估算
        stepMs: dt > 5000 ? h.stepMs : h.stepMs * 0.6 + Math.max(150, dt) * 0.4,
      };
    });
  });

  listen<ModuleOutput>("module://output", (e) => {
    const out = e.payload;
    setModuleOutputs((prev) => ({ ...prev, [out.id]: out }));
    // 历史只在这里追加：每条输出恰好记录一次
    if (out.kind === "ok" && out.value != null) {
      setModuleHistory((prev) => {
        const arr = [...(prev[out.id] ?? []), out.value!];
        if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
        return { ...prev, [out.id]: arr };
      });
    }
  });

  // 设置页保存后立即刷新模块列表；清理已删除模块的残留数据
  listen<ModuleConfig[]>("config://modules", (e) => {
    const list = e.payload ?? [];
    const ids = new Set(list.map((m) => m.id));
    const keep = <T,>(rec: Record<string, T>) =>
      Object.fromEntries(Object.entries(rec).filter(([k]) => ids.has(k)));
    setModules(list);
    setModuleOutputs(keep);
    setModuleHistory(keep);
  });

  listen<RunnerConfig[]>("config://runners", (e) => setRunners(e.payload ?? []));

  listen<string>("character://changed", (e) => setCharacter(e.payload));

  invoke<boolean>("is_idle").then(setIdle);
  listen<boolean>("idle://changed", (e) => setIdle(e.payload));

  listen<DriverConfig>("config://driver", (e) => setDriver(e.payload ?? DEFAULT_DRIVER));
}

export { metrics, metricHistory, moduleOutputs, moduleHistory, modules, character, runners, driver, idle };

export function fmtRate(bps: number): string {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
}

// 后端已按二进制单位（MiB）上报
export function fmtMb(mb: number): string {
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
