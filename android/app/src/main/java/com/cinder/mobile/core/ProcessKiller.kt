package com.cinder.mobile.core

import android.system.Os
import android.system.OsConstants

/**
 * 超时时结束整棵子进程树。只杀 sh 本身的话，它启动的 ping 等子进程会变成孤儿继续运行
 * （桌面版用 taskkill /T 解决同一问题）。
 */
object ProcessKiller {
    fun killTree(process: Process) {
        val pid = pidOf(process)
        if (pid != null) {
            for (child in descendants(pid)) {
                try {
                    Os.kill(child, OsConstants.SIGKILL)
                } catch (_: Exception) {
                }
            }
        }
        process.destroyForcibly()
    }

    private fun pidOf(process: Process): Int? {
        try {
            return (process.javaClass.getMethod("pid").invoke(process) as Long).toInt()
        } catch (_: Exception) {
        }
        return try {
            val f = process.javaClass.getDeclaredField("pid")
            f.isAccessible = true
            f.getInt(process)
        } catch (_: Exception) {
            null
        }
    }

    /** 由 /proc/<pid>/stat 的父进程字段建树；只看得到同 uid 的进程，正好就是我们启动的那些 */
    private fun descendants(root: Int): List<Int> {
        val parentOf = HashMap<Int, Int>()
        val dirs = java.io.File("/proc").list() ?: return emptyList()
        for (name in dirs) {
            val pid = name.toIntOrNull() ?: continue
            val stat = SysFs.readText("/proc/$pid/stat", 512) ?: continue
            // 格式：pid (comm) state ppid …，comm 里可能有空格，从最后一个 ')' 之后解析
            val rest = stat.substringAfterLast(')').trim().split(' ')
            val ppid = rest.getOrNull(1)?.toIntOrNull() ?: continue
            parentOf[pid] = ppid
        }
        val result = ArrayList<Int>()
        val queue = ArrayDeque(listOf(root))
        while (queue.isNotEmpty()) {
            val p = queue.removeFirst()
            for ((child, parent) in parentOf) {
                if (parent == p && child !in result) {
                    result += child
                    queue += child
                }
            }
        }
        // 先杀叶子，避免父进程在被杀前又拉起新的子进程
        return result.asReversed()
    }
}
