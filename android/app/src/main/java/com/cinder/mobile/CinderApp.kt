package com.cinder.mobile

import android.app.Application
import android.content.Context
import com.cinder.mobile.metrics.MetricsRepository
import com.cinder.mobile.metrics.SystemSampler
import com.cinder.mobile.modules.CommandRunner
import com.cinder.mobile.modules.FileModuleKv
import com.cinder.mobile.modules.HttpRunner
import com.cinder.mobile.modules.ModuleEngine
import com.cinder.mobile.modules.ModuleKv
import com.cinder.mobile.modules.ModuleScheduler
import com.cinder.mobile.modules.ModuleStore
import com.cinder.mobile.modules.OkHttpFetcher
import com.cinder.mobile.modules.ScriptRunner
import com.cinder.mobile.settings.SettingsStore
import com.cinder.mobile.shizuku.ShizukuManager
import com.cinder.mobile.widget.RenderState
import com.cinder.mobile.widget.WidgetRenderer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

class CinderApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        graph.shizuku.start()
        graph.scheduler.start()
    }
}

val Context.graph: AppGraph get() = (applicationContext as CinderApp).graph

/** 手写的依赖容器：网络和脚本引擎用到时才创建 */
class AppGraph(val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val settings = SettingsStore(context)
    val shizuku = ShizukuManager(context) { settings.value.useShizuku }
    val sampler = SystemSampler(context)
    val metrics = MetricsRepository(sampler, shizuku, scope)
    val modules = ModuleStore(context)
    val kv: ModuleKv = FileModuleKv(File(context.filesDir, "kv"))
    val renderer = WidgetRenderer(context)

    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
    val fetcher by lazy { OkHttpFetcher(http) }
    val engine by lazy { ModuleEngine(ScriptRunner(fetcher, kv), HttpRunner(fetcher), CommandRunner(shizuku)) }
    val scheduler = ModuleScheduler(modules, { engine }, scope)

    fun renderState() = RenderState(
        metrics = metrics.snapshot.value,
        history = metrics.history.value,
        modules = modules.modules.value,
        outputs = scheduler.outputs.value,
        settings = settings.value,
    )

    /** 省电模式 / 手动刷新：采样、跑一遍模块、刷新小部件 */
    suspend fun refreshOnce() {
        shizuku.acquire("refresh")
        try {
            metrics.sampleOnce()
            scheduler.runAllOnce()
        } finally {
            shizuku.release("refresh")
        }
        renderer.render(renderState(), force = true)
    }
}
