package com.cinder.mobile.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.core.content.ContextCompat
import com.cinder.mobile.AppGraph
import com.cinder.mobile.R
import com.cinder.mobile.modules.ModuleDef

sealed interface EditTarget {
    data class Existing(val id: String) : EditTarget
    data class New(val type: String) : EditTarget
}

sealed interface ImportSource {
    data class Text(val text: String) : ImportSource
    data class File(val uri: Uri) : ImportSource
    data class Link(val url: String) : ImportSource
    data class Template(val def: ModuleDef) : ImportSource
}

class UiState {
    var tab by mutableIntStateOf(0)
    var editing by mutableStateOf<EditTarget?>(null)
    var importing by mutableStateOf<ImportSource?>(null)
    var diagnostics by mutableStateOf(false)
}

private data class Tab(val title: String, val icon: Int)

private val TABS = listOf(
    Tab("面板", R.drawable.ic_tab_panel),
    Tab("模块", R.drawable.ic_tab_modules),
    Tab("小部件", R.drawable.ic_tab_widgets),
    Tab("设置", R.drawable.ic_tab_settings),
)

@Composable
fun AppRoot(graph: AppGraph, ui: UiState) {
    AskNotificationPermissionOnce(graph)

    val importing = ui.importing
    val editing = ui.editing
    when {
        importing != null -> ImportScreen(graph, importing, onDone = { ui.importing = null })
        editing != null -> ModuleEditor(graph, editing, onClose = { ui.editing = null })
        ui.diagnostics -> DiagnosticsScreen(graph, onClose = { ui.diagnostics = false })
        else -> Scaffold(
            containerColor = Colors.Background,
            bottomBar = {
                NavigationBar(containerColor = Colors.Panel) {
                    TABS.forEachIndexed { i, tab ->
                        NavigationBarItem(
                            selected = ui.tab == i,
                            onClick = { ui.tab = i },
                            icon = { Icon(painterResource(tab.icon), contentDescription = tab.title) },
                            label = { Text(tab.title) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = Colors.Ok,
                                selectedTextColor = Colors.Ok,
                                indicatorColor = Colors.Ok.copy(alpha = 0.14f),
                                unselectedIconColor = Colors.Label,
                                unselectedTextColor = Colors.Label,
                            ),
                        )
                    }
                }
            },
        ) { padding ->
            Box(Modifier.padding(padding).fillMaxSize()) {
                when (ui.tab) {
                    0 -> PanelScreen(graph, ui)
                    1 -> ModulesScreen(graph, ui)
                    2 -> WidgetsScreen(graph, ui)
                    else -> SettingsScreen(graph, ui)
                }
            }
        }
    }
}

/** 实时模式需要常驻通知：首次启动时请求一次通知权限（拒绝也不影响刷新，只是通知不显示） */
@Composable
private fun AskNotificationPermissionOnce(graph: AppGraph) {
    if (Build.VERSION.SDK_INT < 33) return
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        val prefs = context.getSharedPreferences("ui", Context.MODE_PRIVATE)
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted && graph.settings.value.realtime && !prefs.getBoolean("notifAsked", false)) {
            prefs.edit().putBoolean("notifAsked", true).apply()
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
