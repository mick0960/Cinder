package com.cinder.mobile.modules

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** 移植自桌面版 src-tauri/src/modules/mod.rs 的 parse_output / parse_value，规则保持一致 */
object OutputParser {
    fun parse(def: ModuleDef, raw: String): ModuleOutput {
        if (def.format == "json") return parseJson(def, raw)
        val text = raw.trim()
        val value = if (def.style == "progress" || def.style == "sparkline") parseValue(text) else null
        return ModuleOutput(def.id, ok = true, text = text, value = value, color = def.color)
    }

    fun parseJson(def: ModuleDef, raw: String): ModuleOutput {
        val element = try {
            ModuleJson.parseToJsonElement(raw.trim())
        } catch (_: Exception) {
            return error(def, "JSON 解析失败")
        }
        val obj = element as? JsonObject ?: return error(def, "JSON 解析失败")
        return fromJsonObject(def, obj)
    }

    fun fromJsonObject(def: ModuleDef, obj: JsonObject): ModuleOutput {
        val items = (obj["items"] as? JsonArray)?.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            ModuleItem(
                group = string(o["group"]),
                label = string(o["label"]).orEmpty(),
                text = string(o["text"]).orEmpty(),
                value = number(o["value"]),
                color = string(o["color"]) ?: def.color,
            )
        }
        return ModuleOutput(
            id = def.id,
            ok = true,
            text = string(obj["text"]).orEmpty(),
            value = number(obj["value"]),
            color = string(obj["color"])?.takeIf { it.isNotBlank() } ?: def.color,
            items = items,
            fromJson = true,
        )
    }

    /** `73` 或 `73%` → 0.73；`3/4` → 0.75；结果限制在 0..1 */
    fun parseValue(s: String): Double? {
        val t = s.trim().trimEnd('%')
        val slash = t.indexOf('/')
        if (slash >= 0) {
            val a = t.substring(0, slash).trim().toDoubleOrNull() ?: return null
            val b = t.substring(slash + 1).trim().toDoubleOrNull() ?: return null
            return if (b > 0) (a / b).coerceIn(0.0, 1.0) else null
        }
        val v = t.toDoubleOrNull() ?: return null
        if (v.isNaN()) return null
        return (v / 100).coerceIn(0.0, 1.0)
    }

    fun error(def: ModuleDef, message: String): ModuleOutput =
        ModuleOutput(def.id, ok = false, text = message, value = null, color = def.color)

    private fun string(e: JsonElement?): String? = when (e) {
        null, JsonNull -> null
        is JsonPrimitive -> e.content
        else -> e.toString()
    }

    private fun number(e: JsonElement?): Double? =
        (e as? JsonPrimitive)?.takeIf { it !is JsonNull }?.doubleOrNull?.takeIf { !it.isNaN() }
}
