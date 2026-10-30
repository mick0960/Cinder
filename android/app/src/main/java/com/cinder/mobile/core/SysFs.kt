package com.cinder.mobile.core

import java.io.FileInputStream

/** 读 /proc、/sys 下的小文件：这些文件的 length 为 0，只能循环读到 EOF */
object SysFs {
    fun readText(path: String, max: Int = 64 * 1024): String? = try {
        FileInputStream(path).use { input ->
            val buf = ByteArray(minOf(max, 8192))
            val out = java.io.ByteArrayOutputStream()
            while (out.size() < max) {
                val n = input.read(buf, 0, minOf(buf.size, max - out.size()))
                if (n <= 0) break
                out.write(buf, 0, n)
            }
            out.toString(Charsets.UTF_8.name())
        }
    } catch (_: Exception) {
        null
    }

    fun readLong(path: String): Long? = readText(path, 64)?.trim()?.toLongOrNull()
}
