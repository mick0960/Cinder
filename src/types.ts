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
  /** 0~1 的比例，进度条 / 折线用 */
  value: number | null;
  /** 自然单位下的数值（73%→73、23ms→23） */
  num: number | null;
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

export type ModuleType = "command" | "http" | "ping" | "gpu";
export type Shell = "powershell" | "pwsh" | "cmd" | "direct";

export interface ModuleConfig {
  id: string;
  /** command：运行命令；http：请求网址取 JSON 字段；ping：ICMP 延迟；gpu：所有显卡的占用率。后三种不经过 shell */
  type: ModuleType;
  name: string;
  command: string;
  shell: Shell;
  intervalMs: number;
  /** command 轮询：执行超时；command 常驻：多久没有输出就判定卡死并重启；http / ping：请求超时 */
  timeoutMs: number;
  style: "text" | "progress" | "sparkline";
  format: "plain" | "json";
  color: string | null;
  unit: string | null;
  /** http：请求地址 */
  url: string;
  /** http：JSON 字段路径（如 data.items[0].value）；留空则把响应正文当作文本 */
  jsonPath: string;
  /** ping：主机名或 IPv4 地址 */
  host: string;
  /** command：只启动一次，每输出一行刷新一次 */
  persistent: boolean;
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
