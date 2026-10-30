package com.cinder.mobile.metrics

import android.os.SystemClock
import com.cinder.mobile.shizuku.ShizukuManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 按需采样：界面打开、实时模式亮屏时各自"申请"一个采样间隔，取最小值运行；
 * 没有任何申请时采样循环直接退出，不占 CPU。
 */
class MetricsRepository(
    private val sampler: SystemSampler,
    private val shizuku: ShizukuManager,
    private val scope: CoroutineScope,
) {
    private val _snapshot = MutableStateFlow<MetricsSnapshot?>(null)
    val snapshot: StateFlow<MetricsSnapshot?> = _snapshot.asStateFlow()

    private val _history = MutableStateFlow(MetricHistory())
    val history: StateFlow<MetricHistory> = _history.asStateFlow()

    private val demands = HashMap<String, Long>()
    private var loop: Job? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var lastTickAt = 0L

    /** 申请采样；新申请会立即触发一次采样（例如打开界面时马上刷新） */
    fun acquire(tag: String, intervalMs: Long) {
        synchronized(demands) {
            demands[tag] = intervalMs.coerceAtLeast(1000)
            if (loop?.isActive != true) loop = scope.launch { run() }
        }
        wake.trySend(Unit)
    }

    fun release(tag: String) {
        synchronized(demands) { demands.remove(tag) }
        wake.trySend(Unit)
    }

    private suspend fun run() {
        while (true) {
            val interval = synchronized(demands) {
                demands.values.minOrNull().also { if (it == null) loop = null }
            } ?: return
            tick()
            withTimeoutOrNull(interval) { wake.receive() }
        }
    }

    suspend fun tick(): MetricsSnapshot = withContext(Dispatchers.Default) {
        val snap = sampler.sample(shizuku.service.value)
        val now = SystemClock.elapsedRealtime()
        val dt = if (lastTickAt == 0L) 0L else now - lastTickAt
        lastTickAt = now
        _snapshot.value = snap
        _history.value = _history.value.let { h ->
            MetricHistory(
                cpu = (h.cpu + (snap.cpu ?: 0.0)).takeLast(MetricHistory.POINTS),
                down = (h.down + snap.netDown).takeLast(MetricHistory.POINTS),
                up = (h.up + snap.netUp).takeLast(MetricHistory.POINTS),
                // 间隔过长的样本（如息屏后恢复）不参与估算
                stepMs = if (dt in 150..5000) (h.stepMs * 0.6 + dt * 0.4).toLong() else h.stepMs,
            )
        }
        snap
    }

    /** 省电模式 / 手动刷新：两次采样相隔 1 秒，网速和 /proc/stat 才有差值 */
    suspend fun sampleOnce(): MetricsSnapshot {
        tick()
        delay(1000)
        return tick()
    }
}
