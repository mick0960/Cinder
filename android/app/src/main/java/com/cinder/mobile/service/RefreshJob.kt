package com.cinder.mobile.service

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import com.cinder.mobile.graph
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * 省电模式：没有前台服务和常驻通知，系统大约每 15 分钟调度一次刷新（系统会合并调度、
 * 息屏深度休眠时会推迟），点小部件上的刷新按钮则立即跑一次。
 * 用系统自带的 JobScheduler 而不是 WorkManager，少带一个 Room 数据库。
 */
class RefreshJob : JobService() {
    private var job: Job? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val graph = applicationContext.graph
        job = graph.scope.launch {
            try {
                graph.refreshOnce()
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        job?.cancel()
        return false
    }

    companion object {
        private const val PERIODIC_ID = 1001
        private const val ONESHOT_ID = 1002

        /** fallback：实时模式但前台服务没能启动时，也按省电模式的节奏刷新 */
        fun sync(context: Context, fallback: Boolean = false) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            val graph = context.graph
            val want = (!graph.settings.value.realtime || fallback) && graph.renderer.hasWidgets()
            if (want) {
                if (scheduler.getPendingJob(PERIODIC_ID) == null) {
                    scheduler.schedule(
                        JobInfo.Builder(PERIODIC_ID, ComponentName(context, RefreshJob::class.java))
                            .setPeriodic(15 * 60 * 1000L)
                            .setPersisted(true)
                            .build()
                    )
                }
            } else {
                scheduler.cancel(PERIODIC_ID)
            }
        }

        fun runNow(context: Context) {
            context.getSystemService(JobScheduler::class.java).schedule(
                JobInfo.Builder(ONESHOT_ID, ComponentName(context, RefreshJob::class.java))
                    .setExpedited(true)
                    .build()
            )
        }
    }
}
