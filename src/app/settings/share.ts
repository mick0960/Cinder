import type { ClickAction, ModuleConfig, ModuleType, Shell, ThresholdRule } from "../../types";
import { blankModule, defaultsFor, defaultUnit, isHttpUrl, moduleProblem, MODULE_TYPES, SHELLS, STYLES, FORMATS } from "./moduleModel";

/** 分享文本里的格式版本号 */
export const SHARE_VERSION = 1;
/** 一次最多导入的模块数，防止误粘贴了一大段东西 */
export const MAX_IMPORT = 50;

const TYPES = MODULE_TYPES.map((t) => t.id);
const SHELL_IDS = SHELLS.map(([v]) => v);
const STYLE_IDS = STYLES.map(([v]) => v);
const FORMAT_IDS = FORMATS.map(([v]) => v);

/* ---------- 导出 ---------- */

/** 分享用的精简对象：不带 id；只写这个类型用得到的字段，常见默认值（PowerShell、文本样式、纯文本）省略 */
function slim(m: ModuleConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { type: m.type, name: m.name };
  if (m.type === "command") {
    out.command = m.command;
    if (m.shell !== "powershell") out.shell = m.shell;
    if (m.format !== "plain") out.format = m.format;
    if (m.persistent) out.persistent = true;
  } else if (m.type === "http") {
    out.url = m.url;
    if (m.jsonPath) out.jsonPath = m.jsonPath;
  } else if (m.type === "ping") {
    out.host = m.host;
  }
  // 常驻进程由脚本自己决定输出节奏，刷新间隔没有意义
  if (!(m.type === "command" && m.persistent)) out.intervalMs = m.intervalMs;
  out.timeoutMs = m.timeoutMs;
  if (m.style !== "text") out.style = m.style;
  // 与类型自带的默认单位不同才写出来；用户把 Ping 的 ms 清空了，要写成空串，否则对方导入时会被默认值补回
  if (m.unit !== defaultUnit(m.type)) out.unit = m.unit ?? "";
  if (m.color) out.color = m.color;
  if (m.thresholds.length) out.thresholds = m.thresholds.map(({ op, value, color }) => ({ op, value, color }));
  if (m.click) {
    out.click = m.click.kind === "command"
      ? { kind: "command", target: m.click.target, shell: m.click.shell }
      : { kind: "url", target: m.click.target };
  }
  return out;
}

export function exportModules(mods: ModuleConfig[]): string {
  return JSON.stringify({ cinder: SHARE_VERSION, modules: mods.map(slim) }, null, 2);
}

/* ---------- 导入 ---------- */

export interface ImportedModule {
  module: ModuleConfig;
  /** 清洗时做过的调整（丢弃了无效字段等），显示在预览里 */
  notes: string[];
}

export interface ImportResult {
  items: ImportedModule[];
  /** 无法导入的内容及原因 */
  errors: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);
const number = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
const color = (v: unknown): string | null =>
  typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim().toLowerCase() : null;

/**
 * 从一段文本里找出 JSON：整段就是 JSON；或夹在 Markdown 代码块里；或前后带了说明文字。
 * 聊天软件里转发的配置常常是后两种。
 */
function extractJson(raw: string): unknown {
  const src = raw.replace(/^﻿/, "").trim();
  if (!src) throw new Error("没有内容");
  const candidates = [src];
  const fenced = src.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const open = src.search(/[[{]/);
  const close = Math.max(src.lastIndexOf("}"), src.lastIndexOf("]"));
  if (open >= 0 && close > open) candidates.push(src.slice(open, close + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* 试下一种 */
    }
  }
  throw new Error("不是有效的 JSON");
}

/** 导入文本可以是：模块数组、`{ cinder, modules }`、完整的 config.json（取其中的 modules）或单个模块对象 */
function moduleList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (isObject(data) && Array.isArray(data.modules)) return data.modules;
  if (isObject(data)) return [data];
  return [];
}

function sanitizeClick(raw: unknown, notes: string[]): ClickAction | null {
  if (raw == null) return null;
  if (!isObject(raw)) {
    notes.push("点击动作格式不正确，已忽略");
    return null;
  }
  const kind = oneOf(raw.kind, ["url", "command"] as const);
  const target = text(raw.target, 2000).trim();
  if (!kind || !target) {
    notes.push("点击动作不完整，已忽略");
    return null;
  }
  if (kind === "url" && !isHttpUrl(target)) {
    notes.push("点击动作的网址不是 http(s)，已忽略");
    return null;
  }
  return { kind, target, shell: oneOf<Shell>(raw.shell, SHELL_IDS) ?? "powershell" };
}

function sanitizeThresholds(raw: unknown, notes: string[]): ThresholdRule[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    notes.push("阈值规则格式不正确，已忽略");
    return [];
  }
  const rules: ThresholdRule[] = [];
  let dropped = 0;
  for (const r of raw.slice(0, 8)) {
    const op = isObject(r) ? oneOf(r.op, ["gt", "lt"] as const) : null;
    const value = isObject(r) ? number(r.value, -1e12, 1e12) : null;
    const c = isObject(r) ? color(r.color) : null;
    if (op && value != null && c) rules.push({ op, value, color: c });
    else dropped++;
  }
  if (raw.length > 8) dropped += raw.length - 8;
  if (dropped) notes.push(`${dropped} 条无效的阈值规则已忽略`);
  return rules;
}

function sanitizeModule(raw: unknown, index: number): ImportedModule | string {
  const label = `第 ${index + 1} 项`;
  if (!isObject(raw)) return `${label}：不是模块对象`;

  // 没写 type 时按填了哪个目标字段推断
  let type: ModuleType;
  if (raw.type === undefined) type = raw.url ? "http" : raw.host ? "ping" : "command";
  else {
    const t = oneOf<ModuleType>(raw.type, TYPES);
    if (!t) return `${label}：不支持的模块类型「${text(raw.type, 20)}」（可能来自更新的 Cinder 版本）`;
    type = t;
  }

  const notes: string[] = [];
  const m = blankModule(type);
  m.name = text(raw.name, 40).trim() || "导入的模块";
  if (type === "command") {
    m.command = text(raw.command, 8000);
    m.shell = oneOf<Shell>(raw.shell, SHELL_IDS) ?? "powershell";
    m.format = oneOf(raw.format, FORMAT_IDS) ?? "plain";
    m.persistent = raw.persistent === true;
  } else if (type === "http") {
    m.url = text(raw.url, 2000).trim();
    m.jsonPath = text(raw.jsonPath, 300).trim();
  } else if (type === "ping") {
    m.host = text(raw.host, 253).trim();
  }
  m.style = oneOf(raw.style, STYLE_IDS) ?? "text";
  // 先按新类型填入默认值，文本里写了的再覆盖
  const d = defaultsFor(m);
  m.intervalMs = number(raw.intervalMs, 500, 86_400_000) ?? d.intervalMs;
  m.timeoutMs = number(raw.timeoutMs, 500, 600_000) ?? d.timeoutMs;
  if (raw.unit !== undefined) m.unit = text(raw.unit, 12) || null;
  m.color = color(raw.color);
  if (raw.color != null && !m.color) notes.push("颜色格式不正确，已忽略");
  m.thresholds = sanitizeThresholds(raw.thresholds, notes);
  m.click = sanitizeClick(raw.click, notes);

  const problem = moduleProblem(m);
  if (problem) return `${label}「${m.name}」：${problem}`;
  return { module: m, notes };
}

/** 解析分享文本。每个模块都经过严格清洗（类型、长度、范围、颜色格式、网址协议），不认识的字段一律丢弃 */
export function parseImport(raw: string): ImportResult {
  let data: unknown;
  try {
    data = extractJson(raw);
  } catch (e) {
    return { items: [], errors: [(e as Error).message] };
  }
  const list = moduleList(data);
  if (list.length === 0) return { items: [], errors: ["里面没有找到任何模块"] };
  const errors: string[] = [];
  if (list.length > MAX_IMPORT) errors.push(`一次最多导入 ${MAX_IMPORT} 个模块，其余 ${list.length - MAX_IMPORT} 个已忽略`);
  const items: ImportedModule[] = [];
  list.slice(0, MAX_IMPORT).forEach((entry, i) => {
    const r = sanitizeModule(entry, i);
    if (typeof r === "string") errors.push(r);
    else items.push(r);
  });
  return { items, errors };
}
