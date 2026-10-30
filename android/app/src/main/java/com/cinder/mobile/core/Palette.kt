package com.cinder.mobile.core

/** 与桌面版 ModuleStyles.tsx / panel.css 一致的配色 */
object Palette {
    const val OK = 0xFF4CC2FF.toInt()
    const val WARN = 0xFFFFB547.toInt()
    const val DANGER = 0xFFFF5D5D.toInt()
    const val GOOD = 0xFF4CD97B.toInt()
    const val NET_DOWN = 0xFF4CC2FF.toInt()
    const val NET_UP = 0xFFC58CFF.toInt()
    const val TEXT = 0xFFEEEEEE.toInt()
    const val LABEL = 0xFF9A9AA2.toInt()
    const val SUB = 0xFF8A8A92.toInt()
    const val GROUP = 0xFFDDDDDD.toInt()
    const val ERROR = 0xFFCC7777.toInt()

    /** 占用类指标：越高越危险 */
    fun usage(v: Double): Int = when {
        v >= 0.9 -> DANGER
        v >= 0.75 -> WARN
        else -> OK
    }

    /** 电量：越低越危险，充电中为绿色 */
    fun battery(v: Double, charging: Boolean): Int = when {
        charging -> GOOD
        v <= 0.15 -> DANGER
        v <= 0.3 -> WARN
        else -> OK
    }

    /** 解析模块输出里的 CSS 颜色：#rgb / #rrggbb / #rrggbbaa（与桌面 WebView 的含义一致） */
    fun parse(color: String?): Int? {
        val hex = color?.trim()?.removePrefix("#")?.takeIf { color.trim().startsWith("#") } ?: return null
        val full = when (hex.length) {
            3 -> hex.map { "$it$it" }.joinToString("")
            6, 8 -> hex
            else -> return null
        }
        val v = full.toLongOrNull(16) ?: return null
        return if (full.length == 6) {
            (0xFF000000L or v).toInt()
        } else {
            val rgb = v ushr 8
            val alpha = v and 0xFF
            ((alpha shl 24) or rgb).toInt()
        }
    }
}
