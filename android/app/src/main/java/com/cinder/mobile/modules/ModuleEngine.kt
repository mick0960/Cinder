package com.cinder.mobile.modules

import android.os.SystemClock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

/** 按类型分发并统一处理超时和错误：任何失败都变成 ok=false 的输出（面板里显示"—"） */
class ModuleEngine(
    private val script: ScriptRunner,
    private val http: HttpRunner,
    private val command: CommandRunner,
) {
    suspend fun run(module: InstalledModule): ModuleOutput {
        val def = module.def
        val values = module.effectiveValues()
        val started = SystemClock.elapsedRealtime()
        val timeout = def.timeoutMs.coerceIn(500, 60_000)
        val output = try {
            missingParam(def, values)?.let { throw ModuleRunException("参数「$it」未填写") }
            val allowed = HostPolicy.allowed(def, values)
            // 运行器内部各自有超时，这里再兜底，保证一个模块卡死不会拖住调度
            withTimeout(timeout + 1_000) {
                when (def.type) {
                    "script" -> script.run(def, values, allowed)
                    "http" -> http.run(def, values, allowed)
                    "command" -> OutputParser.parse(def, command.run(def, values))
                    else -> throw ModuleRunException("不支持的模块类型 ${def.type}")
                }
            }
        } catch (_: TimeoutCancellationException) {
            OutputParser.error(def, "超时 ($timeout ms)")
        } catch (e: CancellationException) {
            throw e
        } catch (e: ModuleRunException) {
            OutputParser.error(def, e.message ?: "运行失败")
        } catch (e: Exception) {
            OutputParser.error(def, e.message ?: e.javaClass.simpleName)
        }
        return output.copy(id = def.id, ms = SystemClock.elapsedRealtime() - started)
    }

    private fun missingParam(def: ModuleDef, values: Map<String, String>): String? =
        def.params.firstOrNull { it.required && values[it.key].isNullOrBlank() }?.label
}
