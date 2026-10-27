import { render } from "solid-js/web";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./app/styles.css";

const label = getCurrentWindow().label;
const root = document.getElementById("root")!;

if (label === "settings") {
  // 在模块加载前同步设置背景，避免首帧闪白
  document.documentElement.classList.add("settings-page");
  import("./app/settings/Settings").then((m) => render(() => m.Settings(), root));
} else if (label === "update-toast") {
  document.documentElement.classList.add("toast-page");
  import("./app/update/Toast").then((m) => render(() => m.Toast(), root));
} else if (label === "panel") {
  import("./app/widget/PanelWindow").then((m) => render(() => m.PanelWindow(), root));
} else {
  import("./app/widget/Widget").then((m) => render(() => m.Widget(), root));
}
