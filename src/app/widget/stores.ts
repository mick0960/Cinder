import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppConfig, MetricsSnapshot, ModuleConfig, ModuleOutput, RunnerConfig } from "../../types";

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
const [metricHistory, setMetricHistory] = createSignal<MetricHistory>({ cpu: [], down: [], up: [], at: 0, stepMs: 1000 });

const pushCapped = (arr: number[], v: number, cap: number) => {
  const next = [...arr, v];
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
};

// CPU 平滑值：只在收到新快照时更新一次，供动画时钟读取
let smoothCpu = 0;
export const getSmoothCpu = () => smoothCpu;

let started = false;
export function initStores() {
  if (started) return;
  started = true;

  invoke<AppConfig>("get_config").then((c) => {
    setModules(c.modules ?? []);
    setRunners(c.runners ?? []);
    if (c.character) setCharacter(c.character);
  });

  listen<MetricsSnapshot>("metrics://snapshot", (e) => {
    const snap = e.payload;
    smoothCpu = smoothCpu * 0.7 + snap.cpu_percent * 0.3;
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
}

export { metrics, metricHistory, moduleOutputs, moduleHistory, modules, character, runners };

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
