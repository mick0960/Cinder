import type { HttpMethod, ModuleConfig, ModuleType, Shell, ThresholdRule } from "../../types";

let nextId = Date.now();
export const newId = () => "m" + nextId++;

export const MODULE_TYPES: { id: ModuleType; label: string; hint: string }[] = [
  { id: "command", label: "命令", hint: "运行 PowerShell / cmd / 程序，把输出显示在面板里。" },
  { id: "http", label: "HTTP", hint: "请求一个网址，读取响应正文、JSON 字段或响应头。不经过 shell，不启动任何进程。" },
  { id: "ping", label: "Ping", hint: "测量到某台主机的网络延迟（ICMP）。不经过 shell，不启动 ping.exe。" },
  { id: "tcp", label: "TCP", hint: "探测主机 TCP 端口连通性与握手延迟（支持 IPv4 / IPv6），不经过 shell。" },
  { id: "gpu", label: "GPU", hint: "所有显卡的占用率，与任务管理器同源，NVIDIA / AMD / Intel 都适用。不经过 shell。" },
];
export const TYPE_LABEL = Object.fromEntries(MODULE_TYPES.map((t) => [t.id, t.label])) as Record<ModuleType, string>;

export const HTTP_METHODS: HttpMethod[] = ["GET", "HEAD", "POST"];

export const SHELLS: [Shell, string][] = [
  ["powershell", "Windows PowerShell"],
  ["pwsh", "PowerShell 7 (pwsh)"],
  ["cmd", "命令提示符 (cmd)"],
  ["direct", "直接运行程序"],
];
export const STYLES: [ModuleConfig["style"], string][] = [
  ["text", "文本"],
  ["progress", "进度条"],
  ["sparkline", "趋势折线"],
  ["rings", "圆环"],
  ["cards", "指标卡"],
  ["status", "状态列表"],
];
export const FORMATS: [ModuleConfig["format"], string][] = [
  ["plain", "纯文本"],
  ["json", "JSON（text / value / color）"],
];
export const STYLE_LABEL = Object.fromEntries(STYLES) as Record<string, string>;
export const PRESET_COLORS = ["#4cc2ff", "#4cd97b", "#ffb547", "#ff5d5d", "#c58cff", "#ff7ac6", "#5eead4"];

/** 阈值规则可选的颜色：与面板内置指标的警告色一致 */
export const RULE_COLORS: [string, string][] = [
  ["#ff5d5d", "红"],
  ["#ffb547", "橙"],
  ["#4cd97b", "绿"],
  ["#4cc2ff", "蓝"],
];

/** 各类型的默认刷新间隔 / 超时（毫秒） */
const TYPE_DEFAULTS: Record<ModuleType, { intervalMs: number; timeoutMs: number }> = {
  command: { intervalMs: 5000, timeoutMs: 3000 },
  http: { intervalMs: 30000, timeoutMs: 5000 },
  ping: { intervalMs: 3000, timeoutMs: 2000 },
  tcp: { intervalMs: 5000, timeoutMs: 2000 },
  gpu: { intervalMs: 2000, timeoutMs: 5000 },
};
/** 常驻进程里“超时”表示多久没有新输出就判定卡死，要比一般的执行超时宽松 */
export const PERSISTENT_TIMEOUT_MS = 15000;
/** 随类型自动带上的单位：换类型时只要单位还是默认值就跟着换 */
const TYPE_UNIT: Partial<Record<ModuleType, string>> = { ping: "ms", tcp: "ms", gpu: "%" };
export const defaultUnit = (type: ModuleType): string | null => TYPE_UNIT[type] ?? null;

export const defaultsFor = (m: Pick<ModuleConfig, "type" | "persistent">) => ({
  intervalMs: TYPE_DEFAULTS[m.type].intervalMs,
  timeoutMs: m.type === "command" && m.persistent ? PERSISTENT_TIMEOUT_MS : TYPE_DEFAULTS[m.type].timeoutMs,
});

export function blankModule(type: ModuleType = "command"): ModuleConfig {
  return {
    id: newId(),
    type,
    name: "新模块",
    command: type === "command" ? "Write-Output 'hello'" : "",
    shell: "powershell",
    ...TYPE_DEFAULTS[type],
    style: "text",
    format: "plain",
    color: null,
    unit: defaultUnit(type),
    url: "",
    jsonPath: "",
    httpMethod: "GET",
    httpHeaders: [],
    httpBody: "",
    httpResponseHeader: "",
    httpNoProxy: false,
    httpInsecure: false,
    host: "",
    port: type === "tcp" ? 80 : 0,
    persistent: false,
    thresholds: [],
    click: null,
  };
}

/** 切换模块类型：刷新间隔 / 超时 / 单位还是上一个类型的默认值时，跟着换成新类型的默认值 */
export function withType(m: ModuleConfig, type: ModuleType): ModuleConfig {
  if (m.type === type) return m;
  const next: ModuleConfig = { ...m, type, persistent: type === "command" && m.persistent };
  if (type === "tcp" && !m.port) next.port = 80;
  const from = defaultsFor(m);
  const to = defaultsFor(next);
  if (m.intervalMs === from.intervalMs) next.intervalMs = to.intervalMs;
  if (m.timeoutMs === from.timeoutMs) next.timeoutMs = to.timeoutMs;
  if (!m.unit || m.unit === TYPE_UNIT[m.type]) next.unit = TYPE_UNIT[type] ?? null;
  return next;
}

export function withPersistent(m: ModuleConfig, persistent: boolean): ModuleConfig {
  const next = { ...m, persistent };
  if (m.timeoutMs === defaultsFor(m).timeoutMs) next.timeoutMs = defaultsFor(next).timeoutMs;
  return next;
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 保存前的校验；通过返回 null，否则返回给用户看的原因 */
export function moduleProblem(m: ModuleConfig): string | null {
  if (!m.name.trim()) return "名称不能为空";
  if (m.type === "command" && !m.command.trim()) return "命令不能为空";
  if (m.type === "http") {
    if (!HTTP_METHODS.includes(m.httpMethod)) return "HTTP 请求方法必须是 GET、HEAD 或 POST";
    if (!isHttpUrl(m.url)) return "请填写以 http:// 或 https:// 开头的网址";
  }
  if (m.type === "ping" && !m.host.trim()) return "请填写要 Ping 的主机";
  if (m.type === "tcp") {
    if (!m.host.trim()) return "请填写要探测的主机";
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return "端口必须是 1 到 65535 之间的整数";
  }
  if (m.click?.kind === "url" && !isHttpUrl(m.click.target)) return "点击动作的网址需要以 http:// 或 https:// 开头";
  if (m.click?.kind === "command" && !m.click.target.trim()) return "点击动作的命令不能为空";
  if (m.thresholds.some((r) => !Number.isFinite(r.value))) return "阈值必须是数字";
  return null;
}

/** 新增阈值规则时的默认值：第一条“高于 80 变红”，之后依次补橙色预警和低值预警 */
export function nextRule(existing: ThresholdRule[]): ThresholdRule {
  if (!existing.some((r) => r.op === "gt")) return { op: "gt", value: 80, color: "#ff5d5d" };
  if (existing.length === 1) {
    const top = existing[0].value;
    return { op: "gt", value: Math.round(top * 0.75), color: "#ffb547" };
  }
  return { op: "lt", value: 20, color: "#4cc2ff" };
}

/** 一行说明：列表悬停提示、导入预览里用来看模块到底会做什么 */
export function targetOf(m: ModuleConfig): string {
  switch (m.type) {
    case "command": return m.command;
    case "http": {
      const base = m.httpMethod && m.httpMethod !== "GET" ? `${m.httpMethod} ${m.url}` : m.url;
      const parts = [base];
      const hdr = m.httpResponseHeader?.trim();
      const jp = m.jsonPath?.trim();
      if (hdr) parts.push(`Header: ${hdr}`);
      if (jp) parts.push(jp);
      return parts.join("  →  ");
    }
    case "ping": return m.host;
    case "tcp": return `${m.host}:${m.port}`;
    case "gpu": return "所有显卡的占用率";
  }
}
