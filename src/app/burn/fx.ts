/**
 * 焚烧特效（Canvas 2D）：文件卡片自下而上被烧穿——先焦黄、再焦黑、边缘发光、最后化为灰烬，
 * 伴随火焰、火星、烟雾、灰烬粒子。坐标一律用 CSS 像素，绘制时按 devicePixelRatio 放大。
 */

export interface BurnTarget {
  name: string;
  isDir: boolean;
  count: number;
}

/** 图标在覆盖窗口内的位置（CSS 像素）：水平中心、上边缘、边长 */
export interface Anchor {
  cx: number;
  top: number;
  size: number;
}

type Phase = "idle" | "burning" | "done" | "cancel" | "failed";

const CARD_W = 84;
const CARD_H = 100;
// 阈值场里各燃烧带的宽度：发光余烬 → 焦黑 → 焦黄
const EMBER = 0.035;
const CHAR = 0.11;
const SCORCH = 0.09;
/** 前 6% 的时间卡片刚落到火上，还没烧穿 */
const IGNITE = 0.06;
/** 删除结果迟迟不来（异常情况）时自行熄火 */
const STALL_S = 30;

const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
/** 近似正态分布，范围约 [-1, 1] */
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);

// ---------- 颜色与贴图 ----------

type RGB = [number, number, number];
const lerpRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 火焰从诞生到消散的颜色：白黄 → 金黄 → 橙 → 红 → 暗红 */
const FLAME_RAMP: [number, RGB][] = [
  [0, [255, 250, 228]],
  [0.18, [255, 222, 125]],
  [0.42, [255, 150, 45]],
  [0.7, [228, 72, 20]],
  [1, [110, 24, 10]],
];
function flameColor(t: number): RGB {
  for (let i = 1; i < FLAME_RAMP.length; i++) {
    const [t1, c1] = FLAME_RAMP[i];
    if (t <= t1) {
      const [t0, c0] = FLAME_RAMP[i - 1];
      return lerpRgb(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return FLAME_RAMP[FLAME_RAMP.length - 1][1];
}

function radialSprite(rgb: RGB, mid: number, px = 48): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d")!;
  const r = px / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  const [cr, cg, cb] = rgb.map(Math.round);
  grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
  grad.addColorStop(0.35, `rgba(${cr},${cg},${cb},${mid})`);
  grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  return c;
}

const FLAME_STEPS = 24;
let flameSprites: HTMLCanvasElement[] | null = null;
let smokeSprite: HTMLCanvasElement | null = null;
function sprites() {
  flameSprites ??= Array.from({ length: FLAME_STEPS }, (_, i) => radialSprite(flameColor(i / (FLAME_STEPS - 1)), 0.55));
  smokeSprite ??= radialSprite([74, 68, 64], 0.6, 64);
  return { flame: flameSprites, smoke: smokeSprite };
}

// ---------- 值噪声：让烧穿的边缘参差不齐 ----------

function hash(x: number, y: number, seed: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, y: number, seed: number) =>
  0.5 * valueNoise(x, y, seed) + 0.3 * valueNoise(x * 2.1, y * 2.1, seed + 1) + 0.2 * valueNoise(x * 4.3, y * 4.3, seed + 2);

// ---------- 文件卡片 ----------

const EXT_COLORS: Record<string, string> = {
  pdf: "#e5483f", doc: "#2f6fd8", docx: "#2f6fd8", xls: "#1f9d55", xlsx: "#1f9d55", csv: "#1f9d55",
  ppt: "#e0662c", pptx: "#e0662c", zip: "#8e6bd6", rar: "#8e6bd6", "7z": "#8e6bd6",
  png: "#d6458f", jpg: "#d6458f", jpeg: "#d6458f", gif: "#d6458f", webp: "#d6458f",
  mp3: "#0f9fb5", wav: "#0f9fb5", mp4: "#c2410c", mkv: "#c2410c", exe: "#475569", txt: "#64748b",
};

function wrapName(g: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (g.measureText(cur + ch).width > width && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) break;
    } else cur += ch;
  }
  if (lines.length < maxLines) lines.push(cur);
  else {
    // 放不下：最后一行截断加省略号
    let last = lines[maxLines - 1];
    while (last && g.measureText(last + "…").width > width) last = last.slice(0, -1);
    lines[maxLines - 1] = last + "…";
  }
  return lines;
}

function drawSheet(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ghost: boolean) {
  const fold = 14;
  g.beginPath();
  g.moveTo(x + 3, y);
  g.lineTo(x + w - fold, y);
  g.lineTo(x + w, y + fold);
  g.lineTo(x + w, y + h - 3);
  g.quadraticCurveTo(x + w, y + h, x + w - 3, y + h);
  g.lineTo(x + 3, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - 3);
  g.lineTo(x, y + 3);
  g.quadraticCurveTo(x, y, x + 3, y);
  g.closePath();
  const paper = g.createLinearGradient(0, y, 0, y + h);
  paper.addColorStop(0, ghost ? "#e9e3d6" : "#fdfaf3");
  paper.addColorStop(1, ghost ? "#d8d0bf" : "#ece4d3");
  g.fillStyle = paper;
  g.fill();
  g.strokeStyle = "rgba(60, 45, 30, 0.28)";
  g.lineWidth = 1;
  g.stroke();
  // 折角
  g.beginPath();
  g.moveTo(x + w - fold, y);
  g.lineTo(x + w - fold, y + fold - 2);
  g.quadraticCurveTo(x + w - fold, y + fold, x + w - fold + 2, y + fold);
  g.lineTo(x + w, y + fold);
  g.closePath();
  g.fillStyle = ghost ? "#c9bfab" : "#ddd3c0";
  g.fill();
  if (ghost) return;
  // 正文行
  g.fillStyle = "rgba(90, 76, 60, 0.3)";
  for (let i = 0; i < 5; i++) g.fillRect(x + 8, y + 33 + i * 6, w - 16 - (i === 4 ? 16 : (i * 7) % 10), 2.2);
}

function drawFolder(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ghost: boolean) {
  const r = 4;
  // 后片 + 标签
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w * 0.38, y);
  g.lineTo(x + w * 0.46, y + 7);
  g.lineTo(x + w - r, y + 7);
  g.quadraticCurveTo(x + w, y + 7, x + w, y + 7 + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
  g.fillStyle = ghost ? "#c88f12" : "#e2a51c";
  g.fill();
  // 前片
  const fy = y + 14;
  g.beginPath();
  g.moveTo(x + r, fy);
  g.lineTo(x + w - r, fy);
  g.quadraticCurveTo(x + w, fy, x + w, fy + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, fy + r);
  g.quadraticCurveTo(x, fy, x + r, fy);
  g.closePath();
  const body = g.createLinearGradient(0, fy, 0, y + h);
  body.addColorStop(0, ghost ? "#e8bd4c" : "#ffd96a");
  body.addColorStop(1, ghost ? "#d9a52a" : "#f2b632");
  g.fillStyle = body;
  g.fill();
  g.strokeStyle = "rgba(120, 80, 10, 0.35)";
  g.lineWidth = 1;
  g.stroke();
}

function paintCard(g: CanvasRenderingContext2D, t: BurnTarget) {
  const multi = t.count > 1;
  if (t.isDir) {
    if (multi) drawFolder(g, 15, 4, 62, 50, true);
    drawFolder(g, 11, 10, 62, 52, false);
  } else {
    if (multi) drawSheet(g, 19, 0, 52, 66, true);
    drawSheet(g, 15, 4, 52, 66, false);
    const dot = t.name.lastIndexOf(".");
    const ext = dot > 0 ? t.name.slice(dot + 1).toLowerCase() : "";
    if (ext && ext.length <= 5) {
      g.font = 'bold 9px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      const label = ext.toUpperCase();
      const bw = Math.max(22, g.measureText(label).width + 8);
      g.fillStyle = EXT_COLORS[ext] ?? "#6b7280";
      g.beginPath();
      g.roundRect(21, 16, bw, 13, 2.5);
      g.fill();
      g.fillStyle = "#fff";
      g.textBaseline = "middle";
      g.fillText(label, 25, 23);
    }
  }
  if (multi) {
    const label = t.count > 99 ? "99+" : String(t.count);
    g.font = 'bold 9px "Segoe UI", sans-serif';
    const bw = Math.max(16, g.measureText(label).width + 8);
    g.fillStyle = "#ff5a36";
    g.beginPath();
    g.roundRect(72 - bw / 2, 2, bw, 16, 8);
    g.fill();
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, 72, 10.5);
    g.textAlign = "start";
  }
  // 文件名：白字黑描边，任何壁纸上都能看清
  g.font = '10px "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
  g.textAlign = "center";
  g.textBaseline = "top";
  g.lineJoin = "round";
  const lines = multi ? [wrapName(g, t.name, CARD_W - 4, 1)[0], `等 ${t.count} 项`] : wrapName(g, t.name, CARD_W - 4, 2);
  lines.forEach((line, i) => {
    g.lineWidth = 3;
    g.strokeStyle = "rgba(0, 0, 0, 0.7)";
    g.strokeText(line, CARD_W / 2, 74 + i * 12);
    g.fillStyle = "#fff";
    g.fillText(line, CARD_W / 2, 74 + i * 12);
  });
}

/**
 * 卡片像素按阈值场 F（自下而上 + 噪声，归一化到 0~1）排序；
 * 燃烧线 t 从 0 扫到 1，F 落在 t 附近的像素依次经历焦黄、焦黑、余烬、消失。
 */
class Card {
  readonly canvas = document.createElement("canvas");
  private readonly g: CanvasRenderingContext2D;
  private readonly src: Uint8ClampedArray;
  private readonly out: ImageData;
  /** 不透明像素下标，按 F 升序 */
  private readonly order: Int32Array;
  /** 与 order 对应的 F 值（升序） */
  private readonly f: Float32Array;
  readonly w: number;
  readonly h: number;

  constructor(readonly target: BurnTarget, readonly dpr: number) {
    this.w = Math.round(CARD_W * dpr);
    this.h = Math.round(CARD_H * dpr);
    const paint = document.createElement("canvas");
    paint.width = this.w;
    paint.height = this.h;
    const pg = paint.getContext("2d")!;
    pg.scale(dpr, dpr);
    paintCard(pg, target);
    this.src = pg.getImageData(0, 0, this.w, this.h).data;

    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.g = this.canvas.getContext("2d")!;
    this.out = this.g.createImageData(this.w, this.h);

    const seed = (Math.random() * 1e9) | 0;
    const ids: number[] = [];
    const raw: number[] = [];
    const scale = 1 / (13 * dpr);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        if (this.src[i * 4 + 3] === 0) continue;
        ids.push(i);
        raw.push(0.62 * (1 - y / this.h) + 0.38 * fbm(x * scale, y * scale, seed));
      }
    }
    let lo = Infinity, hi = -Infinity;
    for (const v of raw) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const span = hi - lo || 1;
    const sorted = ids.map((id, k) => [id, (raw[k] - lo) / span] as const).sort((a, b) => a[1] - b[1]);
    this.order = Int32Array.from(sorted, (s) => s[0]);
    this.f = Float32Array.from(sorted, (s) => s[1]);
  }

  /** 进度 p∈[0,1] 对应的燃烧线位置：p=0 时连焦黄都还没出现，p=1 时全部烧尽 */
  static line(p: number) {
    return -(CHAR + SCORCH) + p * (1.001 + CHAR + SCORCH);
  }

  render(p: number, time: number) {
    const t = Card.line(p);
    const s = this.src, o = this.out.data, order = this.order, f = this.f;
    // 余烬亮度轻微闪动
    const glow = 0.85 + 0.15 * Math.sin(time * 23) * Math.sin(time * 7.3);
    for (let k = 0; k < order.length; k++) {
      const j = order[k] * 4;
      const d = f[k] - t;
      if (d < 0) {
        o[j + 3] = 0;
        continue;
      }
      let r = s[j], g = s[j + 1], b = s[j + 2], a = s[j + 3];
      if (d < CHAR + SCORCH) {
        // 焦黄：原色向棕色靠拢、变暗；越靠近焦黑带越深
        const ks = d < CHAR ? 0 : (d - CHAR) / SCORCH;
        const w = (1 - ks) * 0.6;
        const sr = r + (128 - r) * w, sg = g + (78 - g) * w, sb = b + (34 - b) * w;
        if (d >= CHAR) {
          r = sr; g = sg; b = sb;
        } else if (d >= EMBER) {
          // 焦黑：贴着余烬一侧是暗红，往外变成炭黑，再过渡回焦黄
          const kc = (d - EMBER) / (CHAR - EMBER);
          if (kc < 0.3) {
            const m = kc / 0.3;
            r = 120 + (26 - 120) * m; g = 34 + (17 - 34) * m; b = 10 + (11 - 10) * m;
          } else {
            const m = Math.pow((kc - 0.3) / 0.7, 1.6);
            r = 26 + (sr - 26) * m; g = 17 + (sg - 17) * m; b = 11 + (sb - 11) * m;
          }
          a = Math.max(a, 200);
        } else {
          // 发光余烬：最外缘白黄，往里是橙红
          const ke = d / EMBER;
          r = 255;
          g = (238 - 128 * ke) * glow;
          b = (170 - 160 * ke) * glow;
          a = 255;
        }
      }
      o[j] = r;
      o[j + 1] = g;
      o[j + 2] = b;
      o[j + 3] = a;
    }
    this.g.putImageData(this.out, 0, 0);
  }

  /** 在阈值场区间 [t+lo, t+hi) 内随机取一个像素，返回卡片内坐标（CSS 像素） */
  sample(p: number, lo: number, hi: number): [number, number] | null {
    const t = Card.line(p);
    const a = this.lowerBound(t + lo), b = this.lowerBound(t + hi);
    if (b <= a) return null;
    const i = this.order[a + ((Math.random() * (b - a)) | 0)];
    return [(i % this.w) / this.dpr, Math.floor(i / this.w) / this.dpr];
  }

  private lowerBound(v: number) {
    let lo = 0, hi = this.f.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.f[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

// ---------- 粒子 ----------

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  seed: number;
  /** 灰烬的旋转角 */
  rot: number;
  vr: number;
}

const spawn = (x: number, y: number, vx: number, vy: number, life: number, size: number, rot = 0, vr = 0): Particle => ({
  x, y, vx, vy, age: 0, life, size, seed: Math.random() * 100, rot, vr,
});

const CAP = { flames: 700, sparks: 160, smoke: 70, ash: 160 };

export class BurnFx {
  onIdle: (() => void) | null = null;

  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private anchor: Anchor = { cx: 100, top: 196, size: 64 };
  private phase: Phase = "idle";
  private phaseT = 0;
  private card: Card | null = null;
  private startAt = 0;
  private duration = 4000;
  private p = 0;
  /** 卡片火势 0~1 */
  private heat = 0;
  private cardIn = 0;
  private cardAlpha = 0;
  private cardDrop = 0;
  private flash = 0;
  private time = 0;
  private last = 0;
  private running = false;
  private emitAcc = { edge: 0, smoke: 0, ash: 0 };
  private flames: Particle[] = [];
  private sparks: Particle[] = [];
  private smoke: Particle[] = [];
  private ash: Particle[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  setAnchor(a: Anchor) {
    this.anchor = a;
  }

  /** 开始燃烧；elapsedMs 用于覆盖窗口晚到时追上后端计时，保证卡片恰好在删除时烧完 */
  start(target: BurnTarget, durationMs: number, elapsedMs: number) {
    this.resize();
    const same =
      this.card &&
      this.card.dpr === this.dpr &&
      this.card.target.name === target.name &&
      this.card.target.isDir === target.isDir &&
      this.card.target.count === target.count;
    if (!same) this.card = new Card(target, this.dpr);
    if (this.cardAlpha <= 0.01) this.cardIn = 0;
    this.setPhase("burning");
    this.duration = durationMs;
    this.startAt = performance.now() - elapsedMs;
    this.p = 0;
    this.cardAlpha = 1;
    this.cardDrop = 0;
    this.run();
  }

  /** 提前离开 / 松手：停止烧穿，卡片带着焦边退出火堆，火势很快熄灭 */
  cancel() {
    if (this.phase !== "burning") return;
    this.setPhase("cancel");
    this.puff(10);
  }

  /** 已移到回收站：闪光 + 火星爆散，剩余灰烬飘散 */
  finish() {
    this.setPhase("done");
    this.flash = 1;
    const c = this.card;
    if (c && this.cardAlpha > 0) {
      for (let i = 0; i < 40; i++) {
        const pt = c.sample(this.p, 0, 2) ?? [CARD_W / 2, CARD_H / 2];
        const [x, y] = this.toWorld(pt[0], pt[1]);
        this.sparks.push(spawn(x, y, gauss() * 90, rand(-160, -40), rand(0.5, 1.1), rand(1, 1.8)));
      }
      for (let i = 0; i < 26; i++) {
        const pt = c.sample(this.p, 0, 2);
        if (!pt) break;
        const [x, y] = this.toWorld(pt[0], pt[1]);
        this.ash.push(spawn(x, y, gauss() * 30, rand(-60, -15), rand(1.2, 2.2), rand(1.5, 3.5), rand(0, 6), gauss() * 6));
      }
    }
    this.p = 1;
    this.run();
  }

  /** 删除失败：卡片完好地退回来、抖一抖 */
  fail() {
    this.setPhase("failed");
    this.p = 0;
    this.cardIn = 1;
    this.cardAlpha = 0;
    this.cardDrop = 0;
    this.puff(8);
    this.run();
  }

  /** 拒绝焚烧：没有卡片，篝火只冒一下烟 */
  refuse() {
    this.resize();
    this.setPhase("failed");
    this.card = null;
    this.cardAlpha = 0;
    const { cx, top, size } = this.anchor;
    for (let i = 0; i < 8; i++) this.smoke.push(spawn(cx + gauss() * 8, top + size * 0.3, gauss() * 6, rand(-30, -18), rand(1.2, 1.8), rand(6, 10)));
    this.run();
  }

  /** 提示气泡的位置：卡片正上方（没有卡片时在图标上方） */
  tipPos(): { x: number; y: number } {
    const { cx, top } = this.anchor;
    if (!this.card) return { x: cx, y: Math.max(28, top - 10) };
    const [x, y] = this.cardCenter();
    return { x, y: Math.max(28, y - CARD_H / 2 - 8) };
  }

  // ---------- 内部 ----------

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  private run() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;
    this.phaseT += dt;
    this.update(dt, now);
    this.draw();
    if (this.idle()) {
      this.running = false;
      this.phase = "idle";
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.onIdle?.();
      return;
    }
    requestAnimationFrame(this.frame);
  };

  private idle() {
    const hold = this.phase === "done" ? 1.4 : this.phase === "failed" ? 1.8 : 0;
    return (
      this.phase !== "burning" &&
      this.phaseT >= hold &&
      this.heat < 0.01 &&
      this.cardAlpha <= 0 &&
      this.flash <= 0 &&
      this.flames.length + this.sparks.length + this.smoke.length + this.ash.length === 0
    );
  }

  private cardCenter(): [number, number] {
    const { cx, top } = this.anchor;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    // 默认悬在篝火上方、下沿压进火苗；贴近屏幕边缘时夹在窗口内
    return [clamp(cx, CARD_W / 2 + 4, W - CARD_W / 2 - 4), clamp(top - 22, CARD_H / 2 + 4, H - CARD_H / 2 - 4)];
  }

  private cardPose() {
    const [bx, by] = this.cardCenter();
    const k = easeOut(clamp(this.cardIn, 0, 1));
    const shake = this.phase === "failed" ? Math.sin(this.time * 46) * 3 * Math.max(0, 1 - this.phaseT / 0.6) : 0;
    return {
      x: bx + shake,
      y: by + Math.sin(this.time * 2.3) * 1.5 + (1 - k) * 22 + this.cardDrop,
      rot: Math.sin(this.time * 1.4) * 0.035 + shake * 0.01,
      scale: 0.78 + 0.22 * k,
    };
  }

  private toWorld(lx: number, ly: number): [number, number] {
    const { x, y, rot, scale } = this.cardPose();
    const dx = (lx - CARD_W / 2) * scale, dy = (ly - CARD_H / 2) * scale;
    const c = Math.cos(rot), s = Math.sin(rot);
    return [x + dx * c - dy * s, y + dx * s + dy * c];
  }

  /** 熄火时冒出的一团烟 */
  private puff(n: number) {
    const [x, y] = this.cardCenter();
    for (let i = 0; i < n; i++) this.smoke.push(spawn(x + gauss() * 18, y + CARD_H * 0.3, gauss() * 10, rand(-34, -18), rand(1.2, 2), rand(7, 12)));
  }

  /** 按速率累积发射，避免低帧率时粒子数随帧率波动 */
  private emit(key: keyof BurnFx["emitAcc"], rate: number, dt: number, fn: () => void) {
    this.emitAcc[key] += rate * dt;
    while (this.emitAcc[key] >= 1) {
      this.emitAcc[key] -= 1;
      fn();
    }
  }

  private update(dt: number, now: number) {
    const ph = this.phase;
    const u = (now - this.startAt) / this.duration;

    // 进度、火势、卡片
    if (ph === "burning") {
      this.p = Math.pow(clamp((u - IGNITE) / (1 - IGNITE), 0, 1), 1.15);
      const target = u < IGNITE ? 0.35 + 0.25 * (u / IGNITE) : 0.6 + 0.4 * this.p;
      this.heat += (target - this.heat) * Math.min(1, dt * 5);
      this.cardIn = Math.min(1, this.cardIn + dt / 0.28);
      if (u > 1 + STALL_S / (this.duration / 1000)) this.cancel();
    } else {
      const rate = ph === "done" ? 1.5 : ph === "cancel" ? 4 : 3;
      this.heat += (0 - this.heat) * Math.min(1, dt * rate);
      if (this.heat < 0.01) this.heat = 0;
    }
    if (ph === "done") this.p = Math.min(1, this.p + dt * 2);
    if (ph === "done" && this.p >= 1) this.cardAlpha = 0;
    if (ph === "cancel") {
      this.cardAlpha = Math.max(0, this.cardAlpha - dt / 0.45);
      this.cardDrop += dt * 34;
    }
    if (ph === "failed" && this.card) {
      this.cardAlpha = this.phaseT < 1.3 ? Math.min(1, this.cardAlpha + dt / 0.25) : Math.max(0, this.cardAlpha - dt / 0.4);
    }
    this.flash = Math.max(0, this.flash - dt / 0.3);

    // 发射：火只在卡片上烧——火舌、火星、灰烬都从燃烧带冒出，烟从卡片上方升起
    const c = this.card;
    const heat = this.heat;
    if (c && this.cardAlpha > 0 && heat > 0.02) {
      this.emit("smoke", 9 * heat, dt, () => {
        const [x, y] = this.toWorld(CARD_W / 2, 0);
        this.smoke.push(spawn(x + gauss() * 14, y + rand(-6, 14), gauss() * 8, -rand(16, 30), rand(1.6, 2.4), rand(7, 11)));
      });
    }
    if (c && this.cardAlpha > 0 && (ph === "burning" || ph === "done") && this.p > 0 && this.p < 1) {
      this.emit("edge", 240 * Math.max(0.5, heat), dt, () => {
        const pt = c.sample(this.p, 0, EMBER * 1.5);
        if (!pt) return;
        const [x, y] = this.toWorld(pt[0], pt[1]);
        this.flames.push(spawn(x, y, gauss() * 12, -rand(35, 80), rand(0.4, 0.8), rand(6, 12)));
        if (Math.random() < 0.1) this.sparks.push(spawn(x, y, gauss() * 40, -rand(60, 140), rand(0.5, 1), rand(0.9, 1.5)));
      });
      this.emit("ash", 22, dt, () => {
        const pt = c.sample(this.p, -0.03, 0);
        if (!pt) return;
        const [x, y] = this.toWorld(pt[0], pt[1]);
        this.ash.push(spawn(x, y, gauss() * 12, -rand(15, 45), rand(1.2, 2.1), rand(1.5, 3.4), rand(0, 6), gauss() * 5));
      });
    }

    // 运动
    const t = this.time;
    for (const f of this.flames) {
      f.age += dt;
      f.vy -= 75 * dt; // 热空气上升，越来越快
      f.vx += Math.sin(t * (6 + (f.seed % 4)) + f.seed * 10) * 75 * dt;
      f.vx *= 1 - 1.5 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
    }
    for (const s of this.sparks) {
      s.age += dt;
      s.vy -= 25 * dt;
      s.vx += Math.sin(t * 9 + s.seed * 7) * 90 * dt;
      s.vx *= 1 - 0.8 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    for (const s of this.smoke) {
      s.age += dt;
      s.vx += Math.sin(t * 1.5 + s.seed * 5) * 14 * dt;
      s.size += 16 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    for (const a of this.ash) {
      a.age += dt;
      a.vy -= 6 * dt;
      a.x += (a.vx + Math.sin(t * 2.2 + a.seed) * 14) * dt;
      a.y += a.vy * dt;
      a.rot += a.vr * dt;
    }
    const alive = (p: Particle) => p.age < p.life && p.y > -40;
    const prune = (arr: Particle[], cap: number) => {
      const next = arr.filter(alive);
      return next.length > cap ? next.slice(next.length - cap) : next;
    };
    this.flames = prune(this.flames, CAP.flames);
    this.sparks = prune(this.sparks, CAP.sparks);
    this.smoke = prune(this.smoke, CAP.smoke);
    this.ash = prune(this.ash, CAP.ash);
  }

  private draw() {
    const g = this.ctx, dpr = this.dpr;
    const { flame: flameSprites, smoke: smokeSprite } = sprites();
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);

    // 烟在最底层
    for (const s of this.smoke) {
      const a = s.age / s.life;
      g.globalAlpha = 0.15 * Math.sin(Math.PI * a);
      g.drawImage(smokeSprite, s.x - s.size, s.y - s.size, s.size * 2, s.size * 2);
    }

    // 卡片
    if (this.card && this.cardAlpha > 0) {
      this.card.render(this.p, this.time);
      const { x, y, rot, scale } = this.cardPose();
      g.save();
      g.globalAlpha = this.cardAlpha;
      g.translate(x, y);
      g.rotate(rot);
      g.scale(scale, scale);
      g.drawImage(this.card.canvas, -CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H);
      g.restore();
    }

    // 灰烬：刚脱落时还带着火光，随后冷却成灰
    for (const a of this.ash) {
      const k = a.age / a.life;
      const [r, gg, b] = lerpRgb([255, 150, 50], [72, 68, 64], Math.min(1, k * 3.5));
      const c = Math.cos(a.rot), s = Math.sin(a.rot);
      g.setTransform(dpr * c, dpr * s, -dpr * s, dpr * c, dpr * a.x, dpr * a.y);
      g.globalAlpha = 0.9 * Math.pow(1 - k, 1.2);
      g.fillStyle = `rgb(${r | 0}, ${gg | 0}, ${b | 0})`;
      g.fillRect(-a.size / 2, -a.size / 3, a.size, a.size * 0.66);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 火焰与火星叠加发光
    g.globalCompositeOperation = "lighter";
    for (const f of this.flames) {
      const a = f.age / f.life;
      const alpha = (a < 0.12 ? a / 0.12 : Math.pow(1 - a, 1.2)) * 0.45;
      const r = f.size * (1 - 0.7 * a);
      g.globalAlpha = alpha;
      g.drawImage(flameSprites[Math.min(FLAME_STEPS - 1, (a * FLAME_STEPS) | 0)], f.x - r, f.y - r, r * 2, r * 2);
    }
    g.lineCap = "round";
    for (const s of this.sparks) {
      const a = s.age / s.life;
      const [r, gg, b] = flameColor(Math.min(1, a * 0.9));
      g.globalAlpha = (1 - a) * (0.65 + 0.35 * Math.random());
      g.strokeStyle = `rgb(${r | 0}, ${gg | 0}, ${b | 0})`;
      g.lineWidth = s.size;
      g.beginPath();
      g.moveTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
      g.lineTo(s.x, s.y);
      g.stroke();
    }
    if (this.flash > 0) {
      const [x, y] = this.cardCenter();
      const r = 80;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(255, 236, 180, ${0.75 * this.flash})`);
      grad.addColorStop(1, "rgba(255, 140, 40, 0)");
      g.globalAlpha = 1;
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }
}
