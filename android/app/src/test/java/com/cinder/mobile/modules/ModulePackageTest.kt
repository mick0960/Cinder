package com.cinder.mobile.modules

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ModulePackageTest {
    @Test
    fun singleModule() {
        val defs = ModulePackage.parse("""{"cinderModule":1,"name":"负载","type":"command","command":"cat /proc/loadavg"}""")
        assertEquals(1, defs.size)
        assertEquals("command", defs[0].type)
        assertEquals("sh", defs[0].shell)
        assertEquals(5000, defs[0].intervalMs)
        assertEquals(3000, defs[0].timeoutMs)
    }

    @Test
    fun typeIsInferredWhenMissing() {
        assertEquals("http", ModulePackage.parse("""{"name":"a","request":{"url":"https://a.com"}}""")[0].type)
        assertEquals("command", ModulePackage.parse("""{"name":"a","command":"date"}""")[0].type)
        assertEquals("script", ModulePackage.parse("""{"name":"a","script":"return 1"}""")[0].type)
    }

    @Test
    fun multipleModules() {
        val wrapped = ModulePackage.parse("""{"cinderModule":1,"modules":[{"name":"a","command":"date"},{"name":"b","script":"return 1"}]}""")
        assertEquals(listOf("a", "b"), wrapped.map { it.name })
        val array = ModulePackage.parse("""[{"name":"a","command":"date"}]""")
        assertEquals(1, array.size)
    }

    @Test
    fun desktopPowershellModuleIsRejectedWithExplanation() {
        // 桌面版 config.json 的结构：顶层有 modules，模块是 PowerShell 命令
        val desktopConfig = """
            {"window":{"x":1,"y":2},"character":"bonfire",
             "modules":[{"id":"g","type":"command","name":"GPU","command":"nvidia-smi","shell":"powershell",
                         "intervalMs":5000,"timeoutMs":3000,"style":"progress","format":"plain"}]}
        """.trimIndent()
        val e = assertThrows(ModuleFormatException::class.java) { ModulePackage.parse(desktopConfig) }
        assertTrue(e.message, e.message!!.contains("桌面版"))
    }

    @Test
    fun invalidInputs() {
        assertThrows(ModuleFormatException::class.java) { ModulePackage.parse("hello") }
        assertThrows(ModuleFormatException::class.java) { ModulePackage.parse("""{"name":""}""") }
        assertThrows(ModuleFormatException::class.java) { ModulePackage.parse("""{"name":"a","script":"x","intervalMs":100}""") }
        assertThrows(ModuleFormatException::class.java) { ModulePackage.parse("""{"cinderModule":99,"name":"a","script":"x"}""") }
        assertThrows(ModuleFormatException::class.java) {
            ModulePackage.parse("""{"name":"a","script":"x","params":[{"key":"bad key"}]}""")
        }
    }

    @Test
    fun exportRoundTripsAndOmitsValues() {
        val def = ModuleDef(
            id = "x1",
            type = "http",
            name = "接口",
            style = "progress",
            params = listOf(ModuleParam("token", "Token", secret = true, required = true)),
            request = HttpRequestDef("GET", "https://api.example.com/\${params.token}"),
            map = HttpMapDef(value = "json.ratio"),
        )
        val text = ModulePackage.export(listOf(def))
        assertTrue(text.contains("\"cinderModule\": 1"))
        assertEquals(def, ModulePackage.parse(text).single())
    }

    @Test
    fun builtInTemplatesAreValid() {
        val files = File("src/main/assets/templates").listFiles { f -> f.extension == "json" }!!
        assertEquals(5, files.size)
        for (f in files) {
            val defs = ModulePackage.parse(f.readText())
            assertEquals(f.nameWithoutExtension, defs.single().id)
        }
    }
}
