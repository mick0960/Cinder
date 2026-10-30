package com.cinder.mobile.shizuku

import android.content.Context
import androidx.annotation.Keep
import com.cinder.mobile.core.ProcessKiller
import com.cinder.mobile.core.SysFs
import java.io.File
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.system.exitProcess

/**
 * Shizuku UserService：运行在 Shizuku 拉起的独立进程里，身份是 shell（uid 2000）或 root。
 * 这个进程不是正常的 App 进程，没有 Application，不能用 CinderApp 里的任何东西。
 */
@Keep
class PrivilegedService() : IPrivileged.Stub() {

    /** Shizuku v13 优先调用带 Context 的构造函数 */
    @Keep
    @Suppress("UNUSED_PARAMETER")
    constructor(context: Context) : this()

    override fun destroy() {
        exitProcess(0)
    }

    override fun readFiles(paths: Array<out String>?): Array<String?> =
        Array(paths?.size ?: 0) { i -> SysFs.readText(paths!![i]) }

    override fun listDir(path: String?): Array<String> =
        path?.let { File(it).list() } ?: emptyArray()

    override fun exec(command: String?, timeoutMs: Long): Array<String> {
        val process = try {
            ProcessBuilder("/system/bin/sh", "-c", command.orEmpty()).start()
        } catch (e: Exception) {
            return arrayOf("-1", "", "启动失败: ${e.message}")
        }
        process.outputStream.close()
        val out = Collector(process.inputStream)
        val err = Collector(process.errorStream)
        val finished = process.waitFor(timeoutMs.coerceIn(500, 60_000), TimeUnit.MILLISECONDS)
        if (!finished) {
            ProcessKiller.killTree(process)
            return arrayOf("-1", out.text(), "超时 ($timeoutMs ms)")
        }
        return arrayOf(process.exitValue().toString(), out.text(), err.text())
    }

    /** 并发读取输出，避免子进程写满管道缓冲区后阻塞到超时 */
    private class Collector(input: InputStream) {
        private val buf = java.io.ByteArrayOutputStream()
        private val worker = thread(isDaemon = true) {
            input.use { s ->
                val chunk = ByteArray(8192)
                while (true) {
                    val n = try {
                        s.read(chunk)
                    } catch (_: Exception) {
                        -1
                    }
                    if (n <= 0) break
                    synchronized(buf) { if (buf.size() < LIMIT) buf.write(chunk, 0, minOf(n, LIMIT - buf.size())) }
                }
            }
        }

        fun text(): String {
            worker.join(500)
            return synchronized(buf) { buf.toString(Charsets.UTF_8.name()) }
        }
    }

    private companion object {
        const val LIMIT = 1024 * 1024
    }
}
