package com.cinder.mobile.ui

import android.Manifest
import android.appwidget.AppWidgetManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.TrafficStats
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cinder.mobile.AppGraph
import com.cinder.mobile.BuildConfig
import com.cinder.mobile.core.SysFs
import com.cinder.mobile.service.MonitorService
import com.cinder.mobile.shizuku.ShizukuManager
import com.cinder.mobile.widget.ModulesWidget
import com.cinder.mobile.widget.SummaryWidget
import com.cinder.mobile.widget.SystemWidget
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/* ---------- 小部件 ---------- */

private data class WidgetKind(val provider: Class<out android.appwidget.AppWidgetProvider>, val name: String, val size: String, val desc: String)

private val WIDGETS = listOf(
    WidgetKind(SummaryWidget::class.java, "篝火概览", "2×2", "篝火 + CPU、内存、电量、网速"),
    WidgetKind(SystemWidget::class.java, "系统监控", "4×2", "CPU 走势、内存、存储、电池功率与网络；缩小到 2×2 时自动换成概览"),
    WidgetKind(ModulesWidget::class.java, "自定义模块", "4×2 起", "列出已启用的模块，多行输出按分组显示，可手动刷新"),
)

@Composable
fun WidgetsScreen(graph: AppGraph, ui: UiState) {
    val context = LocalContext.current
    val settings by graph.settings.state.collectAsStateWithLifecycle()
    var counts by remember { mutableStateOf(WIDGETS.map { 0 }) }
    LifecycleResumeEffect(Unit) {
        counts = WIDGETS.map { graph.renderer.ids(it.provider).size }
        onPauseOrDispose {}
    }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("桌面小部件", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        Text(
            if (settings.realtime) "实时模式：亮屏时每 ${settings.intervalSec} 秒刷新，息屏自动暂停。"
            else "省电模式：大约每 15 分钟刷新一次，点模块小部件上的刷新按钮可立即刷新。",
            color = Colors.Label,
            fontSize = 13.sp,
        )
        WIDGETS.forEachIndexed { i, w ->
            PanelCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(w.name, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                    Pill(w.size)
                }
                Text(w.desc, Modifier.padding(top = 4.dp), color = Colors.Label, fontSize = 13.sp)
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (counts[i] > 0) "已添加 ${counts[i]} 个" else "未添加", Modifier.weight(1f), color = Colors.Sub, fontSize = 12.sp)
                    FilledTonalButton(onClick = {
                        val manager = AppWidgetManager.getInstance(context)
                        val ok = manager.isRequestPinAppWidgetSupported &&
                            manager.requestPinAppWidget(ComponentName(context, w.provider), null, null)
                        if (!ok) Toast.makeText(context, "当前桌面不支持一键添加，请长按桌面空白处 → 添加小部件", Toast.LENGTH_LONG).show()
                    }) { Text("添加到桌面") }
                }
            }
        }
        PanelCard {
            Text("HyperOS 与负一屏", fontWeight = FontWeight.SemiBold)
            Text(
                "HyperOS 的小部件中心只收录小米审核上架的小部件，Cinder 的小部件请用上面的\"添加到桌面\"。" +
                    "添加后长按小部件拖到屏幕最左边，即可放进负一屏（2×2、4×2 尺寸）。" +
                    "点了没反应：在 Cinder 的权限设置里允许\"桌面快捷方式\"。",
                Modifier.padding(top = 4.dp),
                color = Colors.Label,
                fontSize = 13.sp,
            )
            TextButton(onClick = { open(context, miuiPermissions(context)) }, contentPadding = PaddingValues(0.dp)) { Text("权限设置") }
        }
        PanelCard {
            Text("手动添加", fontWeight = FontWeight.SemiBold)
            Text(
                "其他系统：长按桌面空白处 → 小部件 → Cinder。" +
                    "小部件需要后台运行权限才能持续刷新，请在\"设置 → 后台运行\"里放行。",
                Modifier.padding(top = 4.dp),
                color = Colors.Label,
                fontSize = 13.sp,
            )
            TextButton(onClick = { ui.tab = 3 }, contentPadding = PaddingValues(0.dp)) { Text("去设置") }
        }
    }
}

/* ---------- 设置 ---------- */

@Composable
fun SettingsScreen(graph: AppGraph, ui: UiState) {
    val context = LocalContext.current
    val settings by graph.settings.state.collectAsStateWithLifecycle()
    val shizuku by graph.shizuku.state.collectAsStateWithLifecycle()
    var interval by remember(settings.intervalSec) { mutableFloatStateOf(settings.intervalSec.toFloat()) }
    var notifGranted by remember { mutableStateOf(notificationsGranted(context)) }
    var batteryExempt by remember { mutableStateOf(batteryExempt(context)) }
    val notifLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { notifGranted = it }
    LifecycleResumeEffect(Unit) {
        notifGranted = notificationsGranted(context)
        batteryExempt = batteryExempt(context)
        graph.shizuku.refresh()
        onPauseOrDispose {}
    }

    fun update(block: (com.cinder.mobile.settings.AppSettings) -> com.cinder.mobile.settings.AppSettings) {
        graph.settings.update(block)
        MonitorService.sync(context)
    }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("设置", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)

        PanelCard {
            SectionTitle("刷新方式")
            ModeOption("实时模式", "亮屏时按设定间隔刷新小部件，息屏后完全暂停；需要一条常驻通知", settings.realtime) {
                update { it.copy(realtime = true) }
            }
            ModeOption("省电模式", "没有常驻通知，系统约每 15 分钟刷新一次；CPU、网速等实时数据参考意义不大", !settings.realtime) {
                update { it.copy(realtime = false) }
            }
            if (settings.realtime) {
                Text("刷新间隔：${interval.toInt()} 秒", Modifier.padding(top = 8.dp), fontSize = 14.sp)
                Slider(
                    value = interval,
                    onValueChange = { interval = it },
                    onValueChangeFinished = { update { s -> s.copy(intervalSec = interval.toInt()) } },
                    valueRange = 1f..60f,
                    steps = 58,
                )
                ToggleRow("通知显示实时摘要", settings.liveNotification, "CPU、内存、网速，最多每 10 秒更新一次") {
                    update { s -> s.copy(liveNotification = it) }
                }
            }
            ToggleRow("小部件篝火动画", settings.bonfireAnimation, "关闭后每次刷新换一帧，桌面开销更低") {
                update { s -> s.copy(bonfireAnimation = it) }
            }
        }

        PanelCard {
            SectionTitle("Shizuku 增强")
            Text(
                "普通应用读不到真实 CPU 占用率（Android 8 起限制了 /proc/stat），默认按 CPU 频率估算。" +
                    "授权 Shizuku 后可显示真实占用、每核占用和温度，并支持以 shell 身份运行的命令模块。",
                color = Colors.Label,
                fontSize = 13.sp,
            )
            val uid = graph.shizuku.uid
            Text(
                "状态：" + when (shizuku) {
                    ShizukuManager.State.NOT_INSTALLED -> "未安装 Shizuku"
                    ShizukuManager.State.NOT_RUNNING -> "Shizuku 未运行（重启手机后需要重新启动）"
                    ShizukuManager.State.UNSUPPORTED -> "Shizuku 版本过旧"
                    ShizukuManager.State.DENIED -> "未授权"
                    ShizukuManager.State.READY -> "已连接（${if (uid == 0) "root" else "shell"}）"
                },
                Modifier.padding(top = 6.dp),
                color = if (shizuku == ShizukuManager.State.READY) Colors.Good else Colors.Warn,
                fontSize = 13.sp,
            )
            Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (shizuku) {
                    ShizukuManager.State.NOT_INSTALLED -> OutlinedButton(onClick = {
                        open(context, Intent(Intent.ACTION_VIEW, Uri.parse("https://shizuku.rikka.app/download/")))
                    }) { Text("获取 Shizuku") }
                    ShizukuManager.State.NOT_RUNNING, ShizukuManager.State.UNSUPPORTED -> OutlinedButton(onClick = {
                        context.packageManager.getLaunchIntentForPackage(ShizukuManager.SHIZUKU_PACKAGE)?.let { open(context, it) }
                    }) { Text("打开 Shizuku") }
                    ShizukuManager.State.DENIED -> FilledTonalButton(onClick = { graph.shizuku.requestPermission() }) { Text("授权") }
                    ShizukuManager.State.READY -> {}
                }
            }
            ToggleRow("使用 Shizuku", settings.useShizuku) {
                update { s -> s.copy(useShizuku = it) }
                graph.shizuku.refresh()
            }
        }

        PanelCard {
            SectionTitle("后台运行（HyperOS）")
            Text(
                "HyperOS 会清理后台应用。为了让小部件持续刷新，请允许自启动、把省电策略设为\"无限制\"，并在多任务界面锁定 Cinder。",
                color = Colors.Label,
                fontSize = 13.sp,
            )
            Text(
                if (batteryExempt) "电池优化：已忽略" else "电池优化：未忽略",
                Modifier.padding(top = 6.dp),
                color = if (batteryExempt) Colors.Good else Colors.Warn,
                fontSize = 13.sp,
            )
            Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = {
                    open(context, Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")))
                }) { Text("忽略电池优化") }
                OutlinedButton(onClick = {
                    open(
                        context,
                        Intent("miui.intent.action.HIDDEN_APPS_CONFIG_ACTIVITY")
                            .putExtra("package_name", context.packageName)
                            .putExtra("package_label", "Cinder"),
                    )
                }) { Text("省电策略") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = {
                    open(context, Intent().setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"))
                }) { Text("自启动管理") }
                OutlinedButton(onClick = { open(context, appDetails(context)) }) { Text("应用详情") }
            }
            if (Build.VERSION.SDK_INT >= 33) {
                Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (notifGranted) "通知权限：已允许" else "通知权限：未允许（常驻通知不显示）", Modifier.weight(1f), color = Colors.Label, fontSize = 13.sp)
                    if (!notifGranted) TextButton(onClick = { notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("允许") }
                }
            }
        }

        PanelCard {
            SectionTitle("关于")
            Text("Cinder Android ${BuildConfig.VERSION_NAME}", fontSize = 14.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { ui.diagnostics = true }, contentPadding = PaddingValues(0.dp)) { Text("数据源诊断") }
                TextButton(onClick = { open(context, Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/mick0960/Cinder"))) }) { Text("GitHub") }
            }
        }
    }
}

@Composable
private fun ModeOption(title: String, desc: String, selected: Boolean, onClick: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = selected, onClick = onClick)
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp)
            Text(desc, color = Colors.Sub, fontSize = 12.sp)
        }
    }
}

private fun notificationsGranted(context: Context) = Build.VERSION.SDK_INT < 33 ||
    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

private fun batteryExempt(context: Context) =
    context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

private fun appDetails(context: Context) =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))

/** 小米安全中心的应用权限页（"桌面快捷方式"开关在这里，关着时桌面会静默拒绝一键添加小部件） */
private fun miuiPermissions(context: Context) =
    Intent("miui.intent.action.APP_PERM_EDITOR")
        .setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity")
        .putExtra("extra_pkgname", context.packageName)

/** 厂商设置页的入口各版本不同，打不开时退回应用详情页 */
private fun open(context: Context, intent: Intent) {
    try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        context.startActivity(appDetails(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: SecurityException) {
        context.startActivity(appDetails(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

/* ---------- 诊断 ---------- */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiagnosticsScreen(graph: AppGraph, onClose: () -> Unit) {
    val context = LocalContext.current
    var rows by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    var round by remember { mutableIntStateOf(0) }
    BackHandler(onBack = onClose)
    LaunchedEffect(round) { rows = withContext(Dispatchers.IO) { diagnose(context, graph) } }
    Scaffold(
        containerColor = Colors.Background,
        topBar = {
            TopAppBar(
                title = { Text("数据源诊断") },
                navigationIcon = { TextButton(onClick = onClose) { Text("返回") } },
                actions = {
                    TextButton(onClick = { round++ }) { Text("重测") }
                    TextButton(onClick = {
                        val text = rows.joinToString("\n") { "${it.first}: ${it.second}" }
                        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Cinder 诊断", text))
                        Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
                    }) { Text("复制") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Colors.Background),
            )
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(rows) { (name, value) ->
                PanelCard {
                    Text(name, color = Colors.Label, fontSize = 12.sp)
                    Text(value, style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp))
                }
            }
        }
    }
}

private fun diagnose(context: Context, graph: AppGraph): List<Pair<String, String>> {
    val rows = ArrayList<Pair<String, String>>()
    rows += "设备" to "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
    rows += "/proc/stat（应用权限）" to (SysFs.readText("/proc/stat", 256)?.lineSequence()?.firstOrNull() ?: "不可读")
    rows += "/proc/loadavg（应用权限）" to (SysFs.readText("/proc/loadavg", 128)?.trim() ?: "不可读")
    val freq = graph.sampler.freqCpu
    rows += "CPU 频率节点" to if (freq.available) "可读：${freq.clusterCount} 个簇 / ${freq.coreCount} 核，当前负载 ${freq.sample()?.usage?.let { "%.2f".format(it) }}" else "不可读"
    val zones = File("/sys/class/thermal").list()?.filter { it.startsWith("thermal_zone") }.orEmpty()
    val readable = zones.count { SysFs.readText("/sys/class/thermal/$it/temp", 32) != null }
    rows += "温度节点（应用权限）" to if (zones.isEmpty()) "目录不可读" else "$readable / ${zones.size} 可读"
    rows += "TrafficStats 总流量" to "↓ ${TrafficStats.getTotalRxBytes()} B  ↑ ${TrafficStats.getTotalTxBytes()} B"
    val bm = context.getSystemService(BatteryManager::class.java)
    rows += "电池电流（原始值）" to "${bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)}"
    val pm = context.getSystemService(PowerManager::class.java)
    rows += "散热状态 / 余量" to "${pm.currentThermalStatus} / ${pm.getThermalHeadroom(10)}"
    rows += "Shizuku" to "${graph.shizuku.state.value}，uid=${graph.shizuku.uid}"
    val priv = graph.shizuku.service.value
    if (priv != null) {
        rows += "/proc/stat（Shizuku）" to try {
            priv.readFiles(arrayOf("/proc/stat"))?.firstOrNull()?.lineSequence()?.firstOrNull() ?: "不可读"
        } catch (e: Exception) {
            "失败：${e.message}"
        }
    }
    val snap = graph.metrics.snapshot.value
    rows += "最近快照" to (snap?.let { "CPU ${it.cpu} (${it.cpuKind}) · 温度 ${it.cpuTempC} / ${it.skinTempC} · 网络 ${it.netType}" } ?: "无")
    rows += "小部件" to "${graph.renderer.count()} 个，实时服务${if (MonitorService.running) "运行中" else "未运行"}"
    rows += "模块" to "${graph.modules.modules.value.size} 个"
    rows += "版本" to "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"
    return rows
}
