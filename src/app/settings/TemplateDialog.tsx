import { For } from "solid-js";
import { Modal } from "../components/Modal";
import { TEMPLATES, type ModuleTemplate } from "./templates";

const GROUPS: ModuleTemplate["group"][] = ["硬件", "网络", "系统"];

/** 模板库：点一张卡片就把对应的模块添加到列表里，不需要写命令 */
export function TemplateDialog(props: { onPick: (t: ModuleTemplate) => void; onClose: () => void }) {
  return (
    <Modal title="模板库" wide onClose={props.onClose}>
      <p class="modal-lead">
        点一下即可添加。添加后可以继续修改（比如换一台 Ping 的主机），点击“保存并生效”后才会出现在面板里。
      </p>
      <For each={GROUPS}>
        {(group) => (
          <section class="tpl-group">
            <h4>{group}</h4>
            <div class="tpl-grid">
              <For each={TEMPLATES.filter((t) => t.group === group)}>
                {(t) => (
                  <button type="button" class="tpl-card" onClick={() => props.onPick(t)}>
                    <span class="tpl-icon">{t.icon}</span>
                    <span class="tpl-main">
                      <span class="tpl-name">{t.name}</span>
                      <span class="tpl-desc">{t.desc}</span>
                      <span class="tpl-tags">
                        <For each={t.tags}>{(tag) => <span class="tpl-tag">{tag}</span>}</For>
                      </span>
                    </span>
                    <span class="tpl-add" aria-hidden="true">＋</span>
                  </button>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </Modal>
  );
}
