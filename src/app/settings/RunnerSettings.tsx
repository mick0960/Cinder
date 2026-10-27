import { createSignal, For, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, RunnerConfig } from "../../types";

const MAX_FRAMES = 24;
const MAX_GIF_BYTES = 3 * 1024 * 1024;
const PREVIEW_FRAME_MS = 140;

const readAsDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/** 缩放到 128x128 的透明底 PNG，控制配置文件体积；GIF 保持原样以保留动画 */
async function fileToFrame(f: File): Promise<string> {
  const raw = await readAsDataUrl(f);
  if (f.type === "image/gif") {
    if (f.size > MAX_GIF_BYTES) throw new Error(`${f.name} 超过 3MB`);
    return raw;
  }
  const img = new Image();
  await new Promise<void>((ok, bad) => {
    img.onload = () => ok();
    img.onerror = () => bad(new Error(`${f.name} 无法解码`));
    img.src = raw;
  });
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d")!;
  const k = Math.min(S / (img.width || S), S / (img.height || S));
  const w = (img.width || S) * k, h = (img.height || S) * k;
  ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
  return c.toDataURL("image/png");
}

const BUILTIN: [string, string, string][] = [["bonfire", "篝火（内置）", "🔥"]];

/** 预览：按固定节奏循环播放所有帧 */
function FramePreview(props: { frames: string[] }) {
  const [i, setI] = createSignal(0);
  const timer = window.setInterval(() => setI((x) => x + 1), PREVIEW_FRAME_MS);
  onCleanup(() => clearInterval(timer));
  return (
    <div class="preview" classList={{ empty: !props.frames.length }}>
      <Show when={props.frames.length} fallback={<span class="preview-ph">?</span>}>
        <img src={props.frames[i() % props.frames.length]} draggable={false} />
      </Show>
    </div>
  );
}

export function RunnerSettings() {
  const [runners, setRunners] = createSignal<RunnerConfig[]>([]);
  const [current, setCurrent] = createSignal("bonfire");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [msg, setMsg] = createSignal("");
  const [dragOver, setDragOver] = createSignal(false);
  const [confirmDel, setConfirmDel] = createSignal(false);
  let fileInput!: HTMLInputElement;

  invoke<AppConfig>("get_config").then((c) => {
    setRunners(c.runners ?? []);
    setCurrent(c.character || "bonfire");
    if (c.runners?.length) setSelected(c.runners[0].id);
  });

  const persist = async (next: RunnerConfig[]) => {
    setRunners(next);
    try {
      await invoke("save_runners", { runners: next });
      // 后端会在当前角色被删除时回退到内置篝火，这里同步一次
      const c = await invoke<AppConfig>("get_config");
      setCurrent(c.character || "bonfire");
    } catch (e) {
      setMsg("保存失败：" + String(e));
    }
  };

  const editing = () => runners().find((r) => r.id === selected()) ?? null;
  const patch = (p: Partial<RunnerConfig>) =>
    persist(runners().map((r) => (r.id === selected() ? { ...r, ...p } : r)));

  const pick = (id: string) => {
    setSelected(id);
    setConfirmDel(false);
    setMsg("");
  };

  const addRunner = () => {
    const r: RunnerConfig = { id: "r" + Date.now(), name: "新角色", frames: [] };
    pick(r.id);
    persist([...runners(), r]);
  };

  // 删除二次确认，3 秒后自动复原
  let delTimer = 0;
  onCleanup(() => clearTimeout(delTimer));
  const removeRunner = () => {
    const id = selected();
    if (!id) return;
    if (!confirmDel()) {
      setConfirmDel(true);
      clearTimeout(delTimer);
      delTimer = window.setTimeout(() => setConfirmDel(false), 3000);
      return;
    }
    clearTimeout(delTimer);
    setConfirmDel(false);
    const rest = runners().filter((r) => r.id !== id);
    setSelected(rest[0]?.id ?? null);
    persist(rest);
  };

  const addFrames = async (files: FileList | null | undefined) => {
    const r = editing();
    if (!r || !files?.length) return;
    const list = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!list.length) {
      setMsg("只支持图片文件");
      return;
    }
    try {
      const frames = await Promise.all(list.map(fileToFrame));
      const all = [...r.frames, ...frames];
      setMsg(all.length > MAX_FRAMES ? `最多 ${MAX_FRAMES} 帧，多余的已忽略` : "");
      await patch({ frames: all.slice(0, MAX_FRAMES) });
    } catch (e) {
      setMsg(String((e as Error).message ?? e));
    } finally {
      fileInput.value = "";
    }
  };

  const removeFrame = (idx: number) => {
    const r = editing();
    if (r) patch({ frames: r.frames.filter((_, i) => i !== idx) });
  };

  const use = async (character: string) => {
    await invoke("set_character", { character });
    setCurrent(character);
  };

  return (
    <div class="cols pane-in">
      <div class="left">
        <div class="left-head">
          <span>角色</span>
          <button class="add" onClick={addRunner}><span class="plus">＋</span> 新增</button>
        </div>
        <div class="mlist">
          <For each={BUILTIN}>
            {([id, name, emoji]) => (
              <div class="mitem" classList={{ using: current() === id }} onClick={() => use(id)}>
                <span class="thumb emoji">{emoji}</span>
                <span class="mname">{name}</span>
                <Show when={current() === id}><span class="badge">使用中</span></Show>
              </div>
            )}
          </For>
          <For each={runners()}>
            {(r) => (
              <div class="mitem" classList={{ active: r.id === selected(), using: current() === `custom:${r.id}` }} onClick={() => pick(r.id)}>
                <span class="thumb">
                  <Show when={r.frames[0]} fallback="?"><img src={r.frames[0]} draggable={false} /></Show>
                </span>
                <span class="mname">{r.name || "（未命名）"}</span>
                <Show when={current() === `custom:${r.id}`}><span class="badge">使用中</span></Show>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="right">
        <Show
          when={editing()}
          fallback={
            <div class="empty">
              <div class="empty-ico">🐾</div>
              点击“新增”创建自定义角色。<br />内置角色点击即可切换。
            </div>
          }
        >
          {(r) => (
            <Show when={r().id} keyed>
              <div class="form">
                <label>名称
                  <input value={r().name} onChange={(e) => patch({ name: e.currentTarget.value.trim() || "新角色" })} />
                </label>
                <div class="runner-top">
                  <FramePreview frames={r().frames} />
                  <input ref={fileInput} type="file" accept="image/*" multiple hidden
                    onChange={(e) => addFrames(e.currentTarget.files)} />
                  <div
                    class="dropzone"
                    classList={{ over: dragOver() }}
                    role="button"
                    tabIndex={0}
                    onClick={() => fileInput.click()}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      addFrames(e.dataTransfer?.files);
                    }}
                  >
                    <span class="dz-ico">⇪</span>
                    <span>点击或拖入图片添加帧</span>
                    <span class="dz-sub">{r().frames.length} / {MAX_FRAMES} 帧</span>
                  </div>
                </div>
                <Show when={r().frames.length}>
                  <div class="frames-head">
                    <span>帧序列</span>
                    <button class="link" onClick={() => patch({ frames: [] })}>清空帧</button>
                  </div>
                </Show>
                <div class="frames">
                  <For each={r().frames}>
                    {(f, i) => (
                      <div class="frame" style={{ "animation-delay": `${Math.min(i(), 12) * 25}ms` }}>
                        <img src={f} draggable={false} />
                        <span class="frame-no">{i() + 1}</span>
                        <button class="frame-del" title="移除此帧" onClick={() => removeFrame(i())}>×</button>
                      </div>
                    )}
                  </For>
                </div>
                <div class="help">
                  选择多张图片（PNG / JPG / SVG / WebP）作为动画帧，按文件名顺序循环播放，速度随 CPU 占用变化；
                  也可只选一张 GIF，保留其自带动画。建议使用透明背景的方形图片，最多 {MAX_FRAMES} 帧。
                </div>
                <Show when={msg()} keyed><div class="status warn msg-in">{msg()}</div></Show>
                <div class="btnrow">
                  <button
                    class="primary use-btn"
                    classList={{ using: current() === `custom:${r().id}` }}
                    disabled={!r().frames.length}
                    onClick={() => use(`custom:${r().id}`)}
                  >
                    {current() === `custom:${r().id}` ? "✓ 使用中" : "使用此角色"}
                  </button>
                  <button class="danger-btn" classList={{ confirm: confirmDel() }} onClick={removeRunner}>
                    {confirmDel() ? "确认删除" : "删除"}
                  </button>
                </div>
              </div>
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}
