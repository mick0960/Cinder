package com.cinder.mobile.modules

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class HttpCall(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String?,
    val timeoutMs: Long,
)

data class HttpResult(
    val status: Int,
    /** 头名统一小写，多个值用 ", " 连接 */
    val headers: Map<String, String>,
    val body: String,
    val truncated: Boolean,
)

fun interface HttpFetcher {
    suspend fun fetch(call: HttpCall): HttpResult
}

class OkHttpFetcher(private val client: OkHttpClient) : HttpFetcher {
    override suspend fun fetch(call: HttpCall): HttpResult {
        val method = call.method.uppercase()
        val contentType = call.headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value
            ?.toMediaTypeOrNull()
        val body = when (method) {
            "GET", "HEAD" -> null
            else -> (call.body ?: "").toRequestBody(contentType)
        }
        val request = Request.Builder().url(call.url).apply {
            call.headers.forEach { (k, v) -> header(k, v) }
            method(method, body)
        }.build()
        val okCall = client.newCall(request)
        okCall.timeout().timeout(call.timeoutMs.coerceIn(500, 60_000), TimeUnit.MILLISECONDS)
        val raw = try {
            okCall.await()
        } catch (e: IOException) {
            throw ModuleRunException(networkError(e))
        }
        return raw.use { response ->
            val headers = response.headers.names().associate { name ->
                name.lowercase() to response.headers.values(name).joinToString(", ")
            }
            val buffer = Buffer()
            val source = response.body.source()
            var total = 0L
            while (total < LIMIT) {
                val n = source.read(buffer, minOf(8192L, LIMIT - total))
                if (n == -1L) break
                total += n
            }
            val truncated = total >= LIMIT && !source.exhausted()
            val charset = response.body.contentType()?.charset()
            HttpResult(response.code, headers, decode(buffer.readByteArray(), charset), truncated)
        }
    }

    companion object {
        const val LIMIT = 1024L * 1024
    }
}

/** 把 OkHttp / JDK 的网络异常翻译成面板里看得懂的中文 */
fun networkError(e: IOException): String {
    val host = e.message?.let { m ->
        // OkHttp："Failed to connect to api.example.com/1.2.3.4:443"；Android："Unable to resolve host "api.example.com": …"
        Regex("""(?:connect to /?|host ")([A-Za-z0-9.-]+)""").find(m)?.groupValues?.get(1)
    }
    return when (e) {
        is UnknownHostException -> "无法解析域名 ${host ?: e.message.orEmpty()}".trim()
        is SocketTimeoutException -> "网络超时"
        is ConnectException -> if (host != null) "连接 $host 失败" else "连接失败"
        is SSLException -> "TLS 握手失败"
        is InterruptedIOException -> "网络超时"
        else -> "网络错误：${e.message ?: e.javaClass.simpleName}"
    }
}

/** 与桌面版 decode.rs 一样：先按 UTF-8，失败再按 GBK（国内不少接口和命令输出是 GBK） */
fun decode(bytes: ByteArray, declared: Charset? = null): String {
    if (declared != null && declared != Charsets.UTF_8) return String(bytes, declared)
    return try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: Exception) {
        try {
            String(bytes, Charset.forName("GBK"))
        } catch (_: Exception) {
            String(bytes, Charsets.UTF_8)
        }
    }
}

suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, value, _ -> value.close() }
        }
    })
}
