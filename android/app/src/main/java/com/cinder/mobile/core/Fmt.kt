package com.cinder.mobile.core

import java.util.Locale
import kotlin.math.roundToInt

object Fmt {
    private const val KB = 1024.0
    private const val MB = KB * 1024
    private const val GB = MB * 1024

    fun rate(bps: Long): String = when {
        bps < 1024 -> "$bps B/s"
        bps < 1024 * 1024 -> String.format(Locale.ROOT, "%.1f KB/s", bps / KB)
        else -> String.format(Locale.ROOT, "%.2f MB/s", bps / MB)
    }

    /** 与桌面 fmtMb 一致：不足 1 GB 显示 MB，否则保留一位小数的 GB（二进制单位） */
    fun bytes(b: Long): String =
        if (b < GB) String.format(Locale.ROOT, "%.0f MB", b / MB)
        else String.format(Locale.ROOT, "%.1f GB", b / GB)

    fun gb(b: Long): String = String.format(Locale.ROOT, "%.0f", b / GB)

    fun percent(ratio: Double): String = "${(ratio * 100).roundToInt()}%"

    fun one(v: Double): String = String.format(Locale.ROOT, "%.1f", v)

    /** 与桌面 fmtLeft 一致 */
    fun duration(secs: Long): String {
        val h = secs / 3600
        val m = secs % 3600 / 60
        return if (h > 0) "$h 小时 $m 分" else "$m 分钟"
    }
}
