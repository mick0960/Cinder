package com.cinder.mobile.modules

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * 模块包：一个 JSON 对象（单个模块），或 {"modules": [...]} / 数组（多个模块）。
 * 顶层的 "cinderModule": 1 标明格式版本。
 */
object ModulePackage {
    const val FORMAT = 1

    private val TYPES = setOf("script", "http", "command")
    private val STYLES = setOf("text", "progress", "sparkline")
    private val FORMATS = setOf("plain", "json")
    private val METHODS = setOf("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE")
    private val DESKTOP_SHELLS = setOf("powershell", "pwsh", "cmd", "direct")
    private val KEY = Regex("[A-Za-z_][A-Za-z0-9_]*")

    fun parse(text: String): List<ModuleDef> {
        val root = try {
            ModuleJson.parseToJsonElement(text.trim().removePrefix("﻿"))
        } catch (e: Exception) {
            throw ModuleFormatException("不是有效的 JSON")
        }
        val objects: List<JsonObject> = when (root) {
            is JsonArray -> root.map { it as? JsonObject ?: throw ModuleFormatException("数组里只能是模块对象") }
            is JsonObject -> (root["modules"] as? JsonArray)
                ?.map { it as? JsonObject ?: throw ModuleFormatException("modules 里只能是模块对象") }
                ?: listOf(root)
            else -> throw ModuleFormatException("不是模块包")
        }
        if (objects.isEmpty()) throw ModuleFormatException("模块包是空的")
        val format = (root as? JsonObject)?.get("cinderModule")?.let { (it as? JsonPrimitive)?.content?.toIntOrNull() }
        if (format != null && format > FORMAT) throw ModuleFormatException("模块包格式版本 $format 过新，请升级 Cinder")

        return objects.map { obj ->
            val def = try {
                ModuleJson.decodeFromJsonElement(ModuleDef.serializer(), withInferredType(obj))
            } catch (e: Exception) {
                throw ModuleFormatException("字段格式不对：${e.message?.lineSequence()?.firstOrNull()}")
            }
            val problem = validate(def).firstOrNull()
            if (problem != null) throw ModuleFormatException("「${def.name.ifBlank { "未命名模块" }}」$problem")
            def
        }
    }

    /** 返回所有问题，空列表表示合法 */
    fun validate(def: ModuleDef): List<String> {
        val errors = ArrayList<String>()
        if (def.name.isBlank()) errors += "缺少名称"
        if (def.type == "command" && def.shell in DESKTOP_SHELLS) {
            errors += "是桌面版的 ${def.shell} 命令模块，无法在 Android 上运行，请改写为 sh 命令、JS 脚本或 HTTP 模块"
        }
        if (def.type !in TYPES) errors += "类型 ${def.type} 不支持（可用 script、http、command）"
        when (def.type) {
            "script" -> if (def.script.isNullOrBlank()) errors += "缺少脚本代码"
            "http" -> {
                val req = def.request
                if (req == null || req.url.isBlank()) errors += "缺少请求地址"
                else if (req.method.uppercase() !in METHODS) errors += "请求方法 ${req.method} 不支持"
            }
            "command" -> {
                if (def.command.isNullOrBlank()) errors += "缺少命令"
                if (def.shell !in setOf("sh", "shizuku") && def.shell !in DESKTOP_SHELLS) errors += "shell 只能是 sh 或 shizuku"
            }
        }
        if (def.style !in STYLES) errors += "展示样式 ${def.style} 不支持"
        if (def.format !in FORMATS) errors += "输出格式 ${def.format} 不支持"
        if (def.intervalMs < 1000) errors += "刷新间隔不能小于 1000 毫秒"
        if (def.timeoutMs !in 500..60_000) errors += "超时需在 500–60000 毫秒之间"
        val keys = def.params.map { it.key }
        keys.firstOrNull { !KEY.matches(it) }?.let { errors += "参数名 $it 不合法" }
        if (keys.size != keys.toSet().size) errors += "参数名重复"
        return errors
    }

    /** 补齐 id：缺失时生成；与已有模块冲突时由调用方决定覆盖还是另存 */
    fun withId(def: ModuleDef): ModuleDef =
        if (def.id.isNotBlank()) def else def.copy(id = newId())

    fun newId(): String = "m" + UUID.randomUUID().toString().replace("-", "").take(10)

    /** 导出：只带定义，不带用户填写的参数值（可能含密钥） */
    fun export(defs: List<ModuleDef>): String {
        val elements = defs.map { ModuleJson.encodeToJsonElement(ModuleDef.serializer(), it).jsonObject }
        val root: JsonElement = if (elements.size == 1) {
            buildJsonObject {
                put("cinderModule", FORMAT)
                elements[0].forEach { (k, v) -> put(k, v) }
            }
        } else {
            buildJsonObject {
                put("cinderModule", FORMAT)
                put("modules", JsonArray(elements))
            }
        }
        return PrettyModuleJson.encodeToString(JsonElement.serializer(), root)
    }

    /** 没写 type 时按字段推断（兼容桌面版 config.json 里的 command 模块，以便给出明确提示） */
    private fun withInferredType(obj: JsonObject): JsonObject {
        if (obj.containsKey("type")) return obj
        val type = when {
            obj.containsKey("request") -> "http"
            obj.containsKey("command") -> "command"
            else -> "script"
        }
        return JsonObject(obj + ("type" to JsonPrimitive(type)))
    }
}
