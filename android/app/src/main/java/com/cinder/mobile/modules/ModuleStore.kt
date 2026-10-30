package com.cinder.mobile.modules

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.builtins.ListSerializer
import java.io.File

/** 已安装模块的持久化：App 私有目录下的 modules.json，原子写入 */
class ModuleStore(context: Context) {
    private val file = File(context.filesDir, "modules.json")
    private val _modules = MutableStateFlow(load())
    val modules: StateFlow<List<InstalledModule>> = _modules.asStateFlow()

    fun get(id: String): InstalledModule? = _modules.value.firstOrNull { it.id == id }

    @Synchronized
    fun save(list: List<InstalledModule>) {
        _modules.value = list
        val tmp = File(file.path + ".tmp")
        tmp.writeText(ModuleJson.encodeToString(ListSerializer(InstalledModule.serializer()), list))
        tmp.renameTo(file)
    }

    @Synchronized
    fun upsert(module: InstalledModule) {
        val list = _modules.value.toMutableList()
        val i = list.indexOfFirst { it.id == module.id }
        if (i >= 0) list[i] = module else list += module
        save(list)
    }

    @Synchronized
    fun remove(id: String) = save(_modules.value.filterNot { it.id == id })

    @Synchronized
    fun move(id: String, delta: Int) {
        val list = _modules.value.toMutableList()
        val i = list.indexOfFirst { it.id == id }
        val j = i + delta
        if (i < 0 || j !in list.indices) return
        list.add(j, list.removeAt(i))
        save(list)
    }

    private fun load(): List<InstalledModule> = try {
        ModuleJson.decodeFromString(ListSerializer(InstalledModule.serializer()), file.readText())
    } catch (_: Exception) {
        emptyList()
    }
}

/** 脚本的 ctx.store：每个模块一个小 JSON 对象，用来跨次运行保存状态（如上次的计数，算速率） */
interface ModuleKv {
    /** 返回 JSON 对象文本，没有时为 "{}" */
    fun get(id: String): String
    fun put(id: String, json: String)
    fun delete(id: String)
}

class FileModuleKv(private val dir: File) : ModuleKv {
    override fun get(id: String): String = try {
        File(dir, "$id.json").readText().takeIf { it.isNotBlank() } ?: "{}"
    } catch (_: Exception) {
        "{}"
    }

    override fun put(id: String, json: String) {
        if (json.length > MAX_SIZE) return
        dir.mkdirs()
        File(dir, "$id.json").writeText(json)
    }

    override fun delete(id: String) {
        File(dir, "$id.json").delete()
    }

    private companion object {
        const val MAX_SIZE = 64 * 1024
    }
}
