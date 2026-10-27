import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppConfig, MetricsSnapshot, ModuleConfig, ModuleOutput } from "../../types";

const HISTORY_LEN = 30;

const [metrics, setMetrics] = createSignal<MetricsSnapshot | null>(null);
const [moduleOutputs, setModuleOutputs] = createSignal<Record<string, ModuleOutput>>({});
const [moduleHistory, setModuleHistory] = createSignal<Record<string, number[]>>({});
const [modules, setModules] = createSignal<ModuleConfig[]>([]);
const [character, setCharacter] = createSignal<string>("cat");

// CPU 平滑值：只在收到新快照时更新一次，供动画时钟读取
let smoothCpu = 0;
export const getSmoothCpu = () => smoothCpu;

let started = false;
export function initStores() {
  if (started) return;
  started = true;

  invoke<AppConfig>("get_config").then((c) => {
    setModules(c.modules ?? []);
    if (c.character) setCharacter(c.character);
  });

  listen<MetricsSnapshot>("metrics://snapshot", (e) => {
    smoothCpu = smoothCpu * 0.7 + e.payload.cpu_percent * 0.3;
    setMetrics(e.payload);
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

  listen<string>("character://changed", (e) => setCharacter(e.payload));
}

export { metrics, moduleOutputs, moduleHistory, modules, character };

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
