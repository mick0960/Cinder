package com.cinder.mobile.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cinder.mobile.R
import kotlinx.coroutines.delay

/** 与桌面面板一致的深色配色 */
object Colors {
    val Background = Color(0xFF18181C)
    val Panel = Color(0xFF24242A)
    val PanelBorder = Color(0x14FFFFFF)
    val Text = Color(0xFFEEEEEE)
    val Label = Color(0xFF9A9AA2)
    val Sub = Color(0xFF8A8A92)
    val Group = Color(0xFFDDDDDD)
    val Track = Color(0x14FFFFFF)
    val Ok = Color(0xFF4CC2FF)
    val Warn = Color(0xFFFFB547)
    val Danger = Color(0xFFFF5D5D)
    val Good = Color(0xFF4CD97B)
    val Up = Color(0xFFC58CFF)
    val Error = Color(0xFFCC7777)
}

fun Int.toColor(): Color = Color(this)

@Composable
fun CinderTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Colors.Ok,
            onPrimary = Color(0xFF00222F),
            secondary = Colors.Up,
            background = Colors.Background,
            surface = Colors.Background,
            surfaceContainer = Colors.Panel,
            surfaceContainerHigh = Color(0xFF2C2C33),
            surfaceContainerHighest = Color(0xFF34343C),
            onBackground = Colors.Text,
            onSurface = Colors.Text,
            onSurfaceVariant = Colors.Label,
            outline = Color(0xFF4A4A52),
            outlineVariant = Color(0xFF34343C),
            error = Colors.Danger,
        ),
        content = content,
    )
}

/** 面板里的一块区域，外观同桌面 .panel */
@Composable
fun PanelCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Brush.verticalGradient(listOf(Colors.Panel, Color(0xFF1D1D22))))
            .border(1.dp, Colors.PanelBorder, RoundedCornerShape(14.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        content = content,
    )
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(bottom = 6.dp), color = Colors.Label, fontSize = 13.sp)
}

@Composable
fun LabelValue(label: String, value: String, valueColor: Color = Colors.Text, big: Boolean = false) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), color = Colors.Label, fontSize = 13.sp, maxLines = 1)
        Text(
            value,
            color = valueColor,
            fontSize = if (big) 22.sp else 13.sp,
            fontWeight = if (big) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
        )
    }
}

@Composable
fun Bar(value: Double, color: Color, modifier: Modifier = Modifier, height: Dp = 5.dp) {
    val v = value.coerceIn(0.0, 1.0).toFloat()
    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(3.dp))
            .background(Colors.Track),
    ) {
        Box(
            Modifier
                .fillMaxWidth(v)
                .height(height)
                .clip(RoundedCornerShape(3.dp))
                .background(Brush.horizontalGradient(listOf(color.copy(alpha = 0.55f), color))),
        )
    }
}

/** 滚动面积图：最新的点在右边缘，左侧渐隐（同桌面 LiveChart）；below 的序列画在中线下方 */
@Composable
fun LiveChart(
    series: List<Pair<List<Double>, Color>>,
    max: Double,
    modifier: Modifier = Modifier,
    mirror: Boolean = false,
    points: Int = 48,
) {
    // 离屏合成：最后用 DstIn 渐变把左侧旧数据淡出，不依赖背景色
    Canvas(modifier.fillMaxWidth().graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }) {
        val w = size.width
        val h = size.height
        val step = w / (points - 2)
        val base = if (mirror) h / 2 else h - 1f
        val amp = if (mirror) h / 2 - 2f else h - 4f
        drawLine(Colors.Track, Offset(0f, h / 2), Offset(w, h / 2), 1f)
        series.forEachIndexed { index, (values, color) ->
            if (values.size < 2) return@forEachIndexed
            val below = mirror && index == 1
            val n = values.size
            val line = Path()
            var last = Offset.Zero
            values.forEachIndexed { i, v ->
                val k = (v / (if (max > 0) max else 1.0)).coerceIn(0.0, 1.0).toFloat()
                val p = Offset(w - (n - 1 - i) * step, base + (if (below) 1 else -1) * k * amp)
                if (i == 0) line.moveTo(p.x, p.y) else line.lineTo(p.x, p.y)
                last = p
            }
            val area = Path().apply {
                addPath(line)
                lineTo(last.x, base)
                lineTo(w - (n - 1) * step, base)
                close()
            }
            drawPath(area, Brush.verticalGradient(
                if (below) listOf(color.copy(alpha = 0f), color.copy(alpha = 0.4f)) else listOf(color.copy(alpha = 0.4f), color.copy(alpha = 0f)),
                startY = if (below) base else base - amp,
                endY = if (below) base + amp else base,
            ))
            drawPath(line, color, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            drawCircle(color.copy(alpha = 0.35f), 4.5.dp.toPx(), last)
            drawCircle(color, 2.2.dp.toPx(), last)
        }
        drawRect(
            Brush.horizontalGradient(0f to Color.Transparent, 0.18f to Color.Black, startX = 0f, endX = w),
            blendMode = BlendMode.DstIn,
        )
    }
}

/** 模块行的迷你折线（同桌面 Sparkline） */
@Composable
fun Sparkline(values: List<Double>, color: Color, modifier: Modifier = Modifier) {
    if (values.size < 2) return
    Canvas(modifier.size(width = 64.dp, height = 18.dp)) {
        val min = values.min()
        val range = (values.max() - min).takeIf { it > 0 } ?: 1.0
        val pad = 3f
        val pts = values.mapIndexed { i, v ->
            Offset(i.toFloat() / (values.size - 1) * (size.width - pad), (pad + (size.height - 2 * pad) * (1 - (v - min) / range)).toFloat())
        }
        val line = Path().apply {
            pts.forEachIndexed { i, p -> if (i == 0) moveTo(p.x, p.y) else lineTo(p.x, p.y) }
        }
        val area = Path().apply {
            moveTo(0f, size.height)
            pts.forEach { lineTo(it.x, it.y) }
            lineTo(pts.last().x, size.height)
            close()
        }
        drawPath(area, Brush.verticalGradient(listOf(color.copy(alpha = 0.4f), Color.Transparent)))
        drawPath(line, color, style = Stroke(width = 1.5.dp.toPx(), join = StrokeJoin.Round))
        drawCircle(color, 1.8.dp.toPx(), pts.last())
    }
}

private val FIRE = intArrayOf(
    R.drawable.bonfire_1, R.drawable.bonfire_2, R.drawable.bonfire_3, R.drawable.bonfire_4,
    R.drawable.bonfire_5, R.drawable.bonfire_6, R.drawable.bonfire_7, R.drawable.bonfire_8,
)

/** 篝火动画：CPU 越忙烧得越快（同桌面 useFrameClock） */
@Composable
fun Bonfire(cpu: Double?, modifier: Modifier = Modifier, size: Dp = 56.dp) {
    var frame by remember { mutableIntStateOf(0) }
    val load by rememberUpdatedState(cpu ?: 0.0)
    LaunchedEffect(Unit) {
        while (true) {
            delay(maxOf(80.0, 800 - 720 * load.coerceIn(0.0, 1.0)).toLong())
            frame = (frame + 1) % FIRE.size
        }
    }
    Image(painterResource(FIRE[frame]), contentDescription = null, modifier = modifier.size(size))
}

@Composable
fun Pill(text: String, color: Color = Colors.Label) {
    Text(
        text,
        Modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
        color = color,
        fontSize = 11.sp,
    )
}

@Composable
fun SpacedColumn(modifier: Modifier = Modifier, gap: Dp = 12.dp, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(gap), content = content)
}
