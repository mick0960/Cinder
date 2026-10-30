package com.cinder.mobile.modules

import com.cinder.mobile.core.Fmt
import com.cinder.mobile.core.Palette

/** 模块行的展示规则，移植自桌面 PanelWindow.tsx 的 ModuleRow；界面和小部件共用 */
object ModuleDisplay {
    /** 未运行过显示"…"，出错显示"—"，有单位时追加单位 */
    fun text(def: ModuleDef, out: ModuleOutput?): String {
        if (out == null) return "…"
        if (!out.ok) return "—"
        val unit = def.unit
        return if (!unit.isNullOrEmpty() && !out.text.endsWith(unit)) out.text + unit else out.text
    }

    /** 进度条样式右侧的文字：JSON 输出自带 text 时优先显示（如"8.8 / 512 GB"），否则显示百分比 */
    fun progressText(def: ModuleDef, out: ModuleOutput?): String {
        if (out != null && out.ok && out.fromJson && out.text.isNotEmpty()) return text(def, out)
        val v = out?.value
        return if (out != null && out.ok && v != null) Fmt.percent(v) else text(def, out)
    }

    fun valueText(def: ModuleDef, out: ModuleOutput?): String =
        if (def.style == "progress") progressText(def, out) else text(def, out)

    fun color(def: ModuleDef, out: ModuleOutput?): Int? = Palette.parse(out?.color ?: def.color)

    /** 多行条目：有数值时默认按占用率着色 */
    fun itemColor(item: ModuleItem): Int? = Palette.parse(item.color) ?: item.value?.let { Palette.usage(it) }

    /** 多行输出（且未出错）时按条目渲染，忽略 style */
    fun items(out: ModuleOutput?): List<ModuleItem>? =
        out?.items?.takeIf { out.ok && it.isNotEmpty() }
}
