package com.cinder.mobile.ui

import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cinder.mobile.AppGraph
import com.cinder.mobile.MainActivity
import com.cinder.mobile.core.Fmt
import com.cinder.mobile.core.Palette
import com.cinder.mobile.metrics.BatteryInfo
import com.cinder.mobile.metrics.CpuKind
import com.cinder.mobile.metrics.MetricHistory
import com.cinder.mobile.metrics.MetricsSnapshot
import com.cinder.mobile.modules.InstalledModule
import com.cinder.mobile.modules.ModuleDisplay
import com.cinder.mobile.modules.ModuleItem
import com.cinder.mobile.modules.ModuleOutput
import com.cinder.mobile.shizuku.ShizukuManager
import kotlin.math.roundToInt

@Composable
fun PanelScreen(graph: AppGraph, ui: UiState) {
    val snap by graph.metrics.snapshot.collectAsStateWithLifecycle()
    val history by graph.metrics.history.collectAsStateWithLifecycle()
    val modules by graph.modules.modules.collectAsStateWithLifecycle()
    val outputs by graph.scheduler.outputs.collectAsStateWithLifecycle()
    val moduleHistory by graph.scheduler.history.collectAsStateWithLifecycle()
    val shizuku by graph.shizuku.state.collectAsStateWithLifecycle()
    val enabled = modules.filter { it.enabled }

    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Header(snap) }
        item {
            CpuCard(snap, history, showShizukuHint = shizuku != ShizukuManager.State.READY) {
                ui.tab = MainActivity.TAB_SETTINGS
            }
        }
        item { MemoryCard(snap) }
        snap?.battery?.let { b -> item { BatteryCard(b) } }
        item { NetworkCard(snap, history) }
        item { StorageCard(snap) }
        if (enabled.isNotEmpty()) {
            item {
                PanelCard {
                    SectionTitle("自定义模块")
                    enabled.forEach { m ->
                        ModuleRow(m, outputs[m.id], moduleHistory[m.id]) { ui.editing = EditTarget.Existing(m.id) }
                    }
                }
            }
        }
    }
}

@Composable
private fun Header(snap: MetricsSnapshot?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Bonfire(snap?.cpu, size = 52.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("Cinder", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
            Text("${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}", color = Colors.Sub, fontSize = 12.sp)
        }
        val status = snap?.thermalStatus ?: 0
        if (status > 0) Pill(THERMAL[status.coerceIn(0, THERMAL.lastIndex)], if (status >= 3) Colors.Danger else Colors.Warn)
    }
}

private val THERMAL = listOf("正常", "微热", "较热", "过热", "严重过热", "紧急", "关机保护")

@Composable
private fun CpuCard(snap: MetricsSnapshot?, history: MetricHistory, showShizukuHint: Boolean, onShizuku: () -> Unit) {
    val cpu = snap?.cpu
    val color = Palette.usage(cpu ?: 0.0).toColor()
    PanelCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("CPU", color = Colors.Label, fontSize = 13.sp)
                val sub = buildList {
                    add(
                        when (snap?.cpuKind) {
                            CpuKind.PROC_STAT -> "真实占用"
                            CpuKind.FREQ -> "频率负载"
                            else -> "不可用"
                        }
                    )
                    snap?.cpuTempC?.let { add("${Fmt.one(it)}°C") }
                    snap?.skinTempC?.let { add("机身 ${Fmt.one(it)}°C") }
                }.joinToString(" · ")
                Text(sub, color = Colors.Sub, fontSize = 12.sp)
            }
            Text(cpu?.let { "${(it * 100).roundToInt()}" } ?: "—", color = color, fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
            Text("%", color = color, fontSize = 14.sp, modifier = Modifier.padding(start = 2.dp, top = 8.dp))
        }
        LiveChart(listOf(history.cpu to color), max = 1.0, modifier = Modifier.height(44.dp).padding(top = 6.dp))
        val cores = snap?.cores.orEmpty()
        if (cores.size > 1) {
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                cores.forEach { v -> Bar(v, Palette.usage(v).toColor(), Modifier.weight(1f), height = 4.dp) }
            }
        }
        if (snap?.cpuKind == CpuKind.FREQ && showShizukuHint) {
            TextButton(onClick = onShizuku, contentPadding = PaddingValues(0.dp)) {
                Text("显示真实占用率需要 Shizuku →", fontSize = 12.sp)
            }
        }
    }
}

private const val RAM_CELLS = 24

@Composable
private fun MemoryCard(snap: MetricsSnapshot?) {
    val ratio = snap?.memRatio ?: 0.0
    val color = Palette.usage(ratio).toColor()
    val lit = (ratio.coerceIn(0.0, 1.0) * RAM_CELLS).roundToInt()
    PanelCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("内存", Modifier.weight(1f), color = Colors.Label, fontSize = 13.sp)
            Text(snap?.let { "${Fmt.bytes(it.memUsed)} / ${Fmt.bytes(it.memTotal)}" } ?: "—", fontSize = 13.sp)
            Text(Fmt.percent(ratio), color = color, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 8.dp))
        }
        Row(Modifier.padding(top = 8.dp).height(10.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            repeat(RAM_CELLS) { i ->
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(2.dp))
                        .background(if (i < lit) color.copy(alpha = 0.55f + 0.45f * (i + 1) / RAM_CELLS) else Colors.Track),
                )
            }
        }
    }
}

@Composable
private fun BatteryCard(b: BatteryInfo) {
    val color = Palette.battery(b.level, b.charging).toColor()
    val sub = buildList {
        if (b.powerW != null && b.powerW >= 0.1) add((if (b.charging) "充电 " else "放电 ") + "${Fmt.one(b.powerW)} W")
        b.tempC?.let { add("${Fmt.one(it)}°C") }
        b.voltageMv?.let { add("${Fmt.one(it / 1000.0)} V") }
        b.chargeLeftMs?.let { add("充满约 ${Fmt.duration(it / 1000)}") }
    }.joinToString(" · ")
    PanelCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (b.charging) "电池 · 充电中" else "电池", Modifier.weight(1f), color = Colors.Label, fontSize = 13.sp)
            Text(sub, color = Colors.Sub, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .weight(1f)
                    .height(22.dp)
                    .border(1.5.dp, Color.White.copy(alpha = 0.28f), RoundedCornerShape(4.dp))
                    .padding(2.5.dp),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(b.level.coerceIn(0.0, 1.0).toFloat())
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(2.dp))
                        .background(color),
                )
                Text(
                    Fmt.percent(b.level),
                    Modifier.align(Alignment.Center),
                    fontSize = 11.sp,
                    lineHeight = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Box(
                Modifier
                    .padding(start = 2.dp)
                    .size(width = 3.dp, height = 7.dp)
                    .clip(RoundedCornerShape(topEnd = 2.dp, bottomEnd = 2.dp))
                    .background(Color.White.copy(alpha = 0.28f)),
            )
        }
    }
}

@Composable
private fun NetworkCard(snap: MetricsSnapshot?, history: MetricHistory) {
    val peak = maxOf(32.0 * 1024, (history.down + history.up).maxOrNull()?.toDouble() ?: 0.0) * 1.15
    PanelCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(listOfNotNull("网络", snap?.netType).joinToString(" · "), Modifier.weight(1f), color = Colors.Label, fontSize = 13.sp)
            Text("↓ ${snap?.let { Fmt.rate(it.netDown) } ?: "—"}", color = Colors.Ok, fontSize = 13.sp)
            Text("↑ ${snap?.let { Fmt.rate(it.netUp) } ?: "—"}", color = Colors.Up, fontSize = 13.sp, modifier = Modifier.padding(start = 10.dp))
        }
        LiveChart(
            listOf(history.down.map { it.toDouble() } to Colors.Ok, history.up.map { it.toDouble() } to Colors.Up),
            max = peak,
            mirror = true,
            modifier = Modifier.height(48.dp).padding(top = 6.dp),
        )
    }
}

@Composable
private fun StorageCard(snap: MetricsSnapshot?) {
    val ratio = snap?.storageRatio ?: 0.0
    val color = Palette.usage(ratio).toColor()
    PanelCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(contentAlignment = Alignment.Center) {
                Canvas(Modifier.size(44.dp)) {
                    val stroke = 4.dp.toPx()
                    val inset = stroke / 2
                    val arcSize = Size(size.width - stroke, size.height - stroke)
                    drawArc(Colors.Track, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(stroke))
                    drawArc(color, -90f, (360 * ratio).toFloat(), false, Offset(inset, inset), arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
                }
                Text("${(ratio * 100).roundToInt()}", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
            Column(Modifier.padding(start = 12.dp)) {
                Text("内部存储", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = Colors.Group)
                Text(
                    snap?.takeIf { it.storageTotal > 0 }?.let { "已用 ${Fmt.gb(it.storageUsed)} / ${Fmt.gb(it.storageTotal)} GB" } ?: "—",
                    color = Colors.Sub,
                    fontSize = 12.sp,
                )
            }
        }
    }
}

/** 模块行，规则同桌面 ModuleRow：文本 / 进度条 / 趋势折线，多行输出按条目渲染 */
@Composable
fun ModuleRow(m: InstalledModule, out: ModuleOutput?, history: List<Double>?, onClick: () -> Unit) {
    val def = m.def
    val items = ModuleDisplay.items(out)
    val failed = out != null && !out.ok
    val color = ModuleDisplay.color(def, out)?.toColor()
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 5.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(def.name, Modifier.weight(1f), color = Colors.Label, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            when {
                items != null -> Text(out?.text.orEmpty(), color = Colors.Sub, fontSize = 13.sp, maxLines = 1)
                def.style == "sparkline" -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Sparkline(history.orEmpty(), color ?: Colors.Ok)
                    Text(
                        ModuleDisplay.text(def, out),
                        Modifier.padding(start = 6.dp),
                        color = if (failed) Colors.Error else Colors.Text,
                        fontSize = 13.sp,
                        maxLines = 1,
                    )
                }
                def.style == "progress" -> Text(ModuleDisplay.progressText(def, out), color = if (failed) Colors.Error else Colors.Text, fontSize = 13.sp, maxLines = 1)
                else -> Text(ModuleDisplay.text(def, out), color = if (failed) Colors.Error else color ?: Colors.Text, fontSize = 13.sp, maxLines = 2)
            }
        }
        if (items == null && def.style == "progress") {
            Bar(if (failed) 0.0 else out?.value ?: 0.0, color ?: Colors.Ok, Modifier.padding(top = 4.dp))
        }
        // 桌面版鼠标悬停看错误，手机上直接显示在下面
        if (failed) Text(out.text, color = Colors.Error, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (items != null) ModuleItems(items)
    }
}

@Composable
private fun ModuleItems(items: List<ModuleItem>) {
    items.forEachIndexed { i, item ->
        val group = item.group
        if (group != null && group != items.getOrNull(i - 1)?.group) {
            Text(group, Modifier.padding(top = 6.dp), color = Colors.Group, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
        val color = ModuleDisplay.itemColor(item)?.toColor()
        Column(Modifier.padding(start = if (group != null) 8.dp else 0.dp, top = 3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(item.label, Modifier.weight(1f), color = Colors.Label, fontSize = 12.sp, maxLines = 1)
                Text(item.text, color = if (item.value != null) color ?: Colors.Text else Colors.Text, fontSize = 12.sp, maxLines = 1)
            }
            item.value?.let { Bar(it, color ?: Colors.Ok, Modifier.padding(top = 3.dp), height = 4.dp) }
        }
    }
}
