package com.cinder.mobile.shizuku;

interface IPrivileged {
    /** Shizuku 在 unbindUserService(remove = true) 或版本号变化时调用，用来结束 shell 进程 */
    void destroy() = 16777114;

    /** 批量读文件：一次 binder 调用拿到 /proc/stat 和所有温度节点；读不到的位置为 null */
    String[] readFiles(in String[] paths) = 1;

    String[] listDir(String path) = 2;

    /** 以 shell 身份执行命令，返回 [退出码, stdout, stderr]；超时退出码为 -1 */
    String[] exec(String command, long timeoutMs) = 3;
}
