//! 跨平台网络吞吐量采样器。
//!
//! - Windows 使用 `GetIfTable2` 直接读取累计字节数（`InOctets` / `OutOctets`），
//!   按 `InterfaceLuid.Value` 差分计算速率，并优先只统计已连接的物理硬件网卡，
//!   避免把 Hyper-V / VMware / VirtualBox / TUN 等虚拟适配器重复计入总流量；
//!   纯虚拟机环境下若不存在活跃物理网卡，再回退到满足条件的虚拟以太网卡。
//! - 非 Windows 使用 `sysinfo::Networks` 的累计计数器 `total_received` / `total_transmitted`
//!   按接口名分别追踪前值，修复原先对增量再做二次相减导致恒速/减速掉零的问题。

use std::collections::HashMap;
use std::hash::Hash;
use std::time::Instant;

struct RateTracker<K> {
    prev: HashMap<K, (u64, u64)>,
    last_at: Option<Instant>,
}

impl<K: Eq + Hash> RateTracker<K> {
    fn new() -> Self {
        Self {
            prev: HashMap::new(),
            last_at: None,
        }
    }

    /// 传入本次各接口的累计 `(in_octets, out_octets)`，返回 `(up_bps, down_bps)`。
    /// 仅对前后两次快照均存在的接口求差，避免网卡热插拔或断开时产生尖峰或下溢。
    fn update(&mut self, now: Instant, current: HashMap<K, (u64, u64)>) -> (u64, u64) {
        let (up, down) = match self.last_at {
            Some(prev_at) if now > prev_at => {
                let dt = (now - prev_at).as_secs_f64();
                if dt > 0.0 {
                    let (mut delta_in, mut delta_out) = (0u64, 0u64);
                    for (k, &(curr_in, curr_out)) in &current {
                        if let Some(&(prev_in, prev_out)) = self.prev.get(k) {
                            delta_in = delta_in.saturating_add(curr_in.saturating_sub(prev_in));
                            delta_out = delta_out.saturating_add(curr_out.saturating_sub(prev_out));
                        }
                    }
                    ((delta_out as f64 / dt) as u64, (delta_in as f64 / dt) as u64)
                } else {
                    (0, 0)
                }
            }
            _ => (0, 0),
        };
        self.prev = current;
        self.last_at = Some(now);
        (up, down)
    }
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug)]
struct NicRow {
    luid: u64,
    hardware: bool,
    filter: bool,
    oper_up: bool,
    media_connected: bool,
    is_loopback: bool,
    is_tunnel: bool,
    has_mac: bool,
    has_link_speed: bool,
    in_octets: u64,
    out_octets: u64,
}

#[cfg(any(windows, test))]
fn is_active_common(r: &NicRow) -> bool {
    !r.filter && r.oper_up && r.media_connected && !r.is_loopback && !r.is_tunnel
}

#[cfg(any(windows, test))]
fn select_interface_octets(rows: &[NicRow]) -> HashMap<u64, (u64, u64)> {
    let mut selected: HashMap<u64, (u64, u64)> = rows
        .iter()
        .filter(|r| is_active_common(r) && r.hardware)
        .map(|r| (r.luid, (r.in_octets, r.out_octets)))
        .collect();
    if selected.is_empty() {
        selected = rows
            .iter()
            .filter(|r| is_active_common(r) && r.has_mac && r.has_link_speed)
            .map(|r| (r.luid, (r.in_octets, r.out_octets)))
            .collect();
    }
    selected
}

#[cfg(windows)]
fn read_windows_interfaces() -> Option<Vec<NicRow>> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        FreeMibTable, GetIfTable2, IF_TYPE_SOFTWARE_LOOPBACK, IF_TYPE_TUNNEL, MIB_IF_ROW2,
        MIB_IF_TABLE2,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::{
        IfOperStatusUp, MediaConnectStateConnected,
    };

    struct TableGuard(*mut MIB_IF_TABLE2);
    impl Drop for TableGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { FreeMibTable(self.0.cast()) };
            }
        }
    }

    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    let status = unsafe { GetIfTable2(&mut table) };
    if status != 0 || table.is_null() {
        if !table.is_null() {
            unsafe { FreeMibTable(table.cast()) };
        }
        return None;
    }
    let _guard = TableGuard(table);

    let rows = unsafe {
        let count = (*table).NumEntries as usize;
        if count == 0 {
            &[]
        } else {
            let ptr = std::ptr::addr_of!((*table).Table).cast::<MIB_IF_ROW2>();
            std::slice::from_raw_parts(ptr, count)
        }
    };

    Some(
        rows.iter()
            .map(|r| {
                let flags = r.InterfaceAndOperStatusFlags._bitfield;
                NicRow {
                    luid: unsafe { r.InterfaceLuid.Value },
                    hardware: (flags & 0x01) != 0,
                    filter: (flags & 0x02) != 0,
                    oper_up: r.OperStatus == IfOperStatusUp,
                    media_connected: r.MediaConnectState == MediaConnectStateConnected,
                    is_loopback: r.Type == IF_TYPE_SOFTWARE_LOOPBACK,
                    is_tunnel: r.Type == IF_TYPE_TUNNEL,
                    has_mac: r.PhysicalAddressLength > 0,
                    has_link_speed: r.TransmitLinkSpeed > 0 || r.ReceiveLinkSpeed > 0,
                    in_octets: r.InOctets,
                    out_octets: r.OutOctets,
                }
            })
            .collect(),
    )
}

#[cfg(windows)]
pub struct NetSampler {
    tracker: RateTracker<u64>,
}

#[cfg(windows)]
impl NetSampler {
    pub fn new() -> Self {
        Self {
            tracker: RateTracker::new(),
        }
    }

    pub fn sample(&mut self) -> (u64, u64) {
        let Some(rows) = read_windows_interfaces() else {
            return (0, 0);
        };
        let now = Instant::now();
        let current = select_interface_octets(&rows);
        self.tracker.update(now, current)
    }
}

#[cfg(not(windows))]
pub struct NetSampler {
    networks: sysinfo::Networks,
    tracker: RateTracker<String>,
}

#[cfg(not(windows))]
impl NetSampler {
    pub fn new() -> Self {
        Self {
            networks: sysinfo::Networks::new_with_refreshed_list(),
            tracker: RateTracker::new(),
        }
    }

    pub fn sample(&mut self) -> (u64, u64) {
        self.networks.refresh(true);
        let now = Instant::now();
        let current = self
            .networks
            .iter()
            .map(|(name, d)| (name.clone(), (d.total_received(), d.total_transmitted())))
            .collect();
        self.tracker.update(now, current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn nic(luid: u64, in_octets: u64, out_octets: u64) -> NicRow {
        NicRow {
            luid,
            hardware: true,
            filter: false,
            oper_up: true,
            media_connected: true,
            is_loopback: false,
            is_tunnel: false,
            has_mac: true,
            has_link_speed: true,
            in_octets,
            out_octets,
        }
    }

    #[test]
    fn steady_rate_does_not_drop_to_zero() {
        let mut tracker = RateTracker::new();
        let t0 = Instant::now();

        assert_eq!(tracker.update(t0, HashMap::from([(1u64, (1_000, 500))])), (0, 0));
        // 连续两个周期保持完全相同的恒定增量：10_000 B/s 下行、2_000 B/s 上行
        assert_eq!(
            tracker.update(t0 + Duration::from_secs(1), HashMap::from([(1u64, (11_000, 2_500))])),
            (2_000, 10_000)
        );
        assert_eq!(
            tracker.update(t0 + Duration::from_secs(2), HashMap::from([(1u64, (21_000, 4_500))])),
            (2_000, 10_000)
        );
        assert_eq!(
            tracker.update(t0 + Duration::from_secs(3), HashMap::from([(1u64, (31_000, 6_500))])),
            (2_000, 10_000)
        );
    }

    #[test]
    fn decelerating_rate_stays_positive() {
        let mut tracker = RateTracker::new();
        let t0 = Instant::now();

        assert_eq!(tracker.update(t0, HashMap::from([(1u64, (0, 0))])), (0, 0));
        assert_eq!(
            tracker.update(t0 + Duration::from_secs(1), HashMap::from([(1u64, (10_000, 5_000))])),
            (5_000, 10_000)
        );
        // 速率从 10_000/5_000 降至 4_000/2_000：旧实现二次相减会归零，新实现必须仍为正值
        assert_eq!(
            tracker.update(t0 + Duration::from_secs(2), HashMap::from([(1u64, (14_000, 7_000))])),
            (2_000, 4_000)
        );
        assert_eq!(
            tracker.update(t0 + Duration::from_secs(3), HashMap::from([(1u64, (15_000, 7_500))])),
            (500, 1_000)
        );
    }

    #[test]
    fn adapter_added_and_removed_mid_stream_has_no_spike() {
        let mut tracker = RateTracker::new();
        let t0 = Instant::now();

        assert_eq!(tracker.update(t0, HashMap::from([(1u64, (1_000, 1_000))])), (0, 0));

        // 网卡 2 中途接入，其累计计数已有大基数：本轮不应产生尖峰，只统计网卡 1
        assert_eq!(
            tracker.update(
                t0 + Duration::from_secs(1),
                HashMap::from([(1u64, (2_000, 1_500)), (2u64, (99_000_000, 88_000_000))]),
            ),
            (500, 1_000)
        );

        // 下一轮两张网卡都在前一次快照中，正常累加两者的增量
        assert_eq!(
            tracker.update(
                t0 + Duration::from_secs(2),
                HashMap::from([(1u64, (3_000, 2_000)), (2u64, (99_005_000, 88_002_000))]),
            ),
            (2_500, 6_000)
        );

        // 网卡 1 拔出后，仅统计仍在流里的网卡 2
        assert_eq!(
            tracker.update(
                t0 + Duration::from_secs(3),
                HashMap::from([(2u64, (99_008_000, 88_003_000))]),
            ),
            (1_000, 3_000)
        );
    }

    #[test]
    fn counter_reset_uses_saturating_sub() {
        let mut tracker = RateTracker::new();
        let t0 = Instant::now();

        assert_eq!(tracker.update(t0, HashMap::from([(1u64, (50_000, 20_000))])), (0, 0));
        // 驱动重置导致计数器归小：不溢出，安全返回 0
        assert_eq!(
            tracker.update(t0 + Duration::from_secs(1), HashMap::from([(1u64, (500, 100))])),
            (0, 0)
        );
        // 之后恢复正常增量计算
        assert_eq!(
            tracker.update(t0 + Duration::from_secs(2), HashMap::from([(1u64, (1_500, 600))])),
            (500, 1_000)
        );
    }

    #[test]
    fn prefers_active_hardware_and_excludes_virtual_filter_loopback_tunnel() {
        let phys = nic(1, 100, 200);
        let virt = NicRow { hardware: false, ..nic(2, 9_999, 9_999) };
        let filter = NicRow { filter: true, ..nic(3, 8_888, 8_888) };
        let loopback = NicRow { is_loopback: true, ..nic(4, 7_777, 7_777) };
        let tunnel = NicRow { is_tunnel: true, ..nic(5, 6_666, 6_666) };
        let disconnected = NicRow { media_connected: false, ..nic(6, 5_555, 5_555) };
        let down = NicRow { oper_up: false, ..nic(7, 4_444, 4_444) };

        let selected = select_interface_octets(&[phys, virt, filter, loopback, tunnel, disconnected, down]);
        assert_eq!(selected, HashMap::from([(1, (100, 200))]));
    }

    #[test]
    fn falls_back_to_active_virtual_nic_in_vm_without_hardware_nics() {
        let vm_nic = NicRow { hardware: false, ..nic(10, 300, 400) };
        let filter = NicRow { hardware: false, filter: true, ..nic(11, 1_000, 1_000) };
        let loopback = NicRow { hardware: false, is_loopback: true, ..nic(12, 1_000, 1_000) };
        let tunnel = NicRow { hardware: false, is_tunnel: true, ..nic(13, 1_000, 1_000) };
        let no_mac = NicRow { hardware: false, has_mac: false, ..nic(14, 1_000, 1_000) };
        let no_speed = NicRow { hardware: false, has_link_speed: false, ..nic(15, 1_000, 1_000) };
        let disconnected = NicRow { hardware: false, media_connected: false, ..nic(16, 1_000, 1_000) };

        let selected = select_interface_octets(&[
            vm_nic,
            filter,
            loopback,
            tunnel,
            no_mac,
            no_speed,
            disconnected,
        ]);
        assert_eq!(selected, HashMap::from([(10, (300, 400))]));
    }

    #[cfg(windows)]
    #[test]
    fn windows_get_if_table2_smoke() {
        assert!(read_windows_interfaces().is_some());
        let mut sampler = NetSampler::new();
        assert_eq!(sampler.sample(), (0, 0));
        let _ = sampler.sample();
    }
}
