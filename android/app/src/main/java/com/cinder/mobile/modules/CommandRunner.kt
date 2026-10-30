package com.cinder.mobile.modules

import com.cinder.mobile.core.ProcessKiller
import com.cinder.mobile.shizuku.ShizukuManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 运行 command 模块：stdout 就是输出，语义同桌面版命令模块。
 * 参数以环境变量 CINDER_PARAM_<KEY> 传入（也可以在命令里写 ${params.key}）。
 */
class CommandRunner(private val shizuku: ShizukuManager) {

    suspend fun run(def: ModuleDef, values: Map<String, String>): String {
        val command = ParamTemplate.apply(def.command.orEmpty(), values)
        val env = values.mapKeys { "CINDER_PARAM_" + it.key.uppercase() }
        return when (def.shell) {
            "shizuku" -> privileged(command, env, def.timeoutMs)
            else -> local(command, env, def.timeoutMs)
        }
    }

    private suspend fun local(command: String, env: Map<String, String>, timeoutMs: Long): String =
        runInterruptible(Dispatchers.IO) {
            val process = try {
                ProcessBuilder("/system/bin/sh", "-c", command).apply { environment().putAll(env) }.start()
            } catch (e: Exception) {
                throw ModuleRunException("启动失败: ${e.message}")
            }
            try {
                process.outputStream.close()
                val out = Collector(process.inputStream)
                val err = Collector(process.errorStream)
                if (!process.waitFor(timeoutMs.coerceIn(500, 60_000), TimeUnit.MILLISECONDS)) {
                    throw ModuleRunException("超时 ($timeoutMs ms)")
                }
                val code = process.exitValue()
                if (code != 0) throw ModuleRunException(exitMessage(code, err.text()))
                decode(out.bytes())
            } finally {
                // 正常结束时进程树已退出；超时或协程被取消时在这里结束整棵树
                if (process.isAlive) ProcessKiller.killTree(process)
            }
        }

    private suspend fun privileged(command: String, env: Map<String, String>, timeoutMs: Long): String {
        if (shizuku.state.value != ShizukuManager.State.READY) throw ModuleRunException("需要 Shizuku：未运行或未授权")
        val exports = env.entries.joinToString("") { (k, v) -> "export $k=${shellQuote(v)}; " }
        val result = shizuku.withService(5_000) { it.exec(exports + command, timeoutMs) }
            ?: throw ModuleRunException("连接 Shizuku 超时")
        val code = result.getOrNull(0)?.toIntOrNull() ?: -1
        if (code != 0) throw ModuleRunException(if (code == -1) result.getOrNull(2) ?: "执行失败" else exitMessage(code, result.getOrNull(2).orEmpty()))
        return result.getOrNull(1).orEmpty()
    }

    private fun exitMessage(code: Int, stderr: String): String {
        val first = stderr.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
        return if (first != null) "退出码 $code：${first.take(120)}" else "退出码 $code"
    }

    private fun shellQuote(s: String): String = "'" + s.replace("'", "'\\''") + "'"

    private class Collector(input: InputStream) {
        private val buf = ByteArrayOutputStream()
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

        fun bytes(): ByteArray {
            worker.join(500)
            return synchronized(buf) { buf.toByteArray() }
        }

        fun text(): String = decode(bytes())
    }

    private companion object {
        const val LIMIT = 1024 * 1024
    }
}
