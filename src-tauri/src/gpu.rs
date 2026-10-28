//! GPU 占用率，读取任务管理器同源的 PDH 计数器 `\GPU Engine(*)\Utilization Percentage`。
//! 不区分厂商（NVIDIA / AMD / Intel 都适用），需要 Windows 10 1709+ 与 WDDM 2.x 驱动。
//!
//! 取值方式与任务管理器一致：同一个引擎（`luid_… phys_N eng_M engtype_X`）在各进程上的占用相加，
//! 再取所有引擎里最忙的那个。
//!
//! 添加通配符计数器需要枚举全部实例，约 1 秒（实测 2000+ 个实例），之后每次采样只要 2 毫秒左右，
//! 所以采样放在独立线程里按需运行：有人读取时才启动，超过 `IDLE_STOP` 没人读取就关掉并释放计数器。

use std::collections::HashMap;
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};

const COUNTER_PATH: &str = r"\GPU Engine(*)\Utilization Percentage";
const SAMPLE_EVERY: Duration = Duration::from_secs(1);
const IDLE_STOP: Duration = Duration::from_secs(15);
/// 计数器不可用（或采样出错）后多久才再次尝试，避免每次读取都重新打开查询
const RETRY_AFTER_ERROR: Duration = Duration::from_secs(10);

struct State {
    running: bool,
    last_request: Option<Instant>,
    value: Option<f32>,
    error: Option<(String, Instant)>,
}

static STATE: Mutex<State> = Mutex::new(State { running: false, last_request: None, value: None, error: None });

/// 最近一次采样的 GPU 占用百分比（0~100）。
/// `Ok(None)` 表示采样线程刚启动、还没有第一个有效值；`Err` 表示这台机器读不到 GPU 计数器。
/// 每次调用都会让采样线程继续保持运行。
pub fn percent() -> Result<Option<f32>, String> {
    let mut s = STATE.lock().unwrap();
    s.last_request = Some(Instant::now());
    if let Some((msg, at)) = &s.error {
        if at.elapsed() < RETRY_AFTER_ERROR {
            return Err(msg.clone());
        }
        s.error = None;
    }
    if !s.running {
        s.running = true;
        s.value = None;
        if let Err(e) = std::thread::Builder::new().name("gpu-sampler".into()).spawn(sampler) {
            s.running = false;
            return Err(format!("无法启动 GPU 采样线程: {e}"));
        }
    }
    Ok(s.value)
}

fn sampler() {
    let result = run_sampler();
    let mut s = STATE.lock().unwrap();
    s.running = false;
    s.value = None;
    if let Err(e) = result {
        s.error = Some((e, Instant::now()));
    }
}

fn run_sampler() -> Result<(), String> {
    let query = Query::open()?;
    // 速率类计数器要两次采样才有值：先采一次作为基准
    query.collect()?;
    loop {
        std::thread::sleep(SAMPLE_EVERY);
        {
            let s = STATE.lock().unwrap();
            if s.last_request.is_none_or(|t| t.elapsed() > IDLE_STOP) {
                return Ok(());
            }
        }
        query.collect()?;
        let value = query.busiest_engine()?;
        STATE.lock().unwrap().value = value;
    }
}

struct Query {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

impl Query {
    fn open() -> Result<Self, String> {
        unsafe {
            let mut query: PDH_HQUERY = null_mut();
            let st = PdhOpenQueryW(null(), 0, &mut query);
            if st != 0 {
                return Err(format!("无法打开性能计数器查询（0x{st:08X}）"));
            }
            let mut counter: PDH_HCOUNTER = null_mut();
            let path = wide(COUNTER_PATH);
            let st = PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter);
            if st != 0 {
                PdhCloseQuery(query);
                return Err(format!("未检测到 GPU 性能计数器（0x{st:08X}）：需要 Windows 10 1709 及以上与 WDDM 2.x 显卡驱动"));
            }
            Ok(Self { query, counter })
        }
    }

    fn collect(&self) -> Result<(), String> {
        let st = unsafe { PdhCollectQueryData(self.query) };
        if st != 0 {
            return Err(format!("采集 GPU 计数器失败（0x{st:08X}）"));
        }
        Ok(())
    }

    /// 所有引擎里最忙的那个的占用率；没有任何有效实例时返回 None
    fn busiest_engine(&self) -> Result<Option<f32>, String> {
        let items = self.read_array()?;
        let mut per_engine: HashMap<&str, f64> = HashMap::new();
        for (name, v) in &items {
            // 实例名形如 pid_1234_luid_0x…_phys_0_eng_0_engtype_3D，去掉 pid_<n>_ 前缀就是引擎标识
            let engine = name.splitn(3, '_').nth(2).unwrap_or(name);
            *per_engine.entry(engine).or_default() += v;
        }
        Ok(per_engine.values().copied().reduce(f64::max).map(|v| v.clamp(0.0, 100.0) as f32))
    }

    fn read_array(&self) -> Result<Vec<(String, f64)>, String> {
        unsafe {
            let mut size: u32 = 0;
            let mut count: u32 = 0;
            let st = PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, null_mut());
            if st != PDH_MORE_DATA {
                // 没有任何实例（例如没有 GPU）时也会走到这里
                return if st == 0 { Ok(Vec::new()) } else { Err(format!("读取 GPU 计数器失败（0x{st:08X}）")) };
            }
            // 缓冲区前部是定长的数组，名字字符串紧随其后；用 u64 保证结构体的 8 字节对齐
            let mut buf = vec![0u64; size as usize / 8 + 2];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            let st = PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, items);
            if st != 0 {
                return Err(format!("读取 GPU 计数器失败（0x{st:08X}）"));
            }
            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count as usize {
                let it = &*items.add(i);
                // 刚出现的实例没有上一次采样可比，状态不是有效值，跳过
                if it.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA && it.FmtValue.CStatus != PDH_CSTATUS_NEW_DATA {
                    continue;
                }
                let mut len = 0;
                while *it.szName.add(len) != 0 {
                    len += 1;
                }
                let name = String::from_utf16_lossy(std::slice::from_raw_parts(it.szName, len));
                out.push((name, it.FmtValue.Anonymous.doubleValue));
            }
            Ok(out)
        }
    }
}

impl Drop for Query {
    fn drop(&mut self) {
        unsafe {
            PdhCloseQuery(self.query);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实读取本机的 GPU 计数器。没有 GPU 计数器的机器（如 CI 虚拟机）会得到 Err，同样视为通过。
    #[test]
    fn samples_this_machine() {
        match Query::open() {
            Err(e) => eprintln!("GPU counters unavailable here: {e}"),
            Ok(q) => {
                q.collect().unwrap();
                std::thread::sleep(Duration::from_millis(1100));
                q.collect().unwrap();
                let v = q.busiest_engine().unwrap();
                eprintln!("busiest GPU engine: {v:?}");
                if let Some(v) = v {
                    assert!((0.0..=100.0).contains(&v));
                }
            }
        }
    }
}
