package com.cinder.mobile.modules

import com.dokar.quickjs.QuickJsException
import com.dokar.quickjs.binding.asyncFunction
import com.dokar.quickjs.binding.define
import com.dokar.quickjs.binding.function
import com.dokar.quickjs.evaluate
import com.dokar.quickjs.quickJs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * 运行 script 模块：`export default async function (ctx) { … }`，返回 {text, value, color, items}
 * 或字符串。每次运行新建一个 QuickJS 运行时、跑完即释放，不常驻内存。
 *
 * 沙箱里只有我们提供的函数：ctx.params、ctx.http.request（受域名白名单限制）、ctx.store、ctx.log。
 */
class ScriptRunner(
    private val fetcher: HttpFetcher,
    private val store: ModuleKv,
) {
    suspend fun run(def: ModuleDef, values: Map<String, String>, allowed: Set<String>): ModuleOutput {
        val logs = ArrayList<String>()
        var returned: String? = null
        val (code, lineOffset) = buildCode(def.script.orEmpty(), values, store.get(def.id))
        try {
            withContext(Dispatchers.Default) {
                quickJs(Dispatchers.Default) {
                    memoryLimit = MEMORY_LIMIT
                    maxStackSize = STACK_LIMIT
                    define("console") {
                        function("log") { args -> log(logs, args) }
                    }
                    function("__log") { args -> log(logs, args) }
                    function("__return") { args -> returned = args.firstOrNull() as? String }
                    asyncFunction("__request") { args -> request(args.firstOrNull() as? String, def.timeoutMs, allowed) }
                    evaluate<Any?>(code, filename = FILENAME)
                }
            }
        } catch (e: QuickJsException) {
            throw ModuleRunException(scriptError(e, lineOffset))
        }
        val result = returned?.let { ModuleJson.parseToJsonElement(it).jsonObject }
            ?: throw ModuleRunException("脚本没有返回结果")
        (result["store"] as? JsonObject)?.let { store.put(def.id, it.toString()) }
        val output = when (result["kind"]?.jsonPrimitive?.content) {
            "object" -> (result["value"] as? JsonObject)?.let { OutputParser.fromJsonObject(def, it) }
            "string" -> OutputParser.parse(def, result["value"]?.jsonPrimitive?.content.orEmpty())
            "number", "boolean" -> OutputParser.parse(def.copy(format = "plain"), result["value"].toString())
            else -> null
        } ?: throw ModuleRunException("脚本返回值应为对象或字符串")
        return output.copy(logs = logs)
    }

    private suspend fun request(spec: String?, defaultTimeout: Long, allowed: Set<String>): String {
        val o = spec?.let { ModuleJson.parseToJsonElement(it).jsonObject } ?: JsonObject(emptyMap())
        val url = HostPolicy.check(o["url"]?.jsonPrimitive?.content.orEmpty(), allowed)
        val headers = (o["headers"] as? JsonObject)?.mapValues { it.value.jsonPrimitive.content }.orEmpty()
        val timeout = o["timeoutMs"]?.jsonPrimitive?.longOrNull ?: defaultTimeout
        val res = fetcher.fetch(
            HttpCall(
                method = o["method"]?.jsonPrimitive?.content ?: "GET",
                url = url,
                headers = headers,
                body = o["body"]?.let { if (it is JsonPrimitive) it.content else it.toString() },
                timeoutMs = timeout,
            )
        )
        return buildJsonObject {
            put("status", res.status)
            put("headers", JsonObject(res.headers.mapValues { JsonPrimitive(it.value) }))
            put("body", res.body)
            put("truncated", res.truncated)
        }.toString()
    }

    private fun log(logs: MutableList<String>, args: Array<Any?>) {
        if (logs.size < MAX_LOGS) logs += args.joinToString(" ") { it?.toString() ?: "null" }.take(500)
    }

    private fun scriptError(e: QuickJsException, lineOffset: Int): String {
        val msg = e.message?.lineSequence()?.firstOrNull()?.removePrefix("Error: ") ?: "脚本错误"
        val line = e.lineNumber?.takeIf { e.fileName == FILENAME }?.minus(lineOffset)?.takeIf { it > 0 }
        return if (line != null) "$msg（第 $line 行）" else msg
    }

    companion object {
        private const val FILENAME = "module.js"
        private const val MEMORY_LIMIT = 32L * 1024 * 1024
        private const val STACK_LIMIT = 512L * 1024
        private const val MAX_LOGS = 50

        private val EXPORT_DEFAULT = Regex("""\bexport\s+default\s+""")
        private val EXPORT_DECL = Regex("""(?m)^\s*export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\b)""")

        /**
         * 不用 ES 模块加载器：把 `export default` 改写成 `const __main =`，在全局脚本里用顶层 await 调用。
         * 没有 export default 时，整段代码当作 async 函数体（可以直接 return）。返回代码和行号偏移。
         */
        fun buildCode(script: String, values: Map<String, String>, storeJson: String): Pair<String, Int> {
            val withoutExports = EXPORT_DECL.replace(script, "")
            val (main, offset) = if (EXPORT_DEFAULT.containsMatchIn(withoutExports)) {
                EXPORT_DEFAULT.replaceFirst(withoutExports, "const __main = ") to 0
            } else {
                "const __main = async function (ctx) {\n$withoutExports\n};" to 1
            }
            val params = jsString(ModuleJson.encodeToString(kotlinx.serialization.json.JsonElement.serializer(),
                JsonObject(values.mapValues { JsonPrimitive(it.value) })))
            val storeData = jsString(storeJson)
            val runner = """
                |
                |;(async () => {
                |  const __data = JSON.parse($storeData);
                |  const __ctx = {
                |    params: Object.freeze(JSON.parse($params)),
                |    store: {
                |      get(k) { return Object.prototype.hasOwnProperty.call(__data, k) ? __data[k] : null; },
                |      set(k, v) { if (v === undefined || v === null) delete __data[k]; else __data[k] = v; },
                |    },
                |    log: (...a) => __log(...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))),
                |    http: {
                |      async request(o) {
                |        const r = JSON.parse(await __request(JSON.stringify(typeof o === 'string' ? { url: o } : (o || {}))));
                |        r.text = r.body;
                |        r.ok = r.status >= 200 && r.status < 300;
                |        r.json = () => JSON.parse(r.body);
                |        return r;
                |      },
                |      get(url, headers) { return this.request({ url, headers }); },
                |    },
                |  };
                |  const __out = await __main(__ctx);
                |  __return(JSON.stringify({ kind: __out === null || __out === undefined ? 'none' : typeof __out, value: __out === undefined ? null : __out, store: __data }));
                |})();
            """.trimMargin()
            return (main + runner) to offset
        }

        private fun jsString(s: String): String = ModuleJson.encodeToString(String.serializer(), s)
    }
}
