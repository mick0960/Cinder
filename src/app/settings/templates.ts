import type { ModuleConfig, ModuleType, ThresholdRule } from "../../types";
import { blankModule } from "./moduleModel";

export interface ModuleTemplate {
  id: string;
  name: string;
  icon: string;
  group: "硬件" | "网络" | "系统";
  desc: string;
  /** 卡片上的小标签：实现方式、前置条件 */
  tags: string[];
  /** 覆盖到同类型空白模块上的配置 */
  config: Partial<ModuleConfig> & { type: ModuleType };
}

const WARN = "#ffb547";
const DANGER = "#ff5d5d";
const above = (value: number, color: string): ThresholdRule => ({ op: "gt", value, color });

// 命令都是只读查询。PowerShell 的输出编码由程序统一设成 UTF-8，不需要在脚本里再设置
const UPTIME = `$t = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
if ($t.Days -gt 0) { '{0} 天 {1} 小时' -f $t.Days, $t.Hours } else { '{0} 小时 {1} 分' -f $t.Hours, $t.Minutes }`;

// wsl.exe 把输出写成 UTF-16：读它的时候临时把控制台编码切到 Unicode
const WSL = `$e = [Console]::OutputEncoding; [Console]::OutputEncoding = [Text.Encoding]::Unicode
$r = @(wsl.exe -l --running -q 2>$null | ForEach-Object { $_.Trim() } | Where-Object { $_ })
[Console]::OutputEncoding = $e
if ($r.Count) { $r -join ', ' } else { '未运行' }`;

const DOCKER = `$c = @(docker ps -q 2>$null | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) { '未运行' } else { "$($c.Count) 个容器" }`;

const TOP_MEMORY = `$p = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 1
'{0} {1:N0} MB' -f $p.ProcessName, ($p.WorkingSet64 / 1MB)`;

export const TEMPLATES: ModuleTemplate[] = [
  {
    id: "gpu-usage",
    name: "GPU 占用",
    icon: "🎮",
    group: "硬件",
    desc: "所有显卡的占用率，与任务管理器一致。原生读取，不启动 shell，几乎不占资源。",
    tags: ["原生", "NVIDIA / AMD / Intel"],
    config: { type: "gpu", name: "GPU", style: "progress", thresholds: [above(75, WARN), above(90, DANGER)] },
  },
  {
    id: "gpu-temp-nvidia",
    name: "GPU 温度",
    icon: "🌡️",
    group: "硬件",
    desc: "NVIDIA 显卡的核心温度。nvidia-smi 只启动一次，之后每 2 秒输出一行。",
    tags: ["常驻进程", "需要 NVIDIA 驱动"],
    config: {
      type: "command",
      name: "GPU 温度",
      command: "nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits -l 2 -i 0",
      shell: "direct",
      persistent: true,
      timeoutMs: 15000,
      style: "sparkline",
      unit: "°C",
      thresholds: [above(75, WARN), above(85, DANGER)],
    },
  },
  {
    id: "ping",
    name: "网络延迟",
    icon: "📶",
    group: "网络",
    desc: "到某台主机的延迟（ICMP）。默认 223.5.5.5（阿里 DNS），可以改成任何域名或 IPv4 地址。",
    tags: ["原生", "不启动 ping.exe"],
    config: {
      type: "ping",
      name: "延迟",
      host: "223.5.5.5",
      style: "sparkline",
      thresholds: [above(100, WARN), above(200, DANGER)],
    },
  },
  {
    id: "public-ip",
    name: "公网 IP",
    icon: "🌐",
    group: "网络",
    desc: "当前出口 IP。通过 api.ipify.org 查询，每次展开面板请求一次。",
    tags: ["原生", "访问 api.ipify.org"],
    config: {
      type: "http",
      name: "公网 IP",
      url: "https://api.ipify.org?format=json",
      jsonPath: "ip",
      intervalMs: 300000,
      timeoutMs: 6000,
    },
  },
  {
    id: "uptime",
    name: "开机时长",
    icon: "⏱️",
    group: "系统",
    desc: "系统已经连续运行了多久。",
    tags: ["PowerShell"],
    config: { type: "command", name: "开机时长", command: UPTIME, intervalMs: 60000, timeoutMs: 8000 },
  },
  {
    id: "top-memory",
    name: "最耗内存的进程",
    icon: "🧠",
    group: "系统",
    desc: "当前占用内存最多的进程及其用量。",
    tags: ["PowerShell"],
    config: { type: "command", name: "最耗内存", command: TOP_MEMORY, intervalMs: 10000, timeoutMs: 6000 },
  },
  {
    id: "wsl",
    name: "WSL 状态",
    icon: "🐧",
    group: "系统",
    desc: "正在运行的 WSL 发行版；一个都没有运行时显示“未运行”。",
    tags: ["PowerShell", "需要 WSL"],
    config: { type: "command", name: "WSL", command: WSL, intervalMs: 10000, timeoutMs: 8000 },
  },
  {
    id: "docker",
    name: "Docker 状态",
    icon: "🐳",
    group: "系统",
    desc: "正在运行的容器数量；Docker 没有启动时显示“未运行”。",
    tags: ["PowerShell", "需要 Docker"],
    config: { type: "command", name: "Docker", command: DOCKER, intervalMs: 10000, timeoutMs: 10000 },
  },
];

/** 以模板为蓝本生成一个新模块（独立的 id 和拷贝，修改不会影响模板） */
export function fromTemplate(t: ModuleTemplate): ModuleConfig {
  const config = JSON.parse(JSON.stringify(t.config)) as ModuleTemplate["config"];
  return { ...blankModule(t.config.type), ...config };
}
