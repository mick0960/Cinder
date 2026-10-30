package com.cinder.mobile.modules

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 按各模块自己的间隔循环运行。与桌面版一致：只在有人需要时运行（界面打开、实时模式亮屏），
 * 连续失败 3 次后间隔 ×4。同时最多跑 2 个模块，避免一起刷新时 CPU 尖峰。
 */
class ModuleScheduler(
    private val store: ModuleStore,
    private val engine: () -> ModuleEngine,
    private val scope: CoroutineScope,
) {
    private val _outputs = MutableStateFlow<Map<String, ModuleOutput>>(emptyMap())
    val outputs: StateFlow<Map<String, ModuleOutput>> = _outputs.asStateFlow()

    /** 进度条 / 折线用的数值历史，与桌面一样保留 30 个点 */
    private val _history = MutableStateFlow<Map<String, List<Double>>>(emptyMap())
    val history: StateFlow<Map<String, List<Double>>> = _history.asStateFlow()

    private val holders = HashSet<String>()
    private var job: Job? = null
    private val gate = Semaphore(2)
    private val wake = MutableStateFlow(0)
    private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch {
            var previous: List<InstalledModule>? = null
            store.modules.collect { list ->
                val ids = list.map { it.id }.toSet()
                _outputs.update { it.filterKeys(ids::contains) }
                _history.update { it.filterKeys(ids::contains) }
                // 只有影响运行的字段变化才重启循环
                if (previous != null && previous?.map(::runKey) != list.map(::runKey)) restart()
                previous = list
            }
        }
    }

    fun acquire(tag: String) {
        val changed = synchronized(holders) { holders.add(tag) && holders.size == 1 }
        if (changed) restart() else wakeAll()
    }

    fun release(tag: String) {
        val changed = synchronized(holders) { holders.remove(tag) && holders.isEmpty() }
        if (changed) restart()
    }

    /** 让所有循环立即进入下一轮（手动刷新、界面打开） */
    fun wakeAll() = wake.update { it + 1 }

    /** 省电模式的周期任务 / 手动刷新：所有启用的模块各跑一次 */
    suspend fun runAllOnce() = coroutineScope {
        for (m in store.modules.value.filter { it.enabled }) {
            launch { publish(gate.withPermit { engine().run(m) }) }
        }
    }

    @Synchronized
    private fun restart() {
        job?.cancel()
        val active = synchronized(holders) { holders.isNotEmpty() }
        job = if (!active) null else scope.launch {
            for (m in store.modules.value.filter { it.enabled }) launch { loop(m) }
        }
    }

    private suspend fun loop(module: InstalledModule) {
        var failures = 0
        val base = module.def.intervalMs.coerceAtLeast(1000)
        while (true) {
            val seen = wake.value
            val out = gate.withPermit { engine().run(module) }
            publish(out)
            failures = if (out.ok) 0 else failures + 1
            val delayMs = base * if (failures >= 3) 4 else 1
            withTimeoutOrNull(delayMs) { wake.first { it != seen } }
        }
    }

    private fun publish(out: ModuleOutput) {
        _outputs.update { it + (out.id to out) }
        val v = out.value
        if (out.ok && v != null) {
            _history.update { h -> h + (out.id to ((h[out.id] ?: emptyList()) + v).takeLast(HISTORY)) }
        }
    }

    private fun runKey(m: InstalledModule) = Triple(m.def, m.values, m.enabled)

    private companion object {
        const val HISTORY = 30
    }
}
