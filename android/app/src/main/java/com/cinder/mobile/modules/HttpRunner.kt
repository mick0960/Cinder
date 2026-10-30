package com.cinder.mobile.modules

import com.dokar.quickjs.QuickJsException
import com.dokar.quickjs.binding.function
import com.dokar.quickjs.evaluate
import com.dokar.quickjs.quickJs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 运行 http 模块：按声明发请求；没有 map 时响应体就是输出（相当于命令的 stdout），
 * 有 map 时在一个没有任何宿主函数的 QuickJS 里对 text / value / color 表达式求值。
 */
class HttpRunner(private val fetcher: HttpFetcher) {

    suspend fun run(def: ModuleDef, values: Map<String, String>, allowed: Set<String>): ModuleOutput {
        val req = def.request ?: throw ModuleRunException("缺少请求定义")
        val url = HostPolicy.check(ParamTemplate.apply(req.url, values), allowed)
        val res = fetcher.fetch(
            HttpCall(
                method = req.method,
                url = url,
                headers = req.headers.mapValues { ParamTemplate.apply(it.value, values) },
                body = req.body?.let { ParamTemplate.apply(it, values) },
                timeoutMs = def.timeoutMs,
            )
        )
        if (res.status !in 200..399) throw ModuleRunException("HTTP ${res.status}")
        val map = def.map
        if (map == null || map.isEmpty) return OutputParser.parse(def, res.body)
        val json = Expressions.evaluate(map, res, values)
        return OutputParser.parseJson(def, json)
    }
}

object Expressions {
    private const val FILENAME = "map.js"

    /** 表达式里可用的辅助函数 */
    private const val HELPERS = """
const kv = (s) => { const o = {}; for (const part of String(s ?? '').split(/[;&]/)) { const i = part.indexOf('='); if (i <= 0) continue; const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim(); const n = Number(v); o[k] = v !== '' && Number.isFinite(n) ? n : v; } return o; };
const need = (v, msg) => { if (v === undefined || v === null || v === '') throw new Error(msg || '缺少数据'); return v; };
const fmtBytes = (n, d = 1) => { const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; n = Number(n) || 0; while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i === 0 ? String(Math.round(n)) : n.toFixed(d)) + ' ' + u[i]; };
const pct = (r, d = 0) => (Number(r) * 100).toFixed(d) + '%';
"""

    suspend fun evaluate(map: HttpMapDef, res: HttpResult, values: Map<String, String>): String {
        var returned: String? = null
        val code = buildString {
            append("(() => {\n")
            append("const status = ").append(res.status).append(";\n")
            append("const body = ").append(js(res.body)).append(";\n")
            append("let json = null; try { json = JSON.parse(body); } catch (e) {}\n")
            append("const headers = JSON.parse(").append(js(obj(res.headers))).append(");\n")
            append("const params = JSON.parse(").append(js(obj(values))).append(");\n")
            append(HELPERS)
            map.vars?.takeIf { it.isNotBlank() }?.let { append(it).append("\n;\n") }
            append("const __o = {};\n")
            map.text?.takeIf { it.isNotBlank() }?.let { append("__o.text = String((").append(it).append("));\n") }
            map.value?.takeIf { it.isNotBlank() }?.let { append("__o.value = Number((").append(it).append("));\n") }
            map.color?.takeIf { it.isNotBlank() }?.let { append("__o.color = (").append(it).append(");\n") }
            append("__return(JSON.stringify(__o));\n")
            append("})();\n")
        }
        try {
            withContext(Dispatchers.Default) {
                quickJs(Dispatchers.Default) {
                    memoryLimit = 16L * 1024 * 1024
                    function("__return") { args -> returned = args.firstOrNull() as? String }
                    evaluate<Any?>(code, filename = FILENAME)
                }
            }
        } catch (e: QuickJsException) {
            throw ModuleRunException(e.message?.lineSequence()?.firstOrNull()?.removePrefix("Error: ") ?: "表达式错误")
        }
        return returned ?: throw ModuleRunException("表达式没有结果")
    }

    private fun obj(m: Map<String, String>): String =
        ModuleJson.encodeToString(JsonElement.serializer(), JsonObject(m.mapValues { JsonPrimitive(it.value) }))

    private fun js(s: String): String = ModuleJson.encodeToString(String.serializer(), s)
}
