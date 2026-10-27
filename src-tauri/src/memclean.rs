//! 手动内存清理：裁剪各进程工作集，把不活跃页面交还给系统。
//!
//! 普通权限下只能裁剪当前用户的进程；若恰好以管理员身份运行，
//! 再顺带清空修改列表和低优先级备用列表。

use serde::Serialize;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_NOT_ALL_ASSIGNED, HANDLE, LUID};
use windows_sys::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    SE_PROF_SINGLE_PROCESS_NAME, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows_sys::Win32::System::ProcessStatus::{K32EmptyWorkingSet, K32EnumProcesses};
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
};

static CLEANING: AtomicBool = AtomicBool::new(false);

const MIB: f64 = 1024.0 * 1024.0;

// NtSetSystemInformation 不在 windows-sys 里
const SYSTEM_MEMORY_LIST_INFORMATION: i32 = 80;
const MEMORY_FLUSH_MODIFIED_LIST: u32 = 3;
const MEMORY_PURGE_LOW_PRIORITY_STANDBY_LIST: u32 = 5;

#[link(name = "ntdll")]
extern "system" {
    fn NtSetSystemInformation(class: i32, info: *const c_void, len: u32) -> i32;
}

#[derive(Serialize, Clone, Debug)]
pub struct CleanResult {
    pub before_mb: f64,
    pub after_mb: f64,
    pub freed_mb: f64,
    pub trimmed: u32,
}

/// 与 sysinfo 的 used_memory 口径一致：总物理内存 - 可用
fn used_mb() -> f64 {
    let mut st: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut st) } == 0 {
        return 0.0;
    }
    st.ullTotalPhys.saturating_sub(st.ullAvailPhys) as f64 / MIB
}

fn pids() -> Vec<u32> {
    let mut buf = vec![0u32; 1024];
    loop {
        let cb = (buf.len() * 4) as u32;
        let mut needed = 0u32;
        if unsafe { K32EnumProcesses(buf.as_mut_ptr(), cb, &mut needed) } == 0 {
            return Vec::new();
        }
        // 缓冲区被填满时可能有遗漏，扩容重试
        if needed < cb {
            buf.truncate(needed as usize / 4);
            return buf;
        }
        buf.resize(buf.len() * 2, 0);
    }
}

fn trim_all() -> u32 {
    let me = unsafe { GetCurrentProcessId() };
    let mut n = 0;
    for pid in pids() {
        // 0 = Idle，4 = System；自身不裁剪，避免面板动画卡顿
        if pid == 0 || pid == 4 || pid == me {
            continue;
        }
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, 0, pid);
            if h.is_null() {
                continue;
            }
            if K32EmptyWorkingSet(h) != 0 {
                n += 1;
            }
            CloseHandle(h);
        }
    }
    n
}

/// 仅在拿得到 SeProfileSingleProcessPrivilege（管理员）时生效，否则静默跳过
fn purge_lists() {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token) == 0 {
            return;
        }
        let mut luid: LUID = std::mem::zeroed();
        let ok = LookupPrivilegeValueW(std::ptr::null(), SE_PROF_SINGLE_PROCESS_NAME, &mut luid) != 0 && {
            let tp = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
            };
            AdjustTokenPrivileges(token, 0, &tp, 0, std::ptr::null_mut(), std::ptr::null_mut()) != 0
                && GetLastError() != ERROR_NOT_ALL_ASSIGNED
        };
        CloseHandle(token);
        if !ok {
            return;
        }
        for cmd in [MEMORY_FLUSH_MODIFIED_LIST, MEMORY_PURGE_LOW_PRIORITY_STANDBY_LIST] {
            NtSetSystemInformation(SYSTEM_MEMORY_LIST_INFORMATION, &cmd as *const u32 as *const c_void, 4);
        }
    }
}

pub fn clean() -> Result<CleanResult, String> {
    if CLEANING.swap(true, Ordering::AcqRel) {
        return Err("正在清理".into());
    }
    let before = used_mb();
    let trimmed = trim_all();
    purge_lists();
    let after = used_mb();
    CLEANING.store(false, Ordering::Release);
    Ok(CleanResult {
        before_mb: before,
        after_mb: after,
        freed_mb: (before - after).max(0.0),
        trimmed,
    })
}
