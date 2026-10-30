package com.cinder.mobile.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import com.cinder.mobile.MainActivity
import com.cinder.mobile.R
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
import com.cinder.mobile.settings.AppSettings
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class RenderState(
    val metrics: MetricsSnapshot?,
    val history: MetricHistory,
    val modules: List<InstalledModule>,
    val outputs: Map<String, ModuleOutput>,
    val settings: AppSettings,
)

/**
 * 把快照画到桌面小部件上。每类小部件记一个"内容签名"，内容没变就不推送，
 * 省掉一次 binder 传输和桌面的重新布局。
 */
class WidgetRenderer(private val context: Context) {
    private val manager = AppWidgetManager.getInstance(context)
    private val chart = ChartBitmap()
    private val signatures = HashMap<String, String>()
    /** 上次整体更新时的布局结构；进程重启后为空，第一次总是整体更新 */
    private val structures = HashMap<String, String>()
    private val loggedSizes = HashSet<Int>()
    private var frame = 0

    fun ids(provider: Class<out AppWidgetProvider>): IntArray =
        manager.getAppWidgetIds(ComponentName(context, provider))

    fun count(): Int = PROVIDERS.sumOf { ids(it).size }

    fun hasWidgets(): Boolean = count() > 0

    @Synchronized
    fun render(state: RenderState, force: Boolean = false) {
        renderSystem(state, force)
        renderModules(state, force)
    }

    @Synchronized
    fun renderSystem(state: RenderState, force: Boolean = false) {
        frame = (frame + 1) % FRAMES.size
        val signature = systemSignature(state)
        val anim = state.settings.bonfireAnimation
        val summary = ids(SummaryWidget::class.java)
        if (summary.isNotEmpty()) push("summary", summary, signature, "summary|$anim", force) { summary(state) }
        // 不用 RemoteViews(Map<SizeF, …>) 让桌面按尺寸挑布局：HyperOS 桌面会把一种布局的数据套到另一种布局上。
        // 这里按每个实例上报的宽度自己选，宽度不够时换成概览布局。
        for (id in ids(SystemWidget::class.java)) {
            val wide = widthDp(id) >= WIDE_DP
            push("system:$id", intArrayOf(id), "$wide|$signature", "system|$wide|$anim", force) {
                if (wide) system(state) else summary(state)
            }
        }
    }

    /** 竖屏下的宽度（AOSP 约定 OPTION_APPWIDGET_MIN_WIDTH 为竖屏宽度）；拿不到时按 4×2 处理 */
    private fun widthDp(id: Int): Int {
        val options = manager.getAppWidgetOptions(id)
        val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
        if (loggedSizes.add(id)) {
            Log.i(TAG, "widget $id size: min=${width}x${options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)} " +
                "max=${options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH)}x${options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)}")
        }
        return if (width > 0) width else WIDE_DP
    }

    /** 尺寸变化后重新记录日志并强制重绘 */
    @Synchronized
    fun sizeChanged(id: Int) {
        loggedSizes.remove(id)
        signatures.remove("system:$id")
        structures.remove("system:$id")
    }

    /** 实例被删除（包括拖进负一屏后换掉的旧 id）时清掉按 id 记的缓存 */
    @Synchronized
    fun forget(ids: IntArray) {
        for (id in ids) sizeChanged(id)
    }

    @Synchronized
    fun renderModules(state: RenderState, force: Boolean = false) {
        val ids = ids(ModulesWidget::class.java)
        // 列表的行结构随输出变化，且更新不频繁，总是整体更新
        if (ids.isNotEmpty()) push("modules", ids, modulesSignature(state), structure = null, force) { modules(state) }
    }

    /**
     * 内容签名没变就不推送。布局结构（structure）没变时用 partiallyUpdateAppWidget 只下发
     * 文字、进度、图表这些操作，桌面不必每次重新创建整个布局（比如反复解码 8 帧篝火图片）。
     * 系统会忽略发给"还没整体更新过"的实例的局部更新，所以实例集合变了（新添加、拖进负一屏换了 id）也整体更新。
     */
    private inline fun push(key: String, ids: IntArray, signature: String, structure: String?, force: Boolean, build: () -> RemoteViews) {
        if (!force && signatures[key] == signature) return
        signatures[key] = signature
        val views = build()
        val shape = structure?.let { "$it|${ids.sorted().joinToString(",")}" }
        if (!force && shape != null && structures[key] == shape) {
            manager.partiallyUpdateAppWidget(ids, views)
        } else {
            shape?.let { structures[key] = it }
            manager.updateAppWidget(ids, views)
        }
    }

    /* ---------- 系统指标 ---------- */

    private fun summary(s: RenderState): RemoteViews {
        val rv = RemoteViews(context.packageName, R.layout.widget_summary)
        val m = s.metrics
        fire(rv, s)
        cpu(rv, m)
        val mem = m?.memRatio ?: 0.0
        rv.setTextViewText(R.id.mem_value, m?.let { "${Fmt.bytes(it.memUsed)} · ${Fmt.percent(mem)}" } ?: "—")
        bar(rv, R.id.mem_bar, mem, Palette.usage(mem))
        val b = m?.battery
        rv.setTextViewText(R.id.bat_label, if (b?.charging == true) "充电" else "电量")
        rv.setTextViewText(R.id.bat_value, b?.let { batteryShort(it) } ?: "—")
        bar(rv, R.id.bat_bar, b?.level ?: 0.0, Palette.battery(b?.level ?: 0.0, b?.charging == true))
        rv.setTextViewText(R.id.net_value, net(m))
        rv.setOnClickPendingIntent(R.id.root, openApp(MainActivity.TAB_PANEL))
        return rv
    }

    private fun system(s: RenderState): RemoteViews {
        val rv = RemoteViews(context.packageName, R.layout.widget_system)
        val m = s.metrics
        fire(rv, s)
        cpu(rv, m)
        rv.setTextViewText(R.id.cpu_sub, cpuSub(m))
        val color = Palette.usage(m?.cpu ?: 0.0)
        rv.setImageViewBitmap(R.id.cpu_chart, chart.render(s.history.cpu))
        rv.setInt(R.id.cpu_chart, "setColorFilter", color)
        val b = m?.battery
        rv.setTextViewText(R.id.bat_value, b?.let { batteryLong(it) } ?: "—")
        rv.setTextColor(R.id.bat_value, b?.let { Palette.battery(it.level, it.charging) } ?: Palette.TEXT)
        rv.setTextViewText(R.id.net_value, net(m))
        val mem = m?.memRatio ?: 0.0
        rv.setTextViewText(R.id.mem_value, m?.let { "${Fmt.bytes(it.memUsed)} / ${Fmt.bytes(it.memTotal)}" } ?: "—")
        bar(rv, R.id.mem_bar, mem, Palette.usage(mem))
        val disk = m?.storageRatio ?: 0.0
        rv.setTextViewText(R.id.disk_value, m?.takeIf { it.storageTotal > 0 }?.let { "${Fmt.gb(it.storageUsed)}/${Fmt.gb(it.storageTotal)} GB" } ?: "—")
        bar(rv, R.id.disk_bar, disk, Palette.usage(disk))
        rv.setOnClickPendingIntent(R.id.root, openApp(MainActivity.TAB_PANEL))
        return rv
    }

    private fun cpu(rv: RemoteViews, m: MetricsSnapshot?) {
        val cpu = m?.cpu
        rv.setTextViewText(R.id.cpu_value, cpu?.let { Fmt.percent(it) } ?: "—")
        rv.setTextColor(R.id.cpu_value, Palette.usage(cpu ?: 0.0))
        rv.setTextViewText(R.id.cpu_label, if (m?.cpuKind == CpuKind.FREQ) "CPU 频率" else "CPU")
    }

    private fun cpuSub(m: MetricsSnapshot?): String {
        if (m == null) return ""
        val parts = ArrayList<String>()
        m.cpuTempC?.let { parts += "${Fmt.one(it)}°C" }
        if (m.cores.isNotEmpty()) parts += if (m.cpuKind == CpuKind.PROC_STAT) "${m.cores.size} 核" else "${m.cores.size} 簇"
        m.netType?.let { parts += it }
        return parts.joinToString(" · ")
    }

    /** 篝火：动画模式下 CPU 越忙翻页越快（对应桌面 useFrameClock 的 max(80, 800 − 720·cpu)） */
    private fun fire(rv: RemoteViews, s: RenderState) {
        if (s.settings.bonfireAnimation) {
            rv.setViewVisibility(R.id.fire_anim, View.VISIBLE)
            rv.setViewVisibility(R.id.fire_static, View.GONE)
            rv.setInt(R.id.fire_anim, "setFlipInterval", flipInterval(s.metrics?.cpu ?: 0.0))
        } else {
            rv.setViewVisibility(R.id.fire_anim, View.GONE)
            rv.setViewVisibility(R.id.fire_static, View.VISIBLE)
            rv.setImageViewResource(R.id.fire_static, FRAMES[frame])
        }
    }

    /** 进度条是 ImageView：level 决定裁剪长度，colorFilter 上色（ImageView 上色前会 mutate，各条互不影响） */
    private fun bar(rv: RemoteViews, id: Int, ratio: Double, color: Int) {
        rv.setInt(id, "setImageLevel", (ratio.coerceIn(0.0, 1.0) * 10_000).toInt())
        rv.setInt(id, "setColorFilter", color)
    }

    private fun net(m: MetricsSnapshot?): String =
        if (m == null) "↓ —  ↑ —" else "↓ ${Fmt.rate(m.netDown)}  ↑ ${Fmt.rate(m.netUp)}"

    private fun batteryShort(b: BatteryInfo): String {
        val pct = Fmt.percent(b.level)
        return if (b.charging && b.powerW != null && b.powerW >= 0.1) "$pct · ${Fmt.one(b.powerW)} W" else pct
    }

    private fun batteryLong(b: BatteryInfo): String {
        val parts = arrayListOf("电池 ${Fmt.percent(b.level)}")
        if (b.powerW != null && b.powerW >= 0.1) parts += (if (b.charging) "充电 " else "") + "${Fmt.one(b.powerW)} W"
        b.tempC?.let { parts += "${Fmt.one(it)}°C" }
        return parts.joinToString(" · ")
    }

    private fun systemSignature(s: RenderState): String {
        val m = s.metrics ?: return "none"
        val b = m.battery
        return buildString {
            append(m.cpu?.let { (it * 100).toInt() }).append('|').append(m.cpuKind)
            append('|').append(m.memUsed / (1 shl 20)).append('|').append(m.storageUsed / (1 shl 30))
            append('|').append(m.netUp / 100).append('|').append(m.netDown / 100)
            append('|').append(b?.level).append(b?.charging).append(b?.powerW?.let { (it * 10).toInt() }).append(b?.tempC)
            append('|').append(m.cpuTempC?.toInt()).append('|').append(m.netType)
            append('|').append(s.settings.bonfireAnimation)
            // 静态篝火每次刷新换一帧，签名里带上帧号
            if (!s.settings.bonfireAnimation) append('|').append(frame)
        }
    }

    /* ---------- 自定义模块 ---------- */

    private fun modules(s: RenderState): RemoteViews {
        val rv = RemoteViews(context.packageName, R.layout.widget_modules)
        val items = RemoteViews.RemoteCollectionItems.Builder()
            .setHasStableIds(true)
            .setViewTypeCount(3)
        var shown = 0
        var latest = 0L
        for (m in s.modules) {
            if (!m.enabled || !m.widget) continue
            val out = s.outputs[m.id]
            if (out != null && out.at > latest) latest = out.at
            val base = (m.id.hashCode().toLong() and 0xFFFFFFFFL) shl 12
            val list = ModuleDisplay.items(out)
            items.addItem(base, moduleRow(m, out, multi = list != null))
            var lastGroup: String? = null
            var n = 1L
            list?.forEach { item ->
                val group = item.group
                if (group != null && group != lastGroup) items.addItem(base + n++, groupRow(group))
                lastGroup = group
                items.addItem(base + n++, itemRow(m, item))
            }
            shown++
        }
        rv.setRemoteAdapter(R.id.list, items.build())
        rv.setViewVisibility(R.id.empty, if (shown == 0) View.VISIBLE else View.GONE)
        rv.setTextViewText(R.id.updated, if (latest > 0) TIME.format(Date(latest)) else "")
        rv.setOnClickPendingIntent(R.id.refresh, refreshIntent())
        rv.setOnClickPendingIntent(R.id.header, openApp(MainActivity.TAB_MODULES))
        rv.setPendingIntentTemplate(R.id.list, rowTemplate())
        return rv
    }

    private fun moduleRow(m: InstalledModule, out: ModuleOutput?, multi: Boolean): RemoteViews {
        val rv = RemoteViews(context.packageName, R.layout.widget_row)
        val def = m.def
        rv.setTextViewText(R.id.label, def.name)
        val failed = out != null && !out.ok
        val text = if (multi) out?.text.orEmpty() else ModuleDisplay.valueText(def, out)
        rv.setTextViewText(R.id.value, text)
        val color = ModuleDisplay.color(def, out)
        rv.setTextColor(
            R.id.value,
            when {
                failed -> Palette.ERROR
                multi -> Palette.SUB
                def.style == "text" && color != null -> color
                else -> Palette.TEXT
            }
        )
        val showBar = !multi && def.style == "progress"
        rv.setViewVisibility(R.id.bar, if (showBar) View.VISIBLE else View.GONE)
        if (showBar) bar(rv, R.id.bar, if (failed) 0.0 else out?.value ?: 0.0, color ?: Palette.OK)
        rv.setOnClickFillInIntent(R.id.row, openModule(m.id))
        return rv
    }

    private fun groupRow(group: String): RemoteViews =
        RemoteViews(context.packageName, R.layout.widget_row_group).apply { setTextViewText(R.id.group, group) }

    private fun itemRow(m: InstalledModule, item: ModuleItem): RemoteViews {
        val rv = RemoteViews(context.packageName, R.layout.widget_row_item)
        rv.setTextViewText(R.id.label, item.label)
        rv.setTextViewText(R.id.value, item.text)
        val color = ModuleDisplay.itemColor(item)
        rv.setTextColor(R.id.value, if (item.value != null && color != null) color else Palette.TEXT)
        val v = item.value
        rv.setViewVisibility(R.id.bar, if (v != null) View.VISIBLE else View.GONE)
        if (v != null) bar(rv, R.id.bar, v, color ?: Palette.OK)
        rv.setOnClickFillInIntent(R.id.row, openModule(m.id))
        return rv
    }

    private fun modulesSignature(s: RenderState): String = buildString {
        for (m in s.modules) {
            if (!m.enabled || !m.widget) continue
            val out = s.outputs[m.id]
            append(m.id).append(m.def.name).append(m.def.style).append(m.def.unit)
            append(out?.ok).append(out?.text).append(out?.value).append(out?.color).append(out?.items).append(';')
        }
    }

    /* ---------- 点击 ---------- */

    private fun openApp(tab: Int): PendingIntent = PendingIntent.getActivity(
        context, 100 + tab,
        Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_TAB, tab)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /** 列表行的点击模板必须是可变的，行上的 fill-in intent 才能补进模块 id */
    private fun rowTemplate(): PendingIntent = PendingIntent.getActivity(
        context, 200,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun openModule(id: String) = Intent()
        .putExtra(MainActivity.EXTRA_TAB, MainActivity.TAB_MODULES)
        .putExtra(MainActivity.EXTRA_MODULE, id)

    private fun refreshIntent(): PendingIntent = PendingIntent.getBroadcast(
        context, 300,
        Intent(context, WidgetActionReceiver::class.java).setAction(WidgetActionReceiver.ACTION_REFRESH),
        PendingIntent.FLAG_IMMUTABLE,
    )

    companion object {
        private const val TAG = "WidgetRenderer"

        /** 系统监控小部件宽于此值（dp）时用完整布局，否则用概览布局 */
        private const val WIDE_DP = 200

        val PROVIDERS = listOf(SummaryWidget::class.java, SystemWidget::class.java, ModulesWidget::class.java)

        private val FRAMES = intArrayOf(
            R.drawable.bonfire_1, R.drawable.bonfire_2, R.drawable.bonfire_3, R.drawable.bonfire_4,
            R.drawable.bonfire_5, R.drawable.bonfire_6, R.drawable.bonfire_7, R.drawable.bonfire_8,
        )

        private val TIME = SimpleDateFormat("HH:mm", Locale.ROOT)

        /** 分档而不是连续值，避免每次刷新都改翻页间隔 */
        fun flipInterval(cpu: Double): Int = when {
            cpu >= 0.75 -> 160
            cpu >= 0.5 -> 300
            cpu >= 0.25 -> 450
            else -> 650
        }
    }
}
