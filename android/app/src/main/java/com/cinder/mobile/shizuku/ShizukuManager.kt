package com.cinder.mobile.shizuku

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.cinder.mobile.BuildConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import rikka.shizuku.Shizuku

/**
 * 管理 Shizuku 的状态和特权进程。特权进程只在有人需要时绑定（实时模式亮屏、界面打开、
 * 执行 shell 命令模块），否则解绑并结束，避免常驻一个多余的进程。
 */
class ShizukuManager(
    private val context: Context,
    private val enabled: () -> Boolean,
) {
    enum class State { NOT_INSTALLED, NOT_RUNNING, UNSUPPORTED, DENIED, READY }

    private val main = Handler(Looper.getMainLooper())

    private val _state = MutableStateFlow(State.NOT_RUNNING)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _service = MutableStateFlow<IPrivileged?>(null)
    val service: StateFlow<IPrivileged?> = _service.asStateFlow()

    /** shell 为 2000，root 为 0；未连接时为 null */
    val uid: Int?
        get() = try {
            if (Shizuku.pingBinder()) Shizuku.getUid() else null
        } catch (_: Exception) {
            null
        }

    private val holders = HashSet<String>()
    private var bound = false

    private val args by lazy {
        Shizuku.UserServiceArgs(ComponentName(context.packageName, PrivilegedService::class.java.name))
            // 固定 tag：R8 混淆后类名会变，Shizuku 靠 tag 判断是否同一个服务
            .tag("cinder-privileged")
            .daemon(false)
            .processNameSuffix("priv")
            .debuggable(BuildConfig.DEBUG)
            .version(BuildConfig.VERSION_CODE)
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            _service.value = if (binder != null && binder.pingBinder()) IPrivileged.Stub.asInterface(binder) else null
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            _service.value = null
            bound = false
        }
    }

    private val onBinderReceived = Shizuku.OnBinderReceivedListener { refresh() }
    private val onBinderDead = Shizuku.OnBinderDeadListener {
        _service.value = null
        bound = false
        refresh()
    }
    private val onPermissionResult = Shizuku.OnRequestPermissionResultListener { _, _ -> refresh() }

    fun start() {
        Shizuku.addBinderReceivedListenerSticky(onBinderReceived)
        Shizuku.addBinderDeadListener(onBinderDead)
        Shizuku.addRequestPermissionResultListener(onPermissionResult)
        refresh()
    }

    fun refresh() = main.post {
        _state.value = detect()
        sync()
    }

    fun requestPermission() = main.post {
        try {
            if (Shizuku.pingBinder() && !Shizuku.isPreV11()) Shizuku.requestPermission(REQUEST_CODE)
        } catch (_: Exception) {
        }
    }

    fun acquire(tag: String) {
        synchronized(holders) { holders += tag }
        main.post { sync() }
    }

    fun release(tag: String) {
        synchronized(holders) { holders -= tag }
        main.post { sync() }
    }

    /** 临时用一下特权进程（例如执行一次 shizuku 命令模块） */
    suspend fun <T> withService(timeoutMs: Long, block: (IPrivileged) -> T): T? {
        val tag = "once-${System.nanoTime()}"
        acquire(tag)
        try {
            val service = withTimeoutOrNull(timeoutMs) { _service.filterNotNull().first() } ?: return null
            return block(service)
        } finally {
            release(tag)
        }
    }

    private fun detect(): State = try {
        when {
            !Shizuku.pingBinder() -> if (installed()) State.NOT_RUNNING else State.NOT_INSTALLED
            Shizuku.isPreV11() -> State.UNSUPPORTED
            Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED -> State.DENIED
            else -> State.READY
        }
    } catch (_: Exception) {
        State.NOT_RUNNING
    }

    private fun installed(): Boolean = try {
        context.packageManager.getPackageInfo(SHIZUKU_PACKAGE, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    private fun sync() {
        val want = enabled() && _state.value == State.READY && synchronized(holders) { holders.isNotEmpty() }
        try {
            if (want && !bound) {
                Shizuku.bindUserService(args, connection)
                bound = true
            } else if (!want && bound) {
                // remove = true：Shizuku 会调用 destroy()，shell 进程随之退出
                Shizuku.unbindUserService(args, connection, true)
                bound = false
                _service.value = null
            }
        } catch (_: Exception) {
            bound = false
            _service.value = null
        }
    }

    companion object {
        const val SHIZUKU_PACKAGE = "moe.shizuku.privileged.api"
        private const val REQUEST_CODE = 1
    }
}
