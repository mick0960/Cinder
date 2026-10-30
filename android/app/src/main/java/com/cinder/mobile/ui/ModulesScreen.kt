package com.cinder.mobile.ui

import android.content.ClipboardManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cinder.mobile.AppGraph
import com.cinder.mobile.modules.InstalledModule
import com.cinder.mobile.modules.ModuleDef
import com.cinder.mobile.modules.ModuleDisplay
import com.cinder.mobile.modules.ModuleImporter
import com.cinder.mobile.modules.ModuleOutput

val TYPE_NAMES = mapOf("script" to "JS 脚本", "http" to "HTTP", "command" to "命令")

fun typeLabel(def: ModuleDef): String =
    if (def.type == "command" && def.shell == "shizuku") "命令 · Shizuku" else TYPE_NAMES[def.type] ?: def.type

fun interval(ms: Long): String = when {
    ms % 60_000 == 0L -> "${ms / 60_000} 分钟"
    ms % 1000 == 0L -> "${ms / 1000} 秒"
    else -> "${ms / 1000.0} 秒"
}

@Composable
fun ModulesScreen(graph: AppGraph, ui: UiState) {
    val context = LocalContext.current
    val modules by graph.modules.modules.collectAsStateWithLifecycle()
    val outputs by graph.scheduler.outputs.collectAsStateWithLifecycle()
    var importMenu by remember { mutableStateOf(false) }
    var newMenu by remember { mutableStateOf(false) }
    var linkDialog by remember { mutableStateOf(false) }
    var templates by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) ui.importing = ImportSource.File(uri)
    }

    Column {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("自定义模块", Modifier.weight(1f), fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
            Box {
                TextButton(onClick = { importMenu = true }) { Text("导入") }
                DropdownMenu(importMenu, onDismissRequest = { importMenu = false }) {
                    DropdownMenuItem(text = { Text("从文件") }, onClick = {
                        importMenu = false
                        picker.launch(arrayOf("application/json", "text/plain", "application/octet-stream", "*/*"))
                    })
                    DropdownMenuItem(text = { Text("从剪贴板") }, onClick = {
                        importMenu = false
                        val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
                        val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()?.trim()
                        when {
                            text.isNullOrEmpty() -> Toast.makeText(context, "剪贴板是空的", Toast.LENGTH_SHORT).show()
                            text.startsWith("https://") && !text.contains('\n') -> ui.importing = ImportSource.Link(text)
                            else -> ui.importing = ImportSource.Text(text)
                        }
                    })
                    DropdownMenuItem(text = { Text("从链接") }, onClick = { importMenu = false; linkDialog = true })
                    DropdownMenuItem(text = { Text("内置模板") }, onClick = { importMenu = false; templates = true })
                }
            }
            Box {
                TextButton(onClick = { newMenu = true }) { Text("新建") }
                DropdownMenu(newMenu, onDismissRequest = { newMenu = false }) {
                    DropdownMenuItem(text = { Text("JS 脚本") }, onClick = { newMenu = false; ui.editing = EditTarget.New("script") })
                    DropdownMenuItem(text = { Text("HTTP 请求") }, onClick = { newMenu = false; ui.editing = EditTarget.New("http") })
                    DropdownMenuItem(text = { Text("Shell 命令") }, onClick = { newMenu = false; ui.editing = EditTarget.New("command") })
                }
            }
        }

        if (modules.isEmpty()) {
            PanelCard(Modifier.padding(16.dp)) {
                Text("还没有模块", fontWeight = FontWeight.SemiBold)
                Text(
                    "模块可以把任意接口、脚本或命令的结果变成面板和小部件里的一行，输出格式与桌面版相同。" +
                        "可以从模板开始，也可以导入别人分享的模块包（.json）。",
                    Modifier.padding(top = 6.dp),
                    color = Colors.Label,
                    fontSize = 13.sp,
                )
                FilledTonalButton(onClick = { templates = true }, Modifier.padding(top = 12.dp)) { Text("浏览模板") }
            }
        } else {
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(modules, key = { it.id }) { m ->
                    ModuleListItem(
                        m,
                        outputs[m.id],
                        onToggle = { graph.modules.upsert(m.copy(enabled = it)) },
                        onClick = { ui.editing = EditTarget.Existing(m.id) },
                    )
                }
            }
        }
    }

    if (linkDialog) {
        var url by remember { mutableStateOf("https://") }
        AlertDialog(
            onDismissRequest = { linkDialog = false },
            title = { Text("从链接导入") },
            text = {
                OutlinedTextField(url, { url = it }, label = { Text("模块包地址（https）") }, singleLine = true)
            },
            confirmButton = {
                TextButton(onClick = {
                    linkDialog = false
                    ui.importing = ImportSource.Link(url.trim())
                }) { Text("下载") }
            },
            dismissButton = { TextButton(onClick = { linkDialog = false }) { Text("取消") } },
        )
    }

    if (templates) {
        val list = remember { ModuleImporter.templates(context) }
        AlertDialog(
            onDismissRequest = { templates = false },
            title = { Text("内置模板") },
            text = {
                LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(list, key = { it.id }) { def ->
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    templates = false
                                    ui.importing = ImportSource.Template(def)
                                }
                                .padding(vertical = 8.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(def.name, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                                Pill(typeLabel(def))
                            }
                            def.description?.let { Text(it, color = Colors.Label, fontSize = 12.sp) }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { templates = false }) { Text("关闭") } },
        )
    }
}

@Composable
private fun ModuleListItem(m: InstalledModule, out: ModuleOutput?, onToggle: (Boolean) -> Unit, onClick: () -> Unit) {
    PanelCard(Modifier.clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(m.def.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Pill(typeLabel(m.def))
                }
                val status = when {
                    !m.enabled -> "已停用"
                    out == null -> "等待运行…"
                    !out.ok -> out.text
                    ModuleDisplay.items(out) != null -> "${out.text}（${out.items?.size} 条）"
                    else -> ModuleDisplay.valueText(m.def, out)
                }
                Text(
                    status,
                    color = if (out != null && !out.ok && m.enabled) Colors.Error else Colors.Label,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "每 ${interval(m.def.intervalMs)}" + (out?.let { " · 上次耗时 ${it.ms} ms" } ?: ""),
                    color = Colors.Sub,
                    fontSize = 11.sp,
                )
            }
            Switch(m.enabled, onCheckedChange = onToggle)
        }
    }
}
