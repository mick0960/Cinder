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
  /** 只在篝火动画选了 GPU 驱动时才采样；否则为 null（刚启用的头几秒也是 null） */
  gpu_percent: number | null;
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
  /** 自然单位下的数值（73%→73、23ms→23），阈值着色和驱动篝火用 */
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
  /** 子分组 / 模型池名称（可选；多池账号内部分组用） */
  subgroup?: string | null;
  /** 状态徽章（如 暂停 / PRO） */
  badge?: string | null;
  /** 右侧附加副文本（如重置倒计时） */
  sub?: string | null;
  /** 悬停提示的补充说明 */
  desc?: string | null;
  /** 状态指示点（状态列表样式用：online / offline / warn / error） */
  status?: "online" | "offline" | "warn" | "error" | null;
  /** 底部右侧副文本（状态列表样式用，如占比或离线时长） */
  subRight?: string | null;
  /** 自然单位下的数值（用于指标卡等独立阈值着色） */
  num?: number | null;
}

export type ModuleType = "command" | "http" | "ping" | "tcp" | "gpu";
export type HttpMethod = "GET" | "HEAD" | "POST";
export type Shell = "powershell" | "pwsh" | "cmd" | "direct";

export interface HttpHeader {
  name: string;
  value: string;
}

/** 数值阈值着色：数值高于 / 低于 value 时用 color */
export interface ThresholdRule {
  op: "gt" | "lt";
  value: number;
  color: string;
}

/** 点击模块行：打开网址，或运行命令（shell 仅 command 使用） */
export interface ClickAction {
  kind: "url" | "command";
  target: string;
  shell: Shell;
}

export interface ModuleConfig {
  id: string;
  /** command：运行命令；http：请求网址；ping：ICMP 延迟；tcp：TCP 端口探测；gpu：所有显卡的占用率。后四种不经过 shell */
  type: ModuleType;
  name: string;
  command: string;
  shell: Shell;
  intervalMs: number;
  /** command 轮询：执行超时；command 常驻：多久没有输出就判定卡死并重启；http / ping / tcp：请求或连接超时 */
  timeoutMs: number;
  style: "text" | "progress" | "sparkline" | "rings" | "cards" | "status";
  format: "plain" | "json";
  color: string | null;
  unit: string | null;
  /** http：请求地址 */
  url: string;
  /** http：JSON 字段路径（如 data.items[0].value）；留空则把响应正文或响应头当作文本 */
  jsonPath: string;
  /** http：请求方法 */
  httpMethod: HttpMethod;
  /** http：自定义请求头 */
  httpHeaders: HttpHeader[];
  /** http：POST 请求体 */
  httpBody: string;
  /** http：从指定响应头取值（留空则读取响应正文） */
  httpResponseHeader: string;
  /** http：直连（绕过系统代理） */
  httpNoProxy: boolean;
  /** http：跳过 TLS 证书校验 */
  httpInsecure: boolean;
  /** ping / tcp：主机名或 IP 地址 */
  host: string;
  /** tcp：目标端口（1~65535） */
  port: number;
  /** command：只启动一次，每输出一行刷新一次 */
  persistent: boolean;
  thresholds: ThresholdRule[];
  click: ClickAction | null;
}

export type DriverSource = "cpu" | "mem" | "gpu" | "net_down" | "net_up" | "net" | "module";

/** 篝火动画速度由哪个指标驱动 */
export interface DriverConfig {
  source: DriverSource;
  /** source 为 module 时的模块 id */
  moduleId: string | null;
  /** net*：只用 max（MB/s，达到时最快）；module：min~max（模块数值）映射到 0~100%；其余固定按 0~100% */
  min: number;
  max: number;
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
  edgeHide: boolean;
  /** 多少分钟没有操作后篝火变成余烬；0 为关闭 */
  idleEmberMinutes: number;
  driver: DriverConfig;
}

export interface UpdateStatus {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "uptodate" | "error";
  version: string | null;
  notes: string | null;
  progress: number;
  error: string | null;
}
