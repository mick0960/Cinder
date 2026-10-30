package com.cinder.mobile.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import com.cinder.mobile.graph
import com.cinder.mobile.service.MonitorService
import kotlinx.coroutines.launch

/**
 * 三种小部件共用的 provider。系统只在添加、调整大小、开机时回调这里；
 * 平时的刷新由实时服务（或省电模式的周期任务）直接推送。
 */
abstract class CinderWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = refresh(context)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, newOptions: Bundle) {
        if (newOptions.getBoolean(MIUI_ID_CHANGED) && !newOptions.getBoolean(MIUI_ID_CHANGED_COMPLETE)) {
            completeMiuiIdChange(manager, id, newOptions)
        }
        context.graph.renderer.sizeChanged(id)
        refresh(context)
    }

    /**
     * HyperOS 把小部件拖进 / 拖出负一屏时会换成新的 id，并在 options 里带上新旧 id。
     * 数据不按 id 存，不用迁移；按小米的约定先给新 id 标记迁移完成，再由 refresh 整体重绘。
     */
    private fun completeMiuiIdChange(manager: AppWidgetManager, id: Int, options: Bundle) {
        for (newId in options.getIntArray(MIUI_NEW_IDS) ?: intArrayOf(id)) {
            val o = if (newId == id) Bundle(options) else manager.getAppWidgetOptions(newId)
            o.putBoolean(MIUI_ID_CHANGED_COMPLETE, true)
            manager.updateAppWidgetOptions(newId, o)
        }
    }

    override fun onDeleted(context: Context, ids: IntArray) = context.graph.renderer.forget(ids)

    override fun onEnabled(context: Context) = MonitorService.sync(context)

    override fun onDisabled(context: Context) = MonitorService.sync(context)

    private fun refresh(context: Context) {
        val graph = context.graph
        val pending = goAsync()
        graph.scope.launch {
            try {
                if (graph.metrics.snapshot.value == null) graph.metrics.tick()
                graph.renderer.render(graph.renderState(), force = true)
            } finally {
                pending.finish()
            }
        }
        MonitorService.sync(context)
    }

    private companion object {
        const val MIUI_ID_CHANGED = "miuiIdChanged"
        const val MIUI_ID_CHANGED_COMPLETE = "miuiIdChangedComplete"
        const val MIUI_NEW_IDS = "miuiNewIds"
    }
}

class SummaryWidget : CinderWidget()

class SystemWidget : CinderWidget()

class ModulesWidget : CinderWidget()

/** 小部件上的刷新按钮 */
class WidgetActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_REFRESH) MonitorService.refresh(context)
    }

    companion object {
        const val ACTION_REFRESH = "com.cinder.mobile.action.REFRESH"
    }
}
