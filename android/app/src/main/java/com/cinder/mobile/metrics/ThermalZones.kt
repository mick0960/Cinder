package com.cinder.mobile.metrics

import com.cinder.mobile.shizuku.IPrivileged

/**
 * 温度节点在普通权限下通常读不到，经 Shizuku 读取。首次使用时按 type 选出
 * CPU 传感器（取最大值）和机身表面传感器，之后每次只读这些 temp 文件。
 */
class ThermalZones {
    private var cpuPaths: List<String> = emptyList()
    private var skinPath: String? = null
    var discovered = false
        private set

    val paths: List<String> get() = cpuPaths + listOfNotNull(skinPath)

    fun discover(priv: IPrivileged) {
        val base = "/sys/class/thermal"
        val zones = priv.listDir(base)?.filterNotNull()?.filter { it.startsWith("thermal_zone") }.orEmpty()
        val types = priv.readFiles(zones.map { "$base/$it/type" }.toTypedArray()) ?: emptyArray()
        val cpu = ArrayList<String>()
        val fallbackCpu = ArrayList<String>()
        var skin: String? = null
        zones.forEachIndexed { i, zone ->
            val type = types.getOrNull(i)?.trim()?.lowercase() ?: return@forEachIndexed
            val path = "$base/$zone/temp"
            when {
                type.startsWith("cpu-") || type.startsWith("cpu_") && type.endsWith("usr") -> cpu += path
                type == "cpu_therm" || type.startsWith("cpuss") || type == "soc_thermal" -> fallbackCpu += path
                skin == null && (type == "quiet_therm" || type.contains("skin") || type == "shell_therm" || type == "board_therm") -> skin = path
            }
        }
        cpuPaths = cpu.ifEmpty { fallbackCpu }
        skinPath = skin
        discovered = true
    }

    /** values 与 paths 一一对应 */
    fun parse(values: List<String?>): Pair<Double?, Double?> {
        val n = cpuPaths.size
        val cpu = values.take(n).mapNotNull { celsius(it) }.maxOrNull()
        val skin = if (skinPath != null) celsius(values.getOrNull(n)) else null
        return cpu to skin
    }

    fun reset() {
        discovered = false
        cpuPaths = emptyList()
        skinPath = null
    }

    companion object {
        /** 不同驱动的单位不同：毫摄氏度、0.1 摄氏度或摄氏度 */
        fun celsius(raw: String?): Double? {
            val v = raw?.trim()?.toLongOrNull() ?: return null
            val c = when {
                kotlin.math.abs(v) >= 1000 -> v / 1000.0
                kotlin.math.abs(v) >= 200 -> v / 10.0
                else -> v.toDouble()
            }
            return c.takeIf { it in -30.0..150.0 }
        }
    }
}
