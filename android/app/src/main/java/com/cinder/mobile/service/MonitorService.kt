package com.cinder.mobile.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.cinder.mobile.AppGraph
import com.cinder.mobile.MainActivity
import com.cinder.mobile.R
import com.cinder.mobile.core.Fmt
import com.cinder.mobile.graph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

/**
 * 实时模式：亮屏时按设定间隔刷新小部件，息屏后立即停止一切采样和模块执行
 * （不持唤醒锁、不设闹钟），所以息屏耗电为零。
 *
 * Android 规定秒级刷新只能靠前台服务，因此有一条常驻通知（默认只显示静态文字）。
 */
class MonitorService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var graph: AppGraph
    private var active: Job? = null
    private var lastRender = 0L
    private var lastNotify = 0L

    private val screen = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> setActive(true)
                Intent.ACTION_SCREEN_OFF -> setActive(false)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        graph = applicationContext.graph
        running = true
        ensureChannel(this)
        foreground(STATIC_TEXT)
        // 服务起来了，取消启动失败时排的兜底周期任务
        RefreshJob.sync(this)
        registerReceiver(
            screen,
            IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_ON)
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_USER_PRESENT)
            },
            RECEIVER_NOT_EXPORTED,
        )
        setActive(getSystemService(PowerManager::class.java).isInteractive)
        // 设置变化（间隔、Shizuku、通知样式）时重启刷新循环；模式切走则停止服务
        scope.launch {
            graph.settings.state.drop(1).collect {
                if (!shouldRun(this@MonitorService)) {
                    stopSelf()
                } else if (active != null) {
                    setActive(false)
                    setActive(true)
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForegroundService 之后必须尽快调用 startForeground
        foreground(STATIC_TEXT)
        when (intent?.action) {
            ACTION_REFRESH -> {
                graph.scheduler.wakeAll()
                scope.launch { graph.metrics.tick() }
            }
            else -> if (!shouldRun(this)) stopSelf()
        }
        return START_STICKY
    }

    private fun setActive(on: Boolean) {
        if (on == (active != null)) return
        if (on) {
            val settings = graph.settings.value
            val interval = settings.intervalSec * 1000L
            graph.metrics.acquire(TAG, interval)
            graph.scheduler.acquire(TAG)
            graph.shizuku.acquire(TAG)
            active = scope.launch {
                launch {
                    graph.metrics.snapshot.filterNotNull().collect {
                        // 界面打开时采样更频繁，小部件仍按设定间隔刷新
                        val now = SystemClock.elapsedRealtime()
                        if (now - lastRender >= interval - 250) {
                            lastRender = now
                            graph.renderer.renderSystem(graph.renderState())
                            if (settings.liveNotification && now - lastNotify >= 10_000) {
                                lastNotify = now
                                foreground(summary())
                            }
                        }
                    }
                }
                launch {
                    graph.scheduler.outputs.collect { graph.renderer.renderModules(graph.renderState()) }
                }
            }
        } else {
            active?.cancel()
            active = null
            graph.metrics.release(TAG)
            graph.scheduler.release(TAG)
            graph.shizuku.release(TAG)
        }
    }

    private fun summary(): String {
        val m = graph.metrics.snapshot.value ?: return STATIC_TEXT
        val cpu = m.cpu?.let { "CPU ${Fmt.percent(it)}" } ?: "CPU —"
        return "$cpu · 内存 ${Fmt.percent(m.memRatio)} · ↓${Fmt.rate(m.netDown)} ↑${Fmt.rate(m.netUp)}"
    }

    private fun foreground(text: String) {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_flame)
            .setContentTitle("Cinder 实时监控")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(open)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            Log.w(TAG, "startForeground failed", e)
            stopSelf()
        }
    }

    override fun onDestroy() {
        setActive(false)
        unregisterReceiver(screen)
        scope.cancel()
        running = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "MonitorService"
        private const val CHANNEL = "monitor"
        private const val NOTIFICATION_ID = 1
        private const val STATIC_TEXT = "小部件实时刷新中，息屏时自动暂停"
        const val ACTION_REFRESH = "com.cinder.mobile.service.REFRESH"
        const val ACTION_SYNC = "com.cinder.mobile.service.SYNC"

        @Volatile
        var running = false
            private set

        /** 实时模式且桌面上有小部件（或开启了通知摘要）时才需要服务 */
        fun shouldRun(context: Context): Boolean {
            val g = context.graph
            val s = g.settings.value
            return s.realtime && (g.renderer.hasWidgets() || s.liveNotification)
        }

        /**
         * 按当前设置启动或停止服务，并同步省电模式的周期任务。
         * Android 12+ 不允许后台随意启动前台服务：失败时静默放弃，等用户打开 App 或点小部件时再启动。
         */
        fun sync(context: Context) {
            val g = context.graph
            Log.i(TAG, "sync: realtime=${g.settings.value.realtime} widgets=${g.renderer.count()} live=${g.settings.value.liveNotification} running=$running")
            var fallback = false
            if (shouldRun(context)) {
                try {
                    context.startForegroundService(Intent(context, MonitorService::class.java).setAction(ACTION_SYNC))
                } catch (e: Exception) {
                    // 例如升级后系统发的 MY_PACKAGE_REPLACED：先退回周期刷新，服务启动后会取消
                    Log.w(TAG, "cannot start from background: ${e.message}")
                    fallback = !running
                }
            } else if (running) {
                context.stopService(Intent(context, MonitorService::class.java))
            }
            RefreshJob.sync(context, fallback)
        }

        fun refresh(context: Context) {
            if (running) {
                context.startService(Intent(context, MonitorService::class.java).setAction(ACTION_REFRESH))
            } else {
                RefreshJob.runNow(context)
            }
        }

        fun ensureChannel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) != null) return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, context.getString(R.string.channel_monitor), NotificationManager.IMPORTANCE_LOW).apply {
                    description = context.getString(R.string.channel_monitor_desc)
                    setShowBadge(false)
                }
            )
        }
    }
}
