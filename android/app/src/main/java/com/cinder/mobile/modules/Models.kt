package com.cinder.mobile.modules

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** 导入时让用户填写的参数，例如订阅链接、API Key */
@Serializable
data class ModuleParam(
    val key: String,
    val label: String = key,
    /** string | url | number；url 类参数的域名自动加入 HTTP 白名单 */
    val type: String = "string",
    /** 界面打码，导出时不带值 */
    val secret: Boolean = false,
    val required: Boolean = false,
    val default: String? = null,
    val placeholder: String? = null,
)

@Serializable
data class HttpRequestDef(
    val method: String = "GET",
    val url: String = "",
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
)

/** http 模块的映射：每项是一行 JS 表达式；vars 是表达式之前执行的语句，用来定义中间变量 */
@Serializable
data class HttpMapDef(
    val vars: String? = null,
    val text: String? = null,
    val value: String? = null,
    val color: String? = null,
) {
    val isEmpty: Boolean get() = text.isNullOrBlank() && value.isNullOrBlank() && color.isNullOrBlank()
}

/**
 * 模块定义（模块包里的一个模块）。公共字段与桌面版 ModuleConfig 同名同默认值，
 * 输出协议也相同：纯文本，或 {text, value, color, items}。
 */
@Serializable
data class ModuleDef(
    val id: String = "",
    /** script | http | command */
    val type: String = "script",
    val name: String = "",
    val description: String? = null,
    val version: String? = null,
    val author: String? = null,
    /** text | progress | sparkline */
    val style: String = "text",
    /** plain | json（script 返回对象、http 带 map 时总是按 JSON 处理） */
    val format: String = "plain",
    val intervalMs: Long = 5000,
    val timeoutMs: Long = 3000,
    val color: String? = null,
    val unit: String? = null,
    val params: List<ModuleParam> = emptyList(),
    val hosts: List<String> = emptyList(),
    val script: String? = null,
    val request: HttpRequestDef? = null,
    val map: HttpMapDef? = null,
    val command: String? = null,
    /** sh：应用权限；shizuku：经 Shizuku 以 shell 身份执行 */
    val shell: String = "sh",
)

/** 已安装的模块：定义 + 用户填写的参数值和开关 */
@Serializable
data class InstalledModule(
    val def: ModuleDef,
    val values: Map<String, String> = emptyMap(),
    val enabled: Boolean = true,
    /** 是否显示在"自定义模块"小部件里 */
    val widget: Boolean = true,
    /** 从链接导入时记录来源 */
    val source: String? = null,
) {
    val id: String get() = def.id

    /** 参数值，未填写的用默认值补齐 */
    fun effectiveValues(): Map<String, String> =
        def.params.associate { p -> p.key to (values[p.key]?.takeIf { it.isNotEmpty() } ?: p.default.orEmpty()) } +
            values.filterKeys { k -> def.params.none { it.key == k } }
}

@Serializable
data class ModuleItem(
    /** 相邻条目 group 相同时只显示一次分组标题 */
    val group: String? = null,
    val label: String = "",
    val text: String = "",
    val value: Double? = null,
    val color: String? = null,
)

data class ModuleOutput(
    val id: String,
    val ok: Boolean,
    val text: String,
    val value: Double?,
    val color: String?,
    val items: List<ModuleItem>? = null,
    /** 来自 JSON / 对象时，进度条样式优先显示 text（同桌面"JSON 输出自带 text 时优先显示"） */
    val fromJson: Boolean = false,
    val ms: Long = 0,
    val at: Long = System.currentTimeMillis(),
    /** 脚本里 ctx.log 的输出，只在"测试运行"时展示 */
    val logs: List<String> = emptyList(),
)

class ModuleRunException(message: String) : Exception(message)

class ModuleFormatException(message: String) : Exception(message)

val ModuleJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    encodeDefaults = false
}

val PrettyModuleJson = Json(from = ModuleJson) {
    prettyPrint = true
    prettyPrintIndent = "  "
}
