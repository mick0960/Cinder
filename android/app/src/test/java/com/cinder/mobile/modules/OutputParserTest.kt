package com.cinder.mobile.modules

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 规则对照桌面版 src-tauri/src/modules/mod.rs 的 parse_output / parse_value */
class OutputParserTest {
    private val text = ModuleDef(id = "m", name = "t")
    private val progress = text.copy(style = "progress")
    private val json = text.copy(format = "json", color = "#123456")

    @Test
    fun plainTextIsTrimmed() {
        val out = OutputParser.parse(text, "  hello\n")
        assertTrue(out.ok)
        assertEquals("hello", out.text)
        assertNull(out.value)
        assertFalse(out.fromJson)
    }

    @Test
    fun textStyleDoesNotParseValue() {
        assertNull(OutputParser.parse(text, "73").value)
    }

    @Test
    fun progressValueForms() {
        assertEquals(0.73, OutputParser.parse(progress, "73").value!!, 1e-9)
        assertEquals(0.73, OutputParser.parse(progress, "73%").value!!, 1e-9)
        assertEquals(0.75, OutputParser.parse(progress, "3/4").value!!, 1e-9)
        assertEquals(0.75, OutputParser.parse(progress, " 3 / 4 ").value!!, 1e-9)
        assertEquals(1.0, OutputParser.parse(progress, "150").value!!, 1e-9)
        assertEquals(0.0, OutputParser.parse(progress, "-5").value!!, 1e-9)
        assertNull(OutputParser.parse(progress, "3/0").value)
        assertNull(OutputParser.parse(progress, "abc").value)
        assertNull(OutputParser.parse(progress, "NaN").value)
    }

    @Test
    fun jsonFields() {
        val out = OutputParser.parse(json, """{ "text": "73%", "value": 0.73, "color": "#ff5d5d" }""")
        assertTrue(out.ok)
        assertTrue(out.fromJson)
        assertEquals("73%", out.text)
        assertEquals(0.73, out.value!!, 1e-9)
        assertEquals("#ff5d5d", out.color)
    }

    @Test
    fun jsonColorFallsBackToModuleColor() {
        val out = OutputParser.parse(json, """{"text":"x"}""")
        assertEquals("#123456", out.color)
        assertNull(out.value)
    }

    @Test
    fun jsonItemsInheritModuleColor() {
        val out = OutputParser.parse(
            json,
            """{"text":"2 个账号","value":0.9,"items":[
                {"group":"A","label":"5h","text":"45%","value":0.45},
                {"group":"A","label":"7d","text":"90%","value":0.9,"color":"#ff0000"},
                {"label":"—","text":"无用量数据","value":null}
            ]}""",
        )
        val items = out.items!!
        assertEquals(3, items.size)
        assertEquals("A", items[0].group)
        assertEquals("#123456", items[0].color)
        assertEquals("#ff0000", items[1].color)
        assertNull(items[2].group)
        assertNull(items[2].value)
    }

    @Test
    fun invalidJsonIsError() {
        val out = OutputParser.parse(json, "not json")
        assertFalse(out.ok)
        assertEquals("JSON 解析失败", out.text)
        assertFalse(OutputParser.parse(json, "[1, 2]").ok)
    }
}
