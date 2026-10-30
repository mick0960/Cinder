package com.cinder.mobile.modules

import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant

class ScriptRunnerTest {
    private class MemKv : ModuleKv {
        val map = HashMap<String, String>()
        override fun get(id: String) = map[id] ?: "{}"
        override fun put(id: String, json: String) {
            map[id] = json
        }
        override fun delete(id: String) {
            map.remove(id)
        }
    }

    private val kv = MemKv()
    private val offline = HttpFetcher { error("不应访问网络") }

    private fun def(script: String, vararg hosts: String) =
        ModuleDef(id = "s", name = "s", type = "script", script = script, hosts = hosts.toList(), timeoutMs = 5000)

    private fun run(def: ModuleDef, values: Map<String, String> = emptyMap(), fetcher: HttpFetcher = offline) = runBlocking {
        ScriptRunner(fetcher, kv).run(def, values, HostPolicy.allowed(def, values))
    }

    @Test
    fun returnsObject() {
        val out = run(
            def("export default async function (ctx) { return { text: 'hi ' + ctx.params.name, value: 0.5, color: '#fff' } }"),
            mapOf("name" to "x"),
        )
        assertTrue(out.ok)
        assertTrue(out.fromJson)
        assertEquals("hi x", out.text)
        assertEquals(0.5, out.value!!, 1e-9)
        assertEquals("#fff", out.color)
    }

    @Test
    fun bodyWithoutExportDefault() {
        assertEquals("plain 3", run(def("const a = 1;\nreturn 'plain ' + (a + 2);")).text)
    }

    @Test
    fun stringResultFollowsFormat() {
        val out = run(def("return '42%'").copy(style = "progress"))
        assertEquals(0.42, out.value!!, 1e-9)
        val json = run(def("return JSON.stringify({ text: 'j', value: 0.1 })").copy(format = "json"))
        assertEquals("j", json.text)
    }

    @Test
    fun httpRequestThroughAllowList() {
        var seen: HttpCall? = null
        val fetcher = HttpFetcher { call ->
            seen = call
            HttpResult(200, mapOf("x-a" to "1"), """{"v":42}""", false)
        }
        val out = run(
            def(
                """
                export default async function (ctx) {
                  const r = await ctx.http.request({ url: 'https://api.example.com/x', headers: { a: 'b' }, method: 'POST', body: { q: 1 } });
                  return { text: String(r.json().v) + ' ' + r.headers['x-a'] + ' ' + r.ok };
                }
                """.trimIndent(),
                "api.example.com",
            ),
            fetcher = fetcher,
        )
        assertEquals("42 1 true", out.text)
        val call = seen!!
        assertEquals("https://api.example.com/x", call.url)
        assertEquals("POST", call.method)
        assertEquals("b", call.headers["a"])
        assertEquals("""{"q":1}""", call.body)
    }

    @Test
    fun blockedHostFails() {
        val e = assertThrows(ModuleRunException::class.java) {
            run(def("return (await ctx.http.get('https://evil.com/steal')).text"), fetcher = HttpFetcher { error("不应发出请求") })
        }
        assertTrue(e.message, e.message!!.contains("evil.com"))
    }

    @Test
    fun storePersistsAcrossRuns() {
        val d = def("const n = (ctx.store.get('n') || 0) + 1; ctx.store.set('n', n); return String(n);")
        assertEquals("1", run(d).text)
        assertEquals("2", run(d).text)
    }

    @Test
    fun logsAreCaptured() {
        val out = run(def("ctx.log('a', { b: 1 }); console.log('c'); return 'ok';"))
        assertEquals(listOf("a {\"b\":1}", "c"), out.logs)
    }

    @Test
    fun errorsReportUserLineNumber() {
        val e = assertThrows(ModuleRunException::class.java) {
            run(def("export default async function () {\n  const x = 1;\n  throw new Error('坏了');\n}"))
        }
        assertTrue(e.message, e.message!!.contains("坏了"))
        assertTrue(e.message, e.message!!.contains("第 3 行"))
    }

    @Test
    fun infiniteLoopIsInterruptedByTimeout() {
        val started = System.nanoTime()
        assertThrows(TimeoutCancellationException::class.java) {
            runBlocking { withTimeout(800) { ScriptRunner(offline, kv).run(def("while (true) {}"), emptyMap(), emptySet()) } }
        }
        assertTrue((System.nanoTime() - started) / 1_000_000 < 5_000)
    }

    /** 对照桌面版 scripts/sub2api-usage.ps1 的输出 */
    @Test
    fun sub2apiTemplateMatchesDesktopScript() {
        val def = ModulePackage.parse(File("src/main/assets/templates/sub2api-usage.json").readText()).single()
        val resets = Instant.ofEpochMilli(System.currentTimeMillis() + 2 * 3600_000L + 5 * 60_000L + 30_000).toString()
        val fetcher = HttpFetcher { call ->
            assertEquals("k1", call.headers["x-api-key"])
            val path = call.url.removePrefix("https://ai.example.cn/api/v1/admin")
            val body = when {
                path.startsWith("/accounts?page=1") -> """{"code":0,"data":{"total":3,"items":[
                    {"id":1,"name":"A","status":"active","platform":"anthropic"},
                    {"id":2,"name":"B","status":"paused","platform":"opencode_go"},
                    {"id":3,"name":"C","status":"active","platform":"other"}]}}"""
                path == "/accounts/usage/batch" -> {
                    assertEquals("""{"account_ids":[1,2,3]}""", call.body)
                    """{"code":0,"data":{"usage":{"1":{"five_hour":{"utilization":45,"remaining_seconds":3700},
                        "seven_day":{"utilization":90,"remaining_seconds":200000}}},"errors":{"3":"不支持"}}}"""
                }
                path == "/accounts/2/opencode-go-usage" -> """{"code":0,"data":{"snapshot":{"data":{
                    "rolling":{"status":"ok","percent":20,"resets_at":"$resets"},"weekly":{"status":"limited"}}}}}"""
                else -> error("unexpected $path")
            }
            HttpResult(200, emptyMap(), body, false)
        }
        val out = run(def, mapOf("key" to "k1", "baseUrl" to "https://ai.example.cn/"), fetcher)
        assertEquals("3 个账号", out.text)
        assertEquals(0.9, out.value!!, 1e-9)
        val items = out.items!!.map { listOf(it.group, it.label, it.text) }
        assertEquals(
            listOf(
                listOf("A", "5h", "45% · 1时1分"),
                listOf("A", "7d", "90% · 2天7时"),
                listOf("B（paused）", "滚动", "20% · 2时5分"),
                listOf("B（paused）", "—", "周：limited"),
                listOf("C", "—", "不支持"),
            ),
            items,
        )
    }
}
