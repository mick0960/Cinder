//! Windows 作业对象（Job Object）：把常驻进程及其子孙进程放进同一个作业，
//! 作业句柄一关（模块重载、面板长时间收起，或本程序退出 / 崩溃时由系统关闭句柄）整棵进程树都会被杀掉，
//! 不会留下孤儿 powershell.exe / nvidia-smi.exe。

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::null;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct Job(HANDLE);

// HANDLE 是裸指针所以默认 !Send；作业句柄本身可以在任意线程使用和关闭
unsafe impl Send for Job {}

impl Job {
    pub fn new() -> Option<Job> {
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Job(handle))
        }
    }

    /// 把子进程加入作业。子进程在加入之前已经创建出来的孙进程不在作业里，
    /// 但 shell 刚启动时还没有运行到用户的脚本，实际上不会有这种情况。
    pub fn assign(&self, child: &tokio::process::Child) -> bool {
        let Some(process) = child.raw_handle() else {
            return false;
        };
        unsafe { AssignProcessToJobObject(self.0, process as HANDLE) != 0 }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // 关闭最后一个句柄 + KILL_ON_JOB_CLOSE：作业内所有进程被终止
        unsafe {
            CloseHandle(self.0);
        }
    }
}
