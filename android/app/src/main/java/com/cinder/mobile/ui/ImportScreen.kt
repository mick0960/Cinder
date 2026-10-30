package com.cinder.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cinder.mobile.AppGraph
import com.cinder.mobile.modules.HostPolicy
import com.cinder.mobile.modules.InstalledModule
import com.cinder.mobile.modules.ModuleDef
import com.cinder.mobile.modules.ModuleImporter
import com.cinder.mobile.modules.ModulePackage

private sealed interface Loaded {
    data object Loading : Loaded
    data class Failed(val message: String) : Loaded
    data class Ready(val defs: List<ModuleDef>, val source: String?) : Loaded
}

/** 导入前预览：显示代码 / 命令、要访问的域名和参数，填好参数后再保存 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportScreen(graph: AppGraph, source: ImportSource, onDone: () -> Unit) {
    val context = LocalContext.current
    var loaded by remember(source) { mutableStateOf<Loaded>(Loaded.Loading) }
    val values = remember(source) { mutableStateListOf<Map<String, String>>() }

    BackHandler(onBack = onDone)

    LaunchedEffect(source) {
        loaded = try {
            val defs = when (source) {
                is ImportSource.Template -> listOf(source.def)
                is ImportSource.Text -> ModulePackage.parse(source.text)
                is ImportSource.File -> ModulePackage.parse(ModuleImporter.readUri(context, source.uri))
                is ImportSource.Link -> ModulePackage.parse(ModuleImporter.readUrl(graph.fetcher, source.url))
            }.map(ModulePackage::withId)
            values.clear()
            defs.forEach { def -> values += graph.modules.get(def.id)?.values.orEmpty() }
            Loaded.Ready(defs, (source as? ImportSource.Link)?.url)
        } catch (e: Exception) {
            Loaded.Failed(e.message ?: "导入失败")
        }
    }

    Scaffold(
        containerColor = Colors.Background,
        topBar = {
            TopAppBar(
                title = { Text("导入模块") },
                navigationIcon = { TextButton(onClick = onDone) { Text("取消") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Colors.Background),
            )
        },
    ) { padding ->
        when (val state = loaded) {
            Loaded.Loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            is Loaded.Failed -> Column(Modifier.padding(padding).padding(16.dp)) {
                PanelCard {
                    Text("无法导入", color = Colors.Danger, fontWeight = FontWeight.SemiBold)
                    Text(state.message, Modifier.padding(top = 6.dp), color = Colors.Label, fontSize = 13.sp)
                }
            }
            is Loaded.Ready -> Column(
                Modifier
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                state.defs.forEachIndexed { i, def ->
                    Candidate(
                        def = def,
                        existing = graph.modules.get(def.id)?.def?.name,
                        values = values.getOrElse(i) { emptyMap() },
                        onValues = { values[i] = it },
                    )
                }
                Button(
                    onClick = {
                        state.defs.forEachIndexed { i, def ->
                            val old = graph.modules.get(def.id)
                            val privileged = def.type == "command" && def.shell == "shizuku"
                            graph.modules.upsert(
                                InstalledModule(
                                    def = def,
                                    values = values.getOrElse(i) { emptyMap() },
                                    // shell 身份的命令导入后默认停用，由用户确认后手动打开
                                    enabled = if (privileged) old?.enabled ?: false else true,
                                    widget = old?.widget ?: true,
                                    source = state.source ?: old?.source,
                                )
                            )
                        }
                        onDone()
                    },
                    Modifier.fillMaxWidth(),
                ) { Text(if (state.defs.size == 1) "导入" else "导入 ${state.defs.size} 个模块") }
            }
        }
    }
}

@Composable
private fun Candidate(def: ModuleDef, existing: String?, values: Map<String, String>, onValues: (Map<String, String>) -> Unit) {
    var showCode by remember { mutableStateOf(false) }
    val hosts = HostPolicy.allowed(def, values + def.params.associate { it.key to (values[it.key] ?: it.default.orEmpty()) })
    PanelCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(def.name, Modifier.weight(1f), fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Pill(typeLabel(def), Colors.Ok)
        }
        listOfNotNull(def.description, def.author?.let { "作者：$it" }, def.version?.let { "版本：$it" }).forEach {
            Text(it, color = Colors.Label, fontSize = 12.sp)
        }
        if (existing != null) Text("将覆盖已安装的「$existing」，已填写的参数会保留", color = Colors.Warn, fontSize = 12.sp)
        if (def.type == "command" && def.shell == "shizuku") {
            Text(
                "这个模块会经 Shizuku 以 shell 身份执行命令，能读取和修改大量系统数据。导入后默认停用，确认命令可信后再启用。",
                Modifier.padding(top = 6.dp),
                color = Colors.Danger,
                fontSize = 12.sp,
            )
        }
        if (def.type != "command") {
            Text(
                if (hosts.isEmpty()) "不会访问网络" else "允许访问：${hosts.joinToString("、")}",
                Modifier.padding(top = 6.dp),
                color = Colors.Label,
                fontSize = 12.sp,
            )
        }
        Text("每 ${interval(def.intervalMs)}刷新 · 超时 ${def.timeoutMs} ms", color = Colors.Sub, fontSize = 12.sp)

        if (def.params.isNotEmpty()) {
            Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ParamFields(def.params, values, onValues)
            }
        }

        TextButton(onClick = { showCode = !showCode }) { Text(if (showCode) "收起代码" else "查看代码") }
        if (showCode) {
            val code = when (def.type) {
                "script" -> def.script.orEmpty()
                "command" -> def.command.orEmpty()
                else -> buildString {
                    val r = def.request
                    append(r?.method).append(' ').append(r?.url).append('\n')
                    r?.headers?.forEach { (k, v) -> append(k).append(": ").append(v).append('\n') }
                    r?.body?.let { append('\n').append(it).append('\n') }
                    def.map?.let { m ->
                        m.vars?.let { append("\nvars: ").append(it) }
                        m.text?.let { append("\ntext: ").append(it) }
                        m.value?.let { append("\nvalue: ").append(it) }
                        m.color?.let { append("\ncolor: ").append(it) }
                    }
                }
            }
            Text(
                code,
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Colors.Background)
                    .horizontalScroll(rememberScrollState())
                    .padding(10.dp),
                style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
                color = Colors.Group,
                softWrap = false,
            )
        }
    }
}
