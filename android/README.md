# Cinder Android

Cinder 的 Android 版：桌面小部件 + 系统状态监控 + 可导入的自定义监控模块。原生 Kotlin 实现，没有 WebView，息屏时不占 CPU。

## 功能

- **桌面小部件**
  - 篝火概览（2×2）：篝火动画 + CPU、内存、电量、网速
  - 系统监控（4×2，可缩放）：CPU 走势、内存、存储、电池功率与温度、网络；缩小到 2×2 时自动换成概览
  - 自定义模块（4×2 起）：列出已启用的模块，多行输出按分组显示，带刷新按钮
- **状态监控**
  - CPU：默认按频率估算负载；授权 Shizuku 后显示真实占用率、每核占用和温度
  - 内存、存储
  - 电池：电量、充放电功率、温度、充满剩余时间
  - 网络：上下行速率和网络类型
- **自定义模块**：JS 脚本、HTTP 请求、Shell 命令三种写法，输出格式与桌面版相同。可以从文件、剪贴板、链接、其他 App 分享导入，也可以从内置模板开始。
- **两种刷新方式**
  - 实时模式（默认）：亮屏时每 N 秒刷新（默认 3 秒），息屏立即暂停；需要一条常驻通知
  - 省电模式：没有常驻通知，系统大约每 15 分钟刷新一次，点刷新按钮可立即刷新

系统要求：Android 12 及以上，arm64 设备。

## 安装

在 [Releases](https://github.com/mick0960/Cinder/releases) 里找 `android-v*` 开头的版本，下载 `Cinder-v*.apk` 安装。

### 在 HyperOS 上添加小部件

HyperOS 的小部件中心只收录经小米审核、从小米应用商店上架的小部件；Cinder 的小部件按小米小部件规范声明（这样才能放进负一屏），因此也不会出现在"安卓小部件"列表里。添加方式：

1. 打开 Cinder → **小部件** 页，点 **添加到桌面**；
2. 想放进负一屏：长按桌面上的小部件，拖到屏幕最左边松手（负一屏支持 2×2、4×2 尺寸）。

点"添加到桌面"没有反应时，到 Cinder 的权限设置里允许 **桌面快捷方式**。

## 从源码构建

需要 JDK 17+ 和 Android SDK（platform 37、build-tools）。

```bash
cd android
./gradlew :app:assembleDebug        # 输出 app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest    # 单元测试（QuickJS 脚本在桌面 JVM 上运行）
```

发布构建需要签名：设置环境变量 `CINDER_KEYSTORE`、`CINDER_KEYSTORE_PASSWORD`、`CINDER_KEY_ALIAS`、`CINDER_KEY_PASSWORD` 后运行 `./gradlew :app:assembleRelease`。没有这些变量时，release 包使用 debug 签名，只适合本机测试。

CI 发布：推送 `android-v1.2.3` 形式的 tag，`android-release.yml` 会编译签名 APK 并发布 Release（需要配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 四个 secrets）。Android 的 Release 不会被标记为 latest，以免影响桌面版的自动更新。

## 自定义模块

### 模块包

模块包是一个 JSON 文件：可以是单个模块对象，也可以是 `{"cinderModule": 1, "modules": [...]}` 或数组。公共字段与桌面版 `config.json` 里的模块同名、默认值相同：

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `name` | 显示名称 | — |
| `type` | `script` / `http` / `command` | 按字段推断 |
| `style` | `text` / `progress` / `sparkline` | `text` |
| `format` | `plain` / `json` | `plain` |
| `intervalMs` | 刷新间隔，最小 1000 | 5000 |
| `timeoutMs` | 超时，500–60000 | 3000 |
| `unit`、`color` | 单位、颜色 | — |
| `params` | 导入时让用户填写的参数：`{key, label, type: string\|url\|number, secret, required, default}` | — |
| `hosts` | 允许访问的域名，支持 `*.example.com` | — |
| `description`、`author`、`version` | 说明信息 | — |

桌面版的 PowerShell / cmd 模块无法在手机上运行，导入时会提示改写。

### 输出格式（与桌面版相同）

- **纯文本**：输出原样显示；进度条 / 折线样式需要能解析成数值：`73`、`73%`、`3/4`。
- **JSON**：`{"text": "73%", "value": 0.73, "color": "#ff5d5d", "items": [...]}`。`items` 里每条是 `{group, label, text, value, color}`，相邻条目 `group` 相同时只显示一次分组标题。

### 写法一：JS 脚本（`type: "script"`）

```json
{
  "cinderModule": 1,
  "name": "接口余额",
  "type": "script",
  "style": "progress",
  "intervalMs": 300000,
  "timeoutMs": 10000,
  "params": [{ "key": "token", "label": "Token", "secret": true, "required": true }],
  "hosts": ["api.example.com"],
  "script": "export default async function (ctx) {\n  const r = await ctx.http.request({ url: 'https://api.example.com/quota', headers: { Authorization: 'Bearer ' + ctx.params.token } });\n  const q = r.json();\n  return { text: q.used + ' / ' + q.total, value: q.used / q.total };\n}"
}
```

可用的 API：

- `ctx.params`：参数值
- `ctx.http.request({ url, method, headers, body, timeoutMs })`：返回 `{ status, ok, headers, body, text, json() }`。`body` 可以是字符串或对象，对象会转成 JSON。响应体上限 1 MB。
- `ctx.http.get(url, headers)`
- `ctx.store.get(key)` / `ctx.store.set(key, value)`：每个模块一份小型持久存储，可以跨次运行保存状态，比如用来算速率
- `ctx.log(...)` / `console.log(...)`：输出只在"测试运行"时显示

脚本返回对象（按 JSON 处理）或字符串（按 `format` 处理）。没有 `export default` 时，整段代码当作 async 函数体，可以直接 `return`。

运行环境是 QuickJS 沙箱，没有文件和进程访问权限，只能请求白名单里的域名：`hosts`，加上 `type: "url"` 参数里的域名。

### 写法二：HTTP 请求（`type: "http"`）

不用写代码，声明请求就行。没有 `map` 时，响应体就是输出，相当于命令的 stdout；有 `map` 时，用 JS 表达式从响应里取值：

```json
{
  "cinderModule": 1,
  "name": "Clash 订阅流量",
  "type": "http",
  "style": "progress",
  "intervalMs": 600000,
  "params": [{ "key": "url", "label": "订阅链接", "type": "url", "secret": true, "required": true }],
  "request": { "method": "HEAD", "url": "${params.url}", "headers": { "User-Agent": "clash-verge/v2.0.0" } },
  "map": {
    "vars": "const u = kv(need(headers['subscription-userinfo'], '响应头缺少 Subscription-Userinfo')); const r = (u.upload + u.download) / u.total;",
    "text": "pct(r, 1)",
    "value": "r",
    "color": "r >= 0.9 ? '#ff5c5c' : '#4cd48a'"
  }
}
```

- 请求的 `url`、`headers`、`body` 里可以写 `${params.key}`。
- 表达式里可用：`json`（解析后的响应体，不是 JSON 时为 null）、`body`、`headers`（头名小写）、`status`、`params`。
- 辅助函数：`kv(s)`（解析 `a=1; b=2`）、`need(v, 提示)`（缺值时报错）、`fmtBytes(n)`、`pct(r, 位数)`。
- `vars` 是可选的，在表达式之前执行，用来定义中间变量。
- 请求地址里直接写明的域名会被自动允许。

### 写法三：Shell 命令（`type: "command"`）

```json
{ "cinderModule": 1, "name": "网络延迟", "type": "command", "shell": "sh", "unit": " ms",
  "params": [{ "key": "host", "label": "主机", "default": "baidu.com" }],
  "command": "ping -c 1 -W 2 \"$CINDER_PARAM_HOST\" | sed -n 's/.*time=\\([0-9.]*\\).*/\\1/p'" }
```

- 用 `/system/bin/sh -c` 执行，stdout 即输出。
- 参数以环境变量 `CINDER_PARAM_<KEY>` 传入，也可以写 `${params.key}`。
- `shell: "sh"` 以应用身份运行；`shell: "shizuku"` 经 Shizuku 以 shell 身份运行（可以用 `dumpsys` 等）。`shizuku` 类型的模块导入后默认停用，确认命令可信后再手动启用。
- 超时时会结束整棵子进程树。

### 导入与分享

- **模块页 → 导入**：可选文件、剪贴板、https 链接、内置模板。
- **其他 App 打开 / 分享**：在其他 App 里打开 `.json` 文件，或把模块包分享给 Cinder。
- **链接导入**：`cinder://import?url=https://…/module.json`。

导入前会预览代码或命令、要访问的域名和参数。导出（分享、复制）只包含模块定义，不包含你填写的参数值。

### 内置模板

| 模板 | 写法 | 说明 |
| --- | --- | --- |
| Clash 订阅流量 | HTTP | 移植自桌面版 `scripts/clash-traffic.ps1` |
| sub2api 账号用量 | 脚本 | 移植自桌面版 `scripts/sub2api-usage.ps1`，按账号分组的多行输出 |
| 公网 IP | HTTP | — |
| 网络延迟 | 命令 | — |
| 前台应用 | 命令（Shizuku） | — |

模板源文件在 `app/src/main/assets/templates/`。

## Shizuku

普通应用从 Android 8 起读不到 `/proc/stat`，所以默认的 CPU 数值是按频率估算的负载。安装 [Shizuku](https://shizuku.rikka.app/download/) 并授权后：

- 显示真实 CPU 占用率、每核占用率、CPU 和机身温度；
- 可以运行 `shell: "shizuku"` 的命令模块。

只有在需要时（实时模式亮屏、App 打开、运行 Shizuku 模块）才会启动 shell 身份的辅助进程，用完即退出。没有 root 的手机每次重启后都需要在 Shizuku 里重新启动它。

## HyperOS / MIUI 后台运行

HyperOS 会清理后台应用。为了让小部件持续刷新，请在 **设置 → 后台运行（HyperOS）** 里依次完成：

1. 忽略电池优化；
2. 把省电策略设为"无限制"；
3. 允许自启动；
4. 在多任务界面锁定 Cinder。

## 低占用设计

- 原生 RemoteViews 小部件，没有 WebView。小部件内容没变化时不推送。
- 走势图画成 ALPHA_8 位图（约 14 KB），颜色由 ImageView 的滤镜决定。
- 采样按需进行：只在界面打开（每秒）或实时模式亮屏（按设定间隔）时采样，没有需求时采样循环直接退出。
- 息屏后停止所有采样和模块执行，不持唤醒锁、不设闹钟。
- 模块每次运行新建 QuickJS 运行时，跑完即释放；同时最多运行 2 个模块；连续失败 3 次后间隔 ×4。
- 省电模式用系统 JobScheduler，不引入 WorkManager。
