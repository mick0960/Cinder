package com.cinder.mobile.settings

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class AppSettings(
    /** 实时模式：前台服务在亮屏时按 intervalSec 刷新小部件；关闭即省电模式（约 15 分钟一次） */
    val realtime: Boolean = true,
    val intervalSec: Int = 3,
    /** 常驻通知显示实时摘要；关闭时只显示静态文字 */
    val liveNotification: Boolean = false,
    /** 小部件里的篝火逐帧播放；关闭时每次刷新换一帧 */
    val bonfireAnimation: Boolean = true,
    val useShizuku: Boolean = true,
)

/** SharedPreferences 足够存这几个开关，比 DataStore 少一个依赖和一份常驻内存 */
class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow(load())
    val state: StateFlow<AppSettings> = _state.asStateFlow()
    val value: AppSettings get() = _state.value

    fun update(transform: (AppSettings) -> AppSettings) {
        val next = synchronized(this) {
            transform(_state.value).also { _state.value = it }
        }
        prefs.edit()
            .putBoolean("realtime", next.realtime)
            .putInt("intervalSec", next.intervalSec)
            .putBoolean("liveNotification", next.liveNotification)
            .putBoolean("bonfireAnimation", next.bonfireAnimation)
            .putBoolean("useShizuku", next.useShizuku)
            .apply()
    }

    private fun load(): AppSettings {
        val d = AppSettings()
        return AppSettings(
            realtime = prefs.getBoolean("realtime", d.realtime),
            intervalSec = prefs.getInt("intervalSec", d.intervalSec).coerceIn(1, 60),
            liveNotification = prefs.getBoolean("liveNotification", d.liveNotification),
            bonfireAnimation = prefs.getBoolean("bonfireAnimation", d.bonfireAnimation),
            useShizuku = prefs.getBoolean("useShizuku", d.useShizuku),
        )
    }
}
