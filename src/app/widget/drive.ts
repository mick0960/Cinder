import type { DriverConfig, MetricsSnapshot, ModuleOutput } from "../../types";

export const DEFAULT_DRIVER: DriverConfig = { source: "cpu", moduleId: null, min: 0, max: 100 };

const MB = 1024 * 1024;
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * 驱动指标当前对应的篝火强度，0（静止）~ 1（最旺）。
 * - cpu / mem / gpu：按 0~100% 直接换算
 * - net_down / net_up / net：速率达到 max（MB/s）时为 1
 * - module：模块数值（`num`）从 min 到 max 线性映射；模块出错或还没有数值时为 0
 */
export function driveTarget(d: DriverConfig, m: MetricsSnapshot | null, outs: Record<string, ModuleOutput>): number {
  switch (d.source) {
    case "mem":
      return m && m.mem_total_mb > 0 ? clamp01(m.mem_used_mb / m.mem_total_mb) : 0;
    case "gpu":
      return clamp01((m?.gpu_percent ?? 0) / 100);
    case "net_down":
    case "net_up":
    case "net": {
      if (!m) return 0;
      const bps = d.source === "net_down" ? m.net_down_bps : d.source === "net_up" ? m.net_up_bps : m.net_down_bps + m.net_up_bps;
      return clamp01(bps / (Math.max(0.1, d.max) * MB));
    }
    case "module": {
      const o = d.moduleId ? outs[d.moduleId] : undefined;
      if (!o || o.kind !== "ok" || o.num == null) return 0;
      const span = d.max - d.min;
      return span > 0 ? clamp01((o.num - d.min) / span) : 0;
    }
    default:
      return clamp01((m?.cpu_percent ?? 0) / 100);
  }
}
