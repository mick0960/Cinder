package com.cinder.mobile.modules

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * 模块的 HTTP 白名单：manifest 里声明的 hosts、url 类参数的域名，
 * 以及 http 模块请求地址里直接写明的域名。其余域名一律拒绝，防止脚本把密钥发到别处。
 */
object HostPolicy {
    fun allowed(def: ModuleDef, values: Map<String, String>): Set<String> {
        val hosts = def.hosts.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toMutableSet()
        for (p in def.params) {
            if (p.type != "url") continue
            val v = values[p.key]?.takeIf { it.isNotBlank() } ?: p.default ?: continue
            v.trim().toHttpUrlOrNull()?.host?.let { hosts += it.lowercase() }
        }
        val url = def.request?.url?.trim().orEmpty()
        if (def.type == "http" && !url.substringBefore('?').substringBefore('#').let(::hostPart).contains("\${")) {
            url.toHttpUrlOrNull()?.host?.let { hosts += it.lowercase() }
        }
        return hosts
    }

    fun permits(host: String, allowed: Set<String>): Boolean {
        val h = host.lowercase()
        return allowed.any { a ->
            if (a.startsWith("*.")) h == a.substring(2) || h.endsWith(a.substring(1)) else h == a
        }
    }

    /** 校验并返回规范化的地址；不合法或不在白名单时抛出 */
    fun check(url: String, allowed: Set<String>): String {
        val parsed = url.trim().toHttpUrlOrNull() ?: throw ModuleRunException("地址无效：$url")
        if (!permits(parsed.host, allowed)) throw ModuleRunException("域名 ${parsed.host} 不在模块允许访问的列表里")
        return parsed.toString()
    }

    private fun hostPart(url: String): String = url.substringAfter("://", url).substringBefore('/')
}

/** 把字符串里的 ${params.key} 替换成参数值 */
object ParamTemplate {
    private val PATTERN = Regex("""\$\{params\.([A-Za-z_][A-Za-z0-9_]*)\}""")

    fun apply(template: String, values: Map<String, String>): String =
        PATTERN.replace(template) { values[it.groupValues[1]].orEmpty() }
}
