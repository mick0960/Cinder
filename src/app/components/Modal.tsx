import { onCleanup, onMount, type JSX } from "solid-js";

/** 设置页里的模态对话框：Esc 或点击遮罩关闭 */
export function Modal(props: { title: string; onClose: () => void; wide?: boolean; children: JSX.Element }) {
  onMount(() => {
    // 捕获阶段拦截：对话框打开时 Esc 只关对话框
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  // 从对话框里拖选文字、松手在遮罩上时不应关闭：按下和松开都落在遮罩上才算
  let pressedOnBackdrop = false;
  return (
    <div
      class="modal-backdrop"
      onMouseDown={(e) => (pressedOnBackdrop = e.target === e.currentTarget)}
      onClick={(e) => {
        if (pressedOnBackdrop && e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="modal" classList={{ wide: props.wide }} role="dialog" aria-modal="true" aria-label={props.title}>
        <div class="modal-head">
          <span>{props.title}</span>
          <button class="modal-x" type="button" title="关闭（Esc）" aria-label="关闭" onClick={props.onClose}>×</button>
        </div>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}
