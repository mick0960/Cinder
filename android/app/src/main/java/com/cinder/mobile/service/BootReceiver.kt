package com.cinder.mobile.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机或升级后按设置恢复实时服务 / 省电模式的周期任务 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> MonitorService.sync(context)
        }
    }
}
