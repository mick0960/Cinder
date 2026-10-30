package com.cinder.mobile.modules

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class HostPolicyTest {
    @Test
    fun allowedFromHostsAndUrlParams() {
        val def = ModuleDef(
            type = "script",
            hosts = listOf("API.example.com", "*.foo.org"),
            params = listOf(ModuleParam("sub", type = "url"), ModuleParam("key")),
        )
        val allowed = HostPolicy.allowed(def, mapOf("sub" to "https://sub.example.net/path?x=1", "key" to "https://evil.com"))
        assertEquals(setOf("api.example.com", "*.foo.org", "sub.example.net"), allowed)
        assertTrue(HostPolicy.permits("a.foo.org", allowed))
        assertTrue(HostPolicy.permits("foo.org", allowed))
        assertTrue(HostPolicy.permits("API.EXAMPLE.COM", allowed))
        assertFalse(HostPolicy.permits("evil.com", allowed))
        assertFalse(HostPolicy.permits("xfoo.org", allowed))
    }

    @Test
    fun urlParamDefaultCounts() {
        val def = ModuleDef(type = "script", params = listOf(ModuleParam("base", type = "url", default = "https://ai.example.cn")))
        assertEquals(setOf("ai.example.cn"), HostPolicy.allowed(def, emptyMap()))
    }

    @Test
    fun httpLiteralHostIsAllowedButTemplatedHostIsNot() {
        val literal = ModuleDef(type = "http", request = HttpRequestDef(url = "https://api.ipify.org?format=json&t=\${params.t}"))
        assertEquals(setOf("api.ipify.org"), HostPolicy.allowed(literal, emptyMap()))
        val templated = ModuleDef(type = "http", request = HttpRequestDef(url = "https://\${params.host}/x"))
        assertEquals(emptySet<String>(), HostPolicy.allowed(templated, mapOf("host" to "evil.com")))
    }

    @Test
    fun checkRejectsOtherHostsAndBadUrls() {
        assertEquals("https://a.com/x", HostPolicy.check("https://a.com/x", setOf("a.com")))
        assertThrows(ModuleRunException::class.java) { HostPolicy.check("https://evil.com/x", setOf("a.com")) }
        assertThrows(ModuleRunException::class.java) { HostPolicy.check("ftp://a.com/x", setOf("a.com")) }
    }

    @Test
    fun paramTemplate() {
        assertEquals(
            "https://h/x?k=v&n=",
            ParamTemplate.apply("https://\${params.host}/x?k=\${params.key}&n=\${params.missing}", mapOf("host" to "h", "key" to "v")),
        )
    }
}
