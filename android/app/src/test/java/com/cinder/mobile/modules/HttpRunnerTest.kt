package com.cinder.mobile.modules

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.charset.Charset

class HttpRunnerTest {
    private fun template(name: String) = ModulePackage.parse(File("src/main/assets/templates/$name.json").readText()).single()

    private fun run(def: ModuleDef, values: Map<String, String>, fetcher: HttpFetcher) = runBlocking {
        HttpRunner(fetcher).run(def, values, HostPolicy.allowed(def, values))
    }

    /** 对照桌面版 scripts/clash-traffic.ps1 的输出 */
    @Test
    fun clashTemplateMatchesDesktopScript() {
        val def = template("clash-traffic")
        val expire = System.currentTimeMillis() / 1000 + 10 * 86400 + 100
        val values = mapOf("url" to "https://sub.example.com/link?token=1")
        val out = run(def, values) { call ->
            assertEquals("HEAD", call.method)
            assertEquals("https://sub.example.com/link?token=1", call.url)
            assertEquals("clash-verge/v2.0.0", call.headers["User-Agent"])
            HttpResult(
                200,
                mapOf("subscription-userinfo" to "upload=1073741824; download=2147483648; total=10737418240; expire=$expire"),
                "",
                false,
            )
        }
        assertTrue(out.text, out.ok)
        assertEquals("3.0 / 10 GB (30.0%) · 剩 11 天", out.text)
        assertEquals(0.3, out.value!!, 1e-9)
        assertEquals("#4cd48a", out.color)
    }

    @Test
    fun clashTemplateReportsMissingHeader() {
        val def = template("clash-traffic")
        val e = assertThrows(ModuleRunException::class.java) {
            run(def, mapOf("url" to "https://sub.example.com/x")) { HttpResult(200, emptyMap(), "", false) }
        }
        assertEquals("响应头缺少 Subscription-Userinfo", e.message)
    }

    @Test
    fun withoutMapBodyIsTheOutput() {
        val def = ModuleDef(id = "h", name = "h", type = "http", format = "json", request = HttpRequestDef(url = "https://a.com/s"))
        val out = run(def, emptyMap()) { HttpResult(200, emptyMap(), """{"text":"ok","value":0.2}""", false) }
        assertEquals("ok", out.text)
        assertEquals(0.2, out.value!!, 1e-9)
    }

    @Test
    fun httpErrorStatus() {
        val def = ModuleDef(id = "h", name = "h", type = "http", request = HttpRequestDef(url = "https://a.com/s"))
        val e = assertThrows(ModuleRunException::class.java) { run(def, emptyMap()) { HttpResult(503, emptyMap(), "", false) } }
        assertEquals("HTTP 503", e.message)
    }

    @Test
    fun publicIpTemplate() {
        val out = run(template("public-ip"), emptyMap()) { HttpResult(200, emptyMap(), """{"ip":"1.2.3.4"}""", false) }
        assertEquals("1.2.3.4", out.text)
    }

    @Test
    fun okHttpFetcherHeadersBodyAndLimit() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().addHeader("X-Test", "A").setBody("你好"))
        server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(1_500_000) { 'a'.code.toByte() })))
        server.enqueue(MockResponse().setBody(Buffer().write("中文".toByteArray(Charset.forName("GBK")))))
        server.start()
        try {
            val fetcher = OkHttpFetcher(OkHttpClient())
            val first = fetcher.fetch(HttpCall("GET", server.url("/a").toString(), mapOf("K" to "v"), null, 5000))
            assertEquals(200, first.status)
            assertEquals("A", first.headers["x-test"])
            assertEquals("你好", first.body)
            assertFalse(first.truncated)
            assertEquals("v", server.takeRequest().getHeader("K"))

            val big = fetcher.fetch(HttpCall("GET", server.url("/b").toString(), emptyMap(), null, 5000))
            assertTrue(big.truncated)
            assertEquals(OkHttpFetcher.LIMIT.toInt(), big.body.length)

            val gbk = fetcher.fetch(HttpCall("GET", server.url("/c").toString(), emptyMap(), null, 5000))
            assertEquals("中文", gbk.body)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun networkErrorsAreTranslated() {
        val closed = java.net.ServerSocket(0).use { it.localPort }
        val e = assertThrows(ModuleRunException::class.java) {
            runBlocking { OkHttpFetcher(OkHttpClient()).fetch(HttpCall("GET", "http://127.0.0.1:$closed/", emptyMap(), null, 3000)) }
        }
        assertEquals("连接 127.0.0.1 失败", e.message)
        assertEquals("网络超时", networkError(java.net.SocketTimeoutException("timeout")))
        assertEquals(
            "无法解析域名 api.example.com",
            networkError(java.net.UnknownHostException("Unable to resolve host \"api.example.com\": No address associated with hostname")),
        )
    }
}
