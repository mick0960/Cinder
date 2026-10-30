package com.cinder.mobile.widget

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import com.cinder.mobile.metrics.MetricHistory

/**
 * 小部件里的走势图。画成 ALPHA_8 位图（每像素 1 字节），颜色由 ImageView 的 colorFilter 决定，
 * 一张 240×60 的图只有 14 KB，每次刷新经 binder 传给桌面也不心疼。
 */
class ChartBitmap {
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.5f
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)

    /** 与桌面 LiveChart 一致：最新的点在右边缘，左侧渐隐 */
    fun render(values: List<Double>, max: Double = 1.0, width: Int = 240, height: Int = 60): Bitmap {
        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ALPHA_8)
        if (values.size < 2) return bmp
        val canvas = Canvas(bmp)
        val step = width.toFloat() / (MetricHistory.POINTS - 2)
        val top = 4f
        val base = height - 2f
        val n = values.size
        val path = Path()
        var lastX = 0f
        var lastY = 0f
        values.forEachIndexed { i, v ->
            val k = (v / (if (max > 0) max else 1.0)).coerceIn(0.0, 1.0).toFloat()
            val x = width - (n - 1 - i) * step
            val y = base - k * (base - top)
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            lastX = x
            lastY = y
        }
        val area = Path(path).apply {
            lineTo(lastX, base)
            lineTo(width - (n - 1) * step, base)
            close()
        }
        fill.shader = LinearGradient(0f, top, 0f, base, 0x73000000, 0x00000000, Shader.TileMode.CLAMP)
        canvas.drawPath(area, fill)
        line.shader = LinearGradient(0f, 0f, width * 0.18f, 0f, 0x00000000, 0xFF000000.toInt(), Shader.TileMode.CLAMP)
        canvas.drawPath(path, line)
        dot.alpha = 255
        canvas.drawCircle(lastX - 2f, lastY, 3.2f, dot)
        return bmp
    }
}
