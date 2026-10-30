package com.cinder.mobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cinder.mobile.AppGraph
import com.cinder.mobile.modules.HttpMapDef
import com.cinder.mobile.modules.HttpRequestDef
import com.cinder.mobile.modules.InstalledModule
import com.cinder.mobile.modules.ModuleDef
import com.cinder.mobile.modules.ModuleDisplay
import com.cinder.mobile.modules.ModuleOutput
import com.cinder.mobile.modules.ModuleParam
import com.cinder.mobile.modules.ModulePackage
import com.cinder.mobile.modules.PrettyModuleJson
import kotlinx.coroutines.launch

private val Mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp)

private const val SCRIPT_SKELETON = """export default async function (ctx) {
  // ctx.params：参数；ctx.http.request({ url, method, headers, body })；ctx.store.get/set；ctx.log(...)
  // 访问的域名需要写进"允许访问的域名"，url 类参数的域名会自动允许
  const r = await ctx.http.request({ url: 'https://api.example.com/status' });
  const data = r.json();
  return { text: String(data.value), value: data.value / 100 };
}
"""

private fun skeleton(type: String): ModuleDef = when (type) {
    "http" -> ModuleDef(
        type = "http",
        name = "新 HTTP 模块",
        intervalMs = 60_000,
        timeoutMs = 10_000,
        request = HttpRequestDef(url = "https://"),
        map = HttpMapDef(text = "json.text"),
    )
    "command" -> ModuleDef(type = "command", name = "新命令", command = "cat /proc/loadavg | cut -d ' ' -f 1", shell = "sh")
    else -> ModuleDef(type = "script", name = "新脚本", intervalMs = 60_000, timeoutMs = 10_000, script = SCRIPT_SKELETON)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModuleEditor(graph: AppGraph, target: EditTarget, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val existing = remember(target) { (target as? EditTarget.Existing)?.let { graph.modules.get(it.id) } }
    if (target is EditTarget.Existing && existing == null) {
        LaunchedEffect(Unit) { onClose() }
        return
    }
    var def by remember(target) { mutableStateOf(existing?.def ?: skeleton((target as EditTarget.New).type)) }
    var values by remember(target) { mutableStateOf(existing?.values ?: emptyMap()) }
    var enabled by remember(target) { mutableStateOf(existing?.enabled ?: true) }
    var widget by remember(target) { mutableStateOf(existing?.widget ?: true) }
    var errors by remember { mutableStateOf<List<String>>(emptyList()) }
    var testing by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<ModuleOutput?>(null) }
    var jsonDialog by remember { mutableStateOf(false) }
    var deleteDialog by remember { mutableStateOf(false) }

    BackHandler(onBack = onClose)

    fun current() = InstalledModule(ModulePackage.withId(def), values, enabled, widget, existing?.source)

    fun save() {
        val module = current()
        val problems = ModulePackage.validate(module.def)
        if (problems.isNotEmpty()) {
            errors = problems
            return
        }
        if (existing != null && existing.id != module.id) graph.modules.remove(existing.id)
        graph.modules.upsert(module)
        onClose()
    }

    Scaffold(
        containerColor = Colors.Background,
        topBar = {
            TopAppBar(
                title = { Text(if (existing == null) "新建模块" else "编辑模块") },
                navigationIcon = { TextButton(onClick = onClose) { Text("返回") } },
                actions = { TextButton(onClick = ::save) { Text("保存") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Colors.Background),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (errors.isNotEmpty()) ErrorBox(errors)

            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(def.name, { def = def.copy(name = it) }, Modifier.weight(1f), label = { Text("名称") }, singleLine = true)
                Pill(typeLabel(def), Colors.Ok)
            }
            def.description?.let { Text(it, color = Colors.Label, fontSize = 12.sp) }

            Choice("展示样式", listOf("text" to "文本", "progress" to "进度条", "sparkline" to "趋势折线"), def.style) {
                def = def.copy(style = it)
            }
            Choice("输出格式", listOf("plain" to "纯文本", "json" to "JSON"), def.format) { def = def.copy(format = it) }
            Text(
                "纯文本：进度条 / 折线需要能解析成数值（73、73%、3/4）。JSON：{\"text\", \"value\": 0~1, \"color\", \"items\"}。" +
                    "脚本返回对象、HTTP 带映射时总是按 JSON 处理。",
                color = Colors.Sub,
                fontSize = 11.sp,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NumberField("刷新间隔（毫秒）", def.intervalMs, Modifier.weight(1f)) { def = def.copy(intervalMs = it) }
                NumberField("超时（毫秒）", def.timeoutMs, Modifier.weight(1f)) { def = def.copy(timeoutMs = it) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    def.unit.orEmpty(), { def = def.copy(unit = it.ifEmpty { null }) }, Modifier.weight(1f),
                    label = { Text("单位") }, placeholder = { Text("°C、ms") }, singleLine = true,
                )
                OutlinedTextField(
                    def.color.orEmpty(), { def = def.copy(color = it.ifEmpty { null }) }, Modifier.weight(1f),
                    label = { Text("颜色") }, placeholder = { Text("#4cc2ff") }, singleLine = true,
                )
            }

            when (def.type) {
                "script" -> ScriptFields(def) { def = it }
                "http" -> HttpFields(def) { def = it }
                "command" -> CommandFields(def) { def = it }
            }
            if (def.type != "command") HostsField(def) { def = it }

            if (def.params.isNotEmpty()) {
                SectionTitle("参数")
                ParamFields(def.params, values) { values = it }
            }

            ToggleRow("启用", enabled) { enabled = it }
            ToggleRow("显示在\"自定义模块\"小部件", widget) { widget = it }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        testing = true
                        result = null
                        scope.launch {
                            result = graph.engine.run(current())
                            testing = false
                        }
                    },
                    enabled = !testing,
                ) { Text(if (testing) "运行中…" else "测试运行") }
                OutlinedButton(onClick = { jsonDialog = true }) { Text("编辑 JSON") }
            }
            result?.let { ResultCard(def, it) }

            if (existing != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = {
                        val text = ModulePackage.export(listOf(ModulePackage.withId(def)))
                        val send = Intent(Intent.ACTION_SEND)
                            .setType("text/plain")
                            .putExtra(Intent.EXTRA_SUBJECT, "${def.name}.cinder.json")
                            .putExtra(Intent.EXTRA_TEXT, text)
                        context.startActivity(Intent.createChooser(send, "导出模块"))
                    }) { Text("分享") }
                    TextButton(onClick = {
                        val text = ModulePackage.export(listOf(ModulePackage.withId(def)))
                        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(def.name, text))
                        Toast.makeText(context, "已复制模块包（不含参数值）", Toast.LENGTH_SHORT).show()
                    }) { Text("复制") }
                    TextButton(onClick = { deleteDialog = true }) { Text("删除", color = Colors.Danger) }
                }
            }
        }
    }

    if (jsonDialog) {
        JsonDialog(def, onDismiss = { jsonDialog = false }) {
            def = it.copy(id = def.id.ifBlank { it.id })
            jsonDialog = false
        }
    }

    if (deleteDialog && existing != null) {
        AlertDialog(
            onDismissRequest = { deleteDialog = false },
            title = { Text("删除「${existing.def.name}」？") },
            text = { Text("模块和它保存的数据都会被删除。") },
            confirmButton = {
                TextButton(onClick = {
                    graph.modules.remove(existing.id)
                    graph.kv.delete(existing.id)
                    deleteDialog = false
                    onClose()
                }) { Text("删除", color = Colors.Danger) }
            },
            dismissButton = { TextButton(onClick = { deleteDialog = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun ScriptFields(def: ModuleDef, onChange: (ModuleDef) -> Unit) {
    OutlinedTextField(
        def.script.orEmpty(), { onChange(def.copy(script = it)) },
        Modifier.fillMaxWidth(), label = { Text("脚本") }, textStyle = Mono, minLines = 8,
    )
    Text(
        "export default async function (ctx) {…}，返回对象 {text, value, color, items} 或字符串；" +
            "没有 export default 时整段代码当作函数体，直接 return。",
        color = Colors.Sub,
        fontSize = 11.sp,
    )
}

@Composable
private fun HttpFields(def: ModuleDef, onChange: (ModuleDef) -> Unit) {
    val req = def.request ?: HttpRequestDef()
    val map = def.map ?: HttpMapDef()
    var headers by remember { mutableStateOf(req.headers.entries.joinToString("\n") { "${it.key}: ${it.value}" }) }
    Choice("请求方法", listOf("GET", "HEAD", "POST", "PUT").map { it to it }, req.method.uppercase()) {
        onChange(def.copy(request = req.copy(method = it)))
    }
    OutlinedTextField(
        req.url, { onChange(def.copy(request = req.copy(url = it))) }, Modifier.fillMaxWidth(),
        label = { Text("地址") }, placeholder = { Text("https://…，可用 \${params.key}") }, singleLine = true,
    )
    OutlinedTextField(
        headers,
        {
            headers = it
            val parsed = it.lines().mapNotNull { line ->
                val i = line.indexOf(':')
                if (i <= 0) null else line.substring(0, i).trim() to line.substring(i + 1).trim()
            }.toMap()
            onChange(def.copy(request = req.copy(headers = parsed)))
        },
        Modifier.fillMaxWidth(), label = { Text("请求头（每行 名称: 值）") }, textStyle = Mono, minLines = 2,
    )
    if (req.method.uppercase() !in setOf("GET", "HEAD")) {
        OutlinedTextField(
            req.body.orEmpty(), { onChange(def.copy(request = req.copy(body = it.ifEmpty { null }))) },
            Modifier.fillMaxWidth(), label = { Text("请求体") }, textStyle = Mono, minLines = 2,
        )
    }
    SectionTitle("结果映射（JS 表达式，留空则响应体就是输出）")
    fun setMap(m: HttpMapDef) = onChange(def.copy(map = m.takeUnless { it.isEmpty && it.vars.isNullOrBlank() }))
    OutlinedTextField(map.vars.orEmpty(), { setMap(map.copy(vars = it.ifEmpty { null })) }, Modifier.fillMaxWidth(),
        label = { Text("vars：先执行的语句") }, textStyle = Mono, minLines = 2)
    OutlinedTextField(map.text.orEmpty(), { setMap(map.copy(text = it.ifEmpty { null })) }, Modifier.fillMaxWidth(),
        label = { Text("text") }, textStyle = Mono)
    OutlinedTextField(map.value.orEmpty(), { setMap(map.copy(value = it.ifEmpty { null })) }, Modifier.fillMaxWidth(),
        label = { Text("value（0~1）") }, textStyle = Mono)
    OutlinedTextField(map.color.orEmpty(), { setMap(map.copy(color = it.ifEmpty { null })) }, Modifier.fillMaxWidth(),
        label = { Text("color") }, textStyle = Mono)
    Text(
        "可用变量：json（解析后的响应）、body、headers（小写头名）、status、params；" +
            "函数：kv(s) 解析 a=1; b=2，need(v, 提示)，fmtBytes(n)，pct(r)。",
        color = Colors.Sub,
        fontSize = 11.sp,
    )
}

@Composable
private fun CommandFields(def: ModuleDef, onChange: (ModuleDef) -> Unit) {
    Choice("执行身份", listOf("sh" to "应用权限", "shizuku" to "Shizuku（shell）"), def.shell) { onChange(def.copy(shell = it)) }
    OutlinedTextField(
        def.command.orEmpty(), { onChange(def.copy(command = it)) }, Modifier.fillMaxWidth(),
        label = { Text("命令") }, textStyle = Mono, minLines = 3,
    )
    Text(
        "用 /system/bin/sh -c 执行，stdout 即输出。参数以环境变量 CINDER_PARAM_<KEY> 传入，也可写 \${params.key}。" +
            if (def.shell == "shizuku") " Shizuku 模式以 shell 身份运行，能读写大量系统数据，只运行你信任的命令。" else "",
        color = if (def.shell == "shizuku") Colors.Warn else Colors.Sub,
        fontSize = 11.sp,
    )
}

@Composable
private fun HostsField(def: ModuleDef, onChange: (ModuleDef) -> Unit) {
    var text by remember { mutableStateOf(def.hosts.joinToString(", ")) }
    OutlinedTextField(
        text,
        {
            text = it
            onChange(def.copy(hosts = it.split(',', ' ', '\n').map(String::trim).filter(String::isNotEmpty)))
        },
        Modifier.fillMaxWidth(),
        label = { Text("允许访问的域名") },
        placeholder = { Text("api.example.com, *.example.org") },
        singleLine = true,
    )
}

@Composable
fun ParamFields(params: List<ModuleParam>, values: Map<String, String>, onChange: (Map<String, String>) -> Unit) {
    params.forEach { p ->
        var visible by remember(p.key) { mutableStateOf(!p.secret) }
        OutlinedTextField(
            values[p.key].orEmpty(),
            { onChange(values + (p.key to it)) },
            Modifier.fillMaxWidth(),
            label = { Text(p.label + if (p.required) " *" else "") },
            placeholder = { (p.placeholder ?: p.default)?.let { Text(it) } },
            singleLine = true,
            visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = when {
                    p.secret -> KeyboardType.Password
                    p.type == "url" -> KeyboardType.Uri
                    p.type == "number" -> KeyboardType.Number
                    else -> KeyboardType.Text
                }
            ),
            trailingIcon = if (p.secret) {
                { TextButton(onClick = { visible = !visible }) { Text(if (visible) "隐藏" else "显示", fontSize = 12.sp) } }
            } else null,
        )
    }
}

@Composable
private fun ResultCard(def: ModuleDef, out: ModuleOutput) {
    PanelCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (out.ok) "运行成功" else "运行失败", Modifier.weight(1f), color = if (out.ok) Colors.Good else Colors.Danger, fontWeight = FontWeight.SemiBold)
            Text("${out.ms} ms", color = Colors.Sub, fontSize = 12.sp)
        }
        if (!out.ok) {
            Text(out.text, color = Colors.Danger, fontSize = 13.sp)
        } else {
            ModuleRow(InstalledModule(def), out, emptyList()) {}
            val raw = buildList {
                add("text: ${out.text}")
                out.value?.let { add("value: $it") }
                out.color?.let { add("color: $it") }
                out.items?.let { add("items: ${it.size} 条") }
            }
            Text(raw.joinToString("\n"), style = Mono, color = Colors.Label)
        }
        if (out.logs.isNotEmpty()) {
            Text("日志", Modifier.padding(top = 6.dp), color = Colors.Label, fontSize = 12.sp)
            Text(out.logs.joinToString("\n"), style = Mono, color = Colors.Sub)
        }
        if (ModuleDisplay.items(out) == null && def.style != "text" && out.ok && out.value == null) {
            Text("提示：进度条 / 折线样式需要数值，当前输出没有解析出 value。", color = Colors.Warn, fontSize = 11.sp)
        }
    }
}

@Composable
private fun JsonDialog(def: ModuleDef, onDismiss: () -> Unit, onApply: (ModuleDef) -> Unit) {
    var text by remember { mutableStateOf(PrettyModuleJson.encodeToString(ModuleDef.serializer(), def)) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("模块 JSON") },
        text = {
            Column {
                OutlinedTextField(text, { text = it; error = null }, Modifier.fillMaxWidth().heightIn(min = 220.dp, max = 460.dp), textStyle = Mono)
                error?.let { Text(it, color = Colors.Danger, fontSize = 12.sp) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                try {
                    val parsed = ModulePackage.parse(text)
                    if (parsed.size != 1) throw IllegalArgumentException("这里只能编辑一个模块")
                    onApply(parsed[0])
                } catch (e: Exception) {
                    error = e.message
                }
            }) { Text("应用") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
fun Choice(label: String, options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Column {
        Text(label, color = Colors.Label, fontSize = 12.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            options.forEach { (value, title) ->
                FilterChip(selected = selected == value, onClick = { onSelect(value) }, label = { Text(title) })
            }
        }
    }
}

@Composable
fun ToggleRow(label: String, checked: Boolean, sub: String? = null, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, fontSize = 14.sp)
            sub?.let { Text(it, color = Colors.Sub, fontSize = 12.sp) }
        }
        Switch(checked, onCheckedChange = onChange)
    }
}

@Composable
private fun NumberField(label: String, value: Long, modifier: Modifier, onChange: (Long) -> Unit) {
    var text by remember { mutableStateOf(value.toString()) }
    OutlinedTextField(
        text,
        {
            text = it.filter(Char::isDigit)
            text.toLongOrNull()?.let(onChange)
        },
        modifier,
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

@Composable
private fun ErrorBox(errors: List<String>) {
    Text(
        errors.joinToString("\n"),
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(Colors.Danger.copy(alpha = 0.12f))
            .padding(12.dp),
        color = Colors.Danger,
        fontSize = 13.sp,
    )
}
