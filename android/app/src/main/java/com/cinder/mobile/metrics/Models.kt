package com.cinder.mobile.metrics

enum class CpuKind {
    /** 由各簇当前频率估算的负载（普通权限） */
    FREQ,

    /** /proc/stat 计算的真实占用率（Shizuku） */
    PROC_STAT,
    NONE,
}

data class BatteryInfo(
    /** 0..1 */
    val level: Double,
    val charging: Boolean,
    val plugged: Boolean,
    val tempC: Double?,
    val voltageMv: Int?,
    /** 正数为充入，负数为放出 */
    val currentMa: Int?,
    val powerW: Double?,
    val chargeLeftMs: Long?,
)

data class MetricsSnapshot(
    val at: Long,
    /** 0..1；拿不到时为 null */
    val cpu: Double?,
    val cpuKind: CpuKind,
    /** PROC_STAT 时为每个核心，FREQ 时为每个频率簇 */
    val cores: List<Double>,
    val memUsed: Long,
    val memTotal: Long,
    val storageUsed: Long,
    val storageTotal: Long,
    val netUp: Long,
    val netDown: Long,
    val netType: String?,
    val battery: BatteryInfo?,
    /** PowerManager.THERMAL_STATUS_*，0 为正常 */
    val thermalStatus: Int,
    val cpuTempC: Double?,
    val skinTempC: Double?,
) {
    val memRatio: Double get() = if (memTotal > 0) memUsed.toDouble() / memTotal else 0.0
    val storageRatio: Double get() = if (storageTotal > 0) storageUsed.toDouble() / storageTotal else 0.0
}

/** 图表用的滚动历史，与桌面 stores.ts 的 METRIC_HISTORY 一样保留 48 个点 */
data class MetricHistory(
    val cpu: List<Double> = emptyList(),
    val down: List<Long> = emptyList(),
    val up: List<Long> = emptyList(),
    /** 估算的采样间隔（毫秒） */
    val stepMs: Long = 1000,
) {
    companion object {
        const val POINTS = 48
    }
}
