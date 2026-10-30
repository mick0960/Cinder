package com.cinder.mobile.modules

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 读取各种来源的模块包文本，交给 ModulePackage.parse */
object ModuleImporter {
    private const val LIMIT = 1024 * 1024

    suspend fun readUri(context: Context, uri: Uri): String = withContext(Dispatchers.IO) {
        context.contentResolver.openInputStream(uri)?.use { input ->
            val bytes = input.readNBytesCompat(LIMIT + 1)
            if (bytes.size > LIMIT) throw ModuleFormatException("文件超过 1 MB")
            decode(bytes)
        } ?: throw ModuleFormatException("无法读取文件")
    }

    suspend fun readUrl(fetcher: HttpFetcher, url: String): String {
        if (!url.trim().startsWith("https://", ignoreCase = true)) throw ModuleFormatException("只支持 https 链接")
        val res = fetcher.fetch(HttpCall("GET", url.trim(), emptyMap(), null, 15_000))
        if (res.status !in 200..299) throw ModuleFormatException("下载失败：HTTP ${res.status}")
        if (res.truncated) throw ModuleFormatException("文件超过 1 MB")
        return res.body
    }

    /** 内置模板（assets/templates） */
    fun templates(context: Context): List<ModuleDef> =
        context.assets.list("templates").orEmpty().sorted().flatMap { name ->
            try {
                ModulePackage.parse(context.assets.open("templates/$name").bufferedReader().use { it.readText() })
            } catch (_: Exception) {
                emptyList()
            }
        }

    private fun java.io.InputStream.readNBytesCompat(max: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (out.size() < max) {
            val n = read(buf, 0, minOf(buf.size, max - out.size()))
            if (n <= 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }
}
