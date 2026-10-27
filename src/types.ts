export interface DiskInfo {
  mount: string;
  used_gb: number;
  total_gb: number;
}

export interface BatteryInfo {
  percent: number;
  charging: boolean;
  secs_left: number | null;
}

export interface MetricsSnapshot {
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disks: DiskInfo[];
  net_up_bps: number;
  net_down_bps: number;
  battery: BatteryInfo | null;
  ts: number;
}

export interface ModuleOutput {
  id: string;
  kind: "ok" | "error";
  text: string;
  value: number | null;
  color: string | null;
}

export interface ModuleConfig {
  id: string;
  type: "command";
  name: string;
  command: string;
  shell: "powershell" | "pwsh" | "cmd" | "direct";
  intervalMs: number;
  timeoutMs: number;
  style: "text" | "progress" | "sparkline";
  format: "plain" | "json";
  color: string | null;
  unit: string | null;
}

export interface AppConfig {
  window: { x: number; y: number };
  character: string;
  metrics: { panelIntervalMs: number; idleIntervalMs: number };
  modules: ModuleConfig[];
}
