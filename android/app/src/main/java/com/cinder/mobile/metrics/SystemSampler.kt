package com.cinder.mobile.metrics

import android.app.ActivityManager
import android.app.usage.StorageStatsManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.os.BatteryManager
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.os.storage.StorageManager
import com.cinder.mobile.shizuku.IPrivileged
import kotlin.math.abs

/**
 * 采集一次系统快照。所有调用都很轻：几个 binder 查询加几次小文件读取；
 * 变化慢的数据（存储、网络类型）带缓存，不是每次都查。
 */
class SystemSampler(private val context: Context) {
    private val am = context.getSystemService(ActivityManager::class.java)
    private val bm = context.getSystemService(BatteryManager::class.java)
    private val pm = context.getSystemService(PowerManager::class.java)
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val ssm = context.getSystemService(StorageStatsManager::class.java)
    private val memInfo = ActivityManager.MemoryInfo()

    val freqCpu = FreqCpuSource()
    private val procStat = ProcStatCpu()
    private val thermal = ThermalZones()

    private var lastRx = -1L
    private var lastTx = -1L
    private var lastNetNs = 0L

    private var storageAt = 0L
    private var storageUsed = 0L
    private var storageTotal = 0L

    private var netTypeAt = 0L
    private var netType: String? = null

    @Synchronized
    fun sample(priv: IPrivileged?): MetricsSnapshot {
        val now = SystemClock.elapsedRealtime()

        var reading: CpuReading? = null
        var cpuTemp: Double? = null
        var skinTemp: Double? = null
        if (priv != null) {
            try {
                if (!thermal.discovered) thermal.discover(priv)
                val files = priv.readFiles((listOf("/proc/stat") + thermal.paths).toTypedArray())
                val stat = files?.getOrNull(0)
                if (stat != null) reading = procStat.update(stat)
                val temps = thermal.parse(files?.drop(1).orEmpty())
                cpuTemp = temps.first
                skinTemp = temps.second
            } catch (_: Exception) {
                // shell 进程被结束或 binder 断开：本次回退到频率估算
                procStat.reset()
                thermal.reset()
            }
        } else {
            procStat.reset()
        }
        if (reading == null) reading = freqCpu.sample()

        am.getMemoryInfo(memInfo)

        if (storageTotal == 0L || now - storageAt >= 60_000) {
            refreshStorage()
            storageAt = now
        }

        val (up, down) = netRates()
        if (netType == null || now - netTypeAt >= 10_000) {
            netType = networkType()
            netTypeAt = now
        }

        return MetricsSnapshot(
            at = System.currentTimeMillis(),
            cpu = reading?.usage,
            cpuKind = reading?.kind ?: CpuKind.NONE,
            cores = reading?.cores.orEmpty(),
            memUsed = memInfo.totalMem - memInfo.availMem,
            memTotal = memInfo.totalMem,
            storageUsed = storageUsed,
            storageTotal = storageTotal,
            netUp = up,
            netDown = down,
            netType = netType,
            battery = battery(),
            thermalStatus = pm.currentThermalStatus,
            cpuTempC = cpuTemp,
            skinTempC = skinTemp,
        )
    }

    private fun refreshStorage() {
        try {
            val total = ssm.getTotalBytes(StorageManager.UUID_DEFAULT)
            val free = ssm.getFreeBytes(StorageManager.UUID_DEFAULT)
            storageTotal = total
            storageUsed = total - free
        } catch (_: Exception) {
            val fs = StatFs(Environment.getDataDirectory().path)
            storageTotal = fs.totalBytes
            storageUsed = fs.totalBytes - fs.availableBytes
        }
    }

    private fun netRates(): Pair<Long, Long> {
        val rx = TrafficStats.getTotalRxBytes()
        val tx = TrafficStats.getTotalTxBytes()
        val ns = SystemClock.elapsedRealtimeNanos()
        var up = 0L
        var down = 0L
        if (lastRx >= 0 && rx >= 0 && ns > lastNetNs) {
            val dt = (ns - lastNetNs) / 1e9
            down = ((rx - lastRx).coerceAtLeast(0) / dt).toLong()
            up = ((tx - lastTx).coerceAtLeast(0) / dt).toLong()
        }
        lastRx = rx
        lastTx = tx
        lastNetNs = ns
        return up to down
    }

    private fun networkType(): String {
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "离线"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "移动数据"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "以太网"
            else -> "其他"
        }
    }

    private fun battery(): BatteryInfo? {
        val i = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED), Context.RECEIVER_NOT_EXPORTED)
            ?: return null
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        if (level < 0 || scale <= 0) return null
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            (plugged && status == BatteryManager.BATTERY_STATUS_FULL)
        val temp = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            .takeIf { it != Int.MIN_VALUE }?.let { it / 10.0 }
        val voltage = i.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1).takeIf { it > 0 }
        val currentMa = currentMa(charging)
        val power = if (voltage != null && currentMa != null) abs(voltage / 1000.0 * currentMa / 1000.0) else null
        val left = if (charging) bm.computeChargeTimeRemaining().takeIf { it > 0 } else null
        return BatteryInfo(level.toDouble() / scale, charging, plugged, temp, voltage, currentMa, power, left)
    }

    /** 规范是微安、充入为正；部分机型给毫安或符号相反，这里统一成毫安并按充放电状态定符号 */
    private fun currentMa(charging: Boolean): Int? {
        val raw = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
        if (raw == Int.MIN_VALUE || raw == 0) return null
        val magnitude = abs(raw.toLong())
        val ma = if (magnitude < 15_000) magnitude else magnitude / 1000
        return (if (charging) ma else -ma).toInt()
    }
}
