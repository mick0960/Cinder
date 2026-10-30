package com.cinder.mobile

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import com.cinder.mobile.service.MonitorService
import com.cinder.mobile.ui.AppRoot
import com.cinder.mobile.ui.CinderTheme
import com.cinder.mobile.ui.EditTarget
import com.cinder.mobile.ui.ImportSource
import com.cinder.mobile.ui.UiState

class MainActivity : ComponentActivity() {
    private val ui = UiState()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) handle(intent)
        setContent { CinderTheme { AppRoot(graph, ui) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        // 界面打开时与桌面面板一样每秒刷新；关闭后释放，由实时服务按自己的间隔继续
        graph.metrics.acquire(UI, 1000)
        graph.scheduler.acquire(UI)
        graph.shizuku.acquire(UI)
        graph.shizuku.refresh()
        MonitorService.sync(this)
    }

    override fun onStop() {
        graph.metrics.release(UI)
        graph.scheduler.release(UI)
        graph.shizuku.release(UI)
        super.onStop()
    }

    private fun handle(intent: Intent?) {
        intent ?: return
        intent.getIntExtra(EXTRA_TAB, -1).takeIf { it >= 0 }?.let { ui.tab = it }
        intent.getStringExtra(EXTRA_MODULE)?.let { ui.editing = EditTarget.Existing(it) }
        if (intent.getBooleanExtra(EXTRA_DIAGNOSTICS, false)) ui.diagnostics = true
        when (intent.action) {
            Intent.ACTION_VIEW -> {
                val data = intent.data ?: return
                ui.importing = if (data.scheme == "cinder") {
                    data.getQueryParameter("url")?.let { ImportSource.Link(it) } ?: return
                } else {
                    ImportSource.File(data)
                }
                ui.tab = TAB_MODULES
            }
            Intent.ACTION_SEND -> {
                val stream = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()
                ui.importing = when {
                    stream != null -> ImportSource.File(stream)
                    text.isNullOrEmpty() -> return
                    text.startsWith("https://") && !text.contains('\n') -> ImportSource.Link(text)
                    else -> ImportSource.Text(text)
                }
                ui.tab = TAB_MODULES
            }
        }
    }

    companion object {
        const val EXTRA_TAB = "tab"
        const val EXTRA_MODULE = "module"

        /** adb shell am start -n com.cinder.mobile/.MainActivity --ez diagnostics true */
        const val EXTRA_DIAGNOSTICS = "diagnostics"
        const val TAB_PANEL = 0
        const val TAB_MODULES = 1
        const val TAB_WIDGETS = 2
        const val TAB_SETTINGS = 3
        private const val UI = "ui"
    }
}
