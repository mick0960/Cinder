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

export interface CleanResult {
  before_mb: number;
  after_mb: number;
  freed_mb: number;
  trimmed: number;
}

export interface ModuleOutput {
  id: string;
  kind: "ok" | "error";
  text: string;
  value: number | null;
  color: string | null;
  /** JSON 输出的多行条目；存在时组件逐条渲染，忽略 style */
  items?: ModuleItem[] | null;
}

export interface ModuleItem {
  /** 相邻条目 group 相同时只显示一次分组标题 */
  group: string | null;
  label: string;
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

export interface RunnerConfig {
  id: string;
  name: string;
  /** 按顺序循环播放的帧（data URL）；只有一帧时直接显示（GIF 可自带动画） */
  frames: string[];
}

export interface AppConfig {
  window: { x: number; y: number };
  character: string;
  metrics: { panelIntervalMs: number; idleIntervalMs: number };
  modules: ModuleConfig[];
  runners: RunnerConfig[];
  update: { auto: boolean; skippedVersion: string | null };
  hideOnFullscreen: boolean;
}

export interface UpdateStatus {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "uptodate" | "error";
  version: string | null;
  notes: string | null;
  progress: number;
  error: string | null;
}
