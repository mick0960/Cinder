package com.cinder.mobile.metrics

import com.cinder.mobile.core.SysFs
import java.io.File

data class CpuReading(val usage: Double, val cores: List<Double>, val kind: CpuKind)

/**
 * Android 8 起普通应用读不到 /proc/stat，这里退而求其次：
 * 各频率簇的 (当前 - 最低) / (最高 - 最低) 按核心数加权，作为"频率负载"。
 */
class FreqCpuSource {
    private class Policy(val curPath: String, val cpus: Int, val min: Long, val max: Long)

    private val policies: List<Policy> by lazy { discover() }

    val available: Boolean get() = policies.isNotEmpty()
    val clusterCount: Int get() = policies.size
    val coreCount: Int get() = policies.sumOf { it.cpus }

    fun sample(): CpuReading? {
        var weighted = 0.0
        var cpus = 0
        val clusters = ArrayList<Double>(policies.size)
        for (p in policies) {
            val cur = SysFs.readLong(p.curPath) ?: continue
            val r = if (p.max > p.min) ((cur - p.min).toDouble() / (p.max - p.min)).coerceIn(0.0, 1.0) else 0.0
            weighted += r * p.cpus
            cpus += p.cpus
            clusters += r
        }
        return if (cpus == 0) null else CpuReading(weighted / cpus, clusters, CpuKind.FREQ)
    }

    private fun discover(): List<Policy> {
        val root = "/sys/devices/system/cpu/cpufreq"
        val names = File(root).list()
            ?.filter { it.startsWith("policy") }
            ?.sortedBy { it.removePrefix("policy").toIntOrNull() ?: 0 }
        if (!names.isNullOrEmpty()) {
            val found = names.mapNotNull { policy("$root/$it") }
            if (found.isNotEmpty()) return found
        }
        // 目录不可列举时按核心逐个读
        return (0 until Runtime.getRuntime().availableProcessors()).mapNotNull {
            policy("/sys/devices/system/cpu/cpu$it/cpufreq", cpus = 1)
        }
    }

    private fun policy(base: String, cpus: Int? = null): Policy? {
        val count = cpus ?: SysFs.readText("$base/related_cpus")?.trim()
            ?.split(Regex("\\s+"))?.count { it.isNotEmpty() } ?: return null
        val max = SysFs.readLong("$base/cpuinfo_max_freq") ?: return null
        val min = SysFs.readLong("$base/cpuinfo_min_freq") ?: 0L
        val cur = "$base/scaling_cur_freq"
        if (SysFs.readLong(cur) == null) return null
        return Policy(cur, count.coerceAtLeast(1), min, max)
    }
}

/** 由两次 /proc/stat 的差值计算真实占用率（经 Shizuku 以 shell 身份读取） */
class ProcStatCpu {
    private var prev: LongArray? = null

    fun update(stat: String): CpuReading? {
        val lines = stat.lineSequence().filter { it.startsWith("cpu") }.toList()
        if (lines.isEmpty()) return null
        val cur = LongArray(lines.size * 2)
        lines.forEachIndexed { i, line ->
            val f = line.split(' ').filter { it.isNotEmpty() }
            // cpuN user nice system idle iowait irq softirq steal guest guest_nice；guest 已计入 user
            var total = 0L
            for (k in 1..minOf(8, f.size - 1)) total += f[k].toLongOrNull() ?: 0L
            val idle = (f.getOrNull(4)?.toLongOrNull() ?: 0L) + (f.getOrNull(5)?.toLongOrNull() ?: 0L)
            cur[i * 2] = total
            cur[i * 2 + 1] = idle
        }
        val p = prev
        prev = cur
        // 首次采样或核心上下线导致行数变化时，本次没有可用差值
        if (p == null || p.size != cur.size) return null
        fun usage(i: Int): Double {
            val dt = cur[i * 2] - p[i * 2]
            val di = cur[i * 2 + 1] - p[i * 2 + 1]
            return if (dt <= 0) 0.0 else (1.0 - di.toDouble() / dt).coerceIn(0.0, 1.0)
        }
        return CpuReading(usage(0), (1 until lines.size).map { usage(it) }, CpuKind.PROC_STAT)
    }

    fun reset() {
        prev = null
    }
}
