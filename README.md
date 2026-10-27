<p align="center"><img src="assets/logo.png" width="128" alt="Cinder" /></p>

# Cinder

一个常驻桌面的 Windows 悬浮监控小组件：屏幕上一团会动的篝火，动画速度随 CPU 占用变化；点击展开面板，查看 CPU、内存、磁盘、网络、电池，以及你自己定义的任意监控项。

## 特性

- **悬浮篝火**：64×64 无边框透明窗口，置顶、不抢焦点、不占任务栏；CPU 越忙，火烧得越快。
- **系统指标**：CPU、内存、磁盘、网络上下行、电池，点击篝火即可展开。
- **自定义监控模块**：任意命令（PowerShell / pwsh / cmd / 可执行文件）的输出都能变成面板里的一行，支持文本、进度条、趋势折线三种样式。
- **自定义角色**：用你自己的图片帧（PNG / JPG / SVG / WebP / GIF）替换篝火。
- **自动更新**：后台静默下载新版本，下载完成后弹出气泡，由你决定立即重启更新还是下次再说；也可以切换为手动更新。
- 低占用：面板收起时降低采样频率。

## 截图

<p align="center">
  <img src="assets/screenshots/panel.png" width="264" alt="监控面板" />
</p>

<p align="center">
  <img src="assets/screenshots/settings.png" width="560" alt="监控模块设置" />
  <img src="assets/screenshots/about.png" width="560" alt="关于与更新" />
</p>

## 安装

### 方式一：下载安装包（推荐）

1. 打开 [Releases](https://github.com/mick0960/Cinder/releases/latest) 页面。
2. 下载 `*-setup.exe` 并运行。
3. 安装后启动，屏幕上会出现一团篝火。

系统要求：Windows 10 / 11（需要 WebView2 运行时，Windows 11 和较新的 Windows 10 已自带）。

### 方式二：从源码构建

需要 [Node.js](https://nodejs.org/) 20+、[Rust](https://www.rust-lang.org/tools/install) stable，以及 [Tauri 的 Windows 前置依赖](https://tauri.app/start/prerequisites/)。

```bash
npm install
npm run tauri dev      # 开发运行
npm run tauri build    # 打包，安装包位于 src-tauri/target/release/bundle/nsis/
```

> 本地 `tauri build` 会生成更新包，需要先设置签名私钥环境变量 `TAURI_SIGNING_PRIVATE_KEY`；只想编译可执行文件时用 `npm run tauri build -- --no-bundle`。

## 使用

| 操作 | 效果 |
| --- | --- |
| 单击篝火 | 展开 / 收起监控面板 |
| 拖动篝火 | 移动位置（会记住） |
| 右键篝火 | 菜单：置顶、切换角色、设置、退出 |

靠近屏幕右 / 下边缘时，面板会自动向左 / 向上展开。

## 自定义监控配置

右键篝火 → **设置…** → **监控模块**，点击“新增”添加模块，“测试运行”可以立即看到命令的输出与耗时，保存后立刻生效，无需重启。

### 字段说明

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| 名称 | 面板里显示的标签 | — |
| 命令 | 要执行的命令，输出（stdout）即为显示内容 | — |
| 展示样式 | `文本` / `进度条` / `趋势折线` | 文本 |
| Shell | `Windows PowerShell`、`PowerShell 7 (pwsh)`、`cmd`、`直接运行程序` | PowerShell |
| 输出格式 | `纯文本` 或 `JSON` | 纯文本 |
| 刷新间隔 | 毫秒，最小 500 | 5000 |
| 超时 | 毫秒，命令超时会被终止 | 3000 |
| 单位 | 可选，自动追加在文本后，如 `°C`、`ms` | — |
| 颜色 | 可选，文本 / 进度条 / 折线的颜色 | 默认 |

> 选“直接运行程序”时，命令按空格拆分为程序和参数，不经过 shell。

### 输出格式

**纯文本**：命令的输出原样显示。样式为“进度条”或“趋势折线”时，输出需要能解析为数值，支持以下写法：

- `73` 或 `73%` → 73%
- `3/4` → 75%

**JSON**：输出一行 JSON，可以动态控制文本、数值和颜色：

```json
{ "text": "73%", "value": 0.73, "color": "#ff5d5d" }
```

- `text`：显示的文字
- `value`：0 ~ 1 之间的数值，用于进度条 / 折线
- `color`：可选，覆盖模块配置的颜色

### 示例

**GPU 占用（进度条，NVIDIA）**

- Shell：Windows PowerShell，样式：进度条
- 命令：

```powershell
nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits
```

**网络延迟（文本，单位 ms）**

```powershell
(Test-Connection -Count 1 -ComputerName baidu.com).ResponseTime
```

**CPU 温度风格的动态颜色（JSON）**

输出格式选 JSON，样式选进度条：

```powershell
$v = Get-Random -Maximum 100
@{ text = "$v%"; value = $v / 100; color = $(if ($v -gt 80) { '#ff5d5d' } else { '#4cd97b' }) } | ConvertTo-Json -Compress
```

**某个进程是否在运行（文本）**

```powershell
if (Get-Process -Name Code -ErrorAction SilentlyContinue) { '运行中' } else { '未运行' }
```

### 小提示

- 命令应该尽快返回；耗时长的命令请调大“超时”和“刷新间隔”。
- 命令出错或超时时，面板里该行显示 `—`，鼠标悬停可查看错误信息。
- 配置文件保存在 `%APPDATA%\com.cinder.app\config.json`，也可以直接编辑（修改前请先退出程序）。

## 自定义角色

设置 → **角色 / Runner** → “新增”，拖入或选择多张图片作为动画帧（按文件名顺序循环播放，如 `1.png`、`2.png`…），也可以只选一张 GIF。建议使用透明背景的方形图片，最多 24 帧。点击“使用此角色”即可切换；内置的篝火始终可用。

## 更新

- 默认**自动更新**：发现新版本后在后台静默下载，下载完成后在屏幕右下角弹出气泡，可选择“立即重启更新”或“下次再说”。
- 在 设置 → **关于** 可切换为**手动更新**（仅提示，由你决定是否下载），也可以随时点击“检查更新”。
- 选择“下次再说”的版本不会再次打扰你，更新的版本发布后会再次提示。

## 技术栈

[Tauri 2](https://tauri.app/)（Rust）+ [SolidJS](https://www.solidjs.com/) + Vite。

## 许可

[MIT](LICENSE)：可自由用于个人和商业用途，可修改、分发、再发布，只需保留版权与许可声明。
