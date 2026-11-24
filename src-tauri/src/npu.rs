// SPDX-License-Identifier: GPL-2.0-only
//
// What the NPU is doing, from what each OS lets an ordinary program read.
//
// Windows: the PnP state of ACPI\RKCP3576\0 (cfgmgr32), and rknpu.sys's
// performance counters through PDH ("RK3576 NPU", one instance per core;
// "RK3576 NPU Memory"). The counters exist only once their manifest has been
// registered with lodctr, so their absence is a normal answer.
//
// Linux: the rocket accel node, the module, each NPU core's runtime PM state
// and the NPU rail.

use serde::Serialize;

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Core {
    pub name: String,
    /// Linux: runtime PM status ("active", "suspended")
    pub state: Option<String>,
    /// Windows: % Busy Time
    pub busy: Option<f64>,
    /// Windows: Jobs/sec
    pub jobs_per_sec: Option<f64>,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NpuStatus {
    pub platform: String,
    /// "started", "problem", "absent" (Windows); "present", "absent" (Linux)
    pub device: String,
    /// Windows: the PnP problem code when device == "problem"
    pub problem: Option<u32>,
    /// Linux: rocket is loaded
    pub driver_loaded: Option<bool>,
    pub cores: Vec<Core>,
    /// Windows: "ok", "absent" (not registered)
    pub counters: String,
    pub buffer_bytes: Option<f64>,
    /// Linux: the NPU rail's state
    pub rail: Option<String>,
}

#[cfg(target_os = "linux")]
pub fn status() -> NpuStatus {
    use std::fs;
    let mut s = NpuStatus {
        platform: "linux".into(),
        counters: "n/a".into(),
        ..Default::default()
    };
    let accel = fs::read_dir("/dev/accel")
        .map(|d| {
            d.flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with("accel"))
        })
        .unwrap_or(false);
    s.device = if accel { "present" } else { "absent" }.into();
    s.driver_loaded = Some(std::path::Path::new("/sys/module/rocket").exists());
    if let Ok(d) = fs::read_dir("/sys/bus/platform/devices") {
        let mut v: Vec<_> = d
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".npu"))
            .collect();
        v.sort_by_key(|e| e.file_name());
        for e in v {
            let st = fs::read_to_string(e.path().join("power/runtime_status"))
                .ok()
                .map(|x| x.trim().to_string());
            s.cores.push(Core {
                name: e.file_name().to_string_lossy().to_string(),
                state: st,
                ..Default::default()
            });
        }
    }
    if let Ok(d) = fs::read_dir("/sys/class/regulator") {
        for e in d.flatten() {
            let n = fs::read_to_string(e.path().join("name")).unwrap_or_default();
            if n.trim() == "vdd_npu_s0" {
                s.rail = fs::read_to_string(e.path().join("state"))
                    .ok()
                    .map(|x| x.trim().to_string());
            }
        }
    }
    s
}

#[cfg(windows)]
pub fn status() -> NpuStatus {
    let mut s = NpuStatus {
        platform: "windows".into(),
        ..Default::default()
    };
    match win::devnode("ACPI\\RKCP3576\\0") {
        win::Dev::Absent => s.device = "absent".into(),
        win::Dev::Started => s.device = "started".into(),
        win::Dev::Problem(p) => {
            s.device = "problem".into();
            s.problem = Some(p);
        }
    }
    match win::counters() {
        Some((cores, bytes)) => {
            s.counters = "ok".into();
            s.cores = cores;
            s.buffer_bytes = bytes;
        }
        None => s.counters = "absent".into(),
    }
    s
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn status() -> NpuStatus {
    NpuStatus {
        platform: std::env::consts::OS.into(),
        device: "absent".into(),
        counters: "n/a".into(),
        ..Default::default()
    }
}

#[cfg(windows)]
mod win {
    use super::Core;
    use std::ffi::c_void;
    use std::sync::Mutex;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // ---- cfgmgr32 ----------------------------------------------------------

    const CR_SUCCESS: u32 = 0;
    const DN_STARTED: u32 = 0x0000_0008;
    const DN_HAS_PROBLEM: u32 = 0x0000_0400;

    #[link(name = "cfgmgr32")]
    extern "system" {
        fn CM_Locate_DevNodeW(dev: *mut u32, id: *const u16, flags: u32) -> u32;
        fn CM_Get_DevNode_Status(status: *mut u32, problem: *mut u32, dev: u32, flags: u32) -> u32;
    }

    pub enum Dev {
        Absent,
        Started,
        Problem(u32),
    }

    pub fn devnode(id: &str) -> Dev {
        let w = wide(id);
        let mut dn = 0u32;
        let mut st = 0u32;
        let mut pr = 0u32;
        // SAFETY: valid out pointers and a NUL-terminated id
        unsafe {
            if CM_Locate_DevNodeW(&mut dn, w.as_ptr(), 0) != CR_SUCCESS {
                return Dev::Absent;
            }
            if CM_Get_DevNode_Status(&mut st, &mut pr, dn, 0) != CR_SUCCESS {
                return Dev::Problem(0);
            }
        }
        if st & DN_HAS_PROBLEM != 0 {
            Dev::Problem(pr)
        } else if st & DN_STARTED != 0 {
            Dev::Started
        } else {
            Dev::Problem(pr)
        }
    }

    // ---- PDH ---------------------------------------------------------------

    type PdhHandle = isize;
    const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
    const PDH_MORE_DATA: u32 = 0x8000_07D2;
    const ERROR_SUCCESS: u32 = 0;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FmtValue {
        cstatus: u32,
        value: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FmtItem {
        name: *const u16,
        value: FmtValue,
    }

    #[link(name = "pdh")]
    extern "system" {
        fn PdhOpenQueryW(source: *const u16, user: usize, query: *mut PdhHandle) -> u32;
        fn PdhAddEnglishCounterW(
            query: PdhHandle,
            path: *const u16,
            user: usize,
            counter: *mut PdhHandle,
        ) -> u32;
        fn PdhCollectQueryData(query: PdhHandle) -> u32;
        fn PdhGetFormattedCounterArrayW(
            counter: PdhHandle,
            format: u32,
            size: *mut u32,
            count: *mut u32,
            items: *mut c_void,
        ) -> u32;
        fn PdhGetFormattedCounterValue(
            counter: PdhHandle,
            format: u32,
            kind: *mut u32,
            value: *mut FmtValue,
        ) -> u32;
        fn PdhCloseQuery(query: PdhHandle) -> u32;
    }

    struct Query {
        q: PdhHandle,
        busy: PdhHandle,
        jobs: PdhHandle,
        bytes: PdhHandle,
    }

    impl Drop for Query {
        fn drop(&mut self) {
            // SAFETY: our own query handle
            unsafe {
                PdhCloseQuery(self.q);
            }
        }
    }

    /// Kept open between polls: rates and % Busy Time need two samples.
    static QUERY: Mutex<Option<Query>> = Mutex::new(None);

    fn open() -> Option<Query> {
        // SAFETY: documented PDH calls with valid out pointers
        unsafe {
            let mut q: PdhHandle = 0;
            if PdhOpenQueryW(std::ptr::null(), 0, &mut q) != ERROR_SUCCESS {
                return None;
            }
            let add = |path: &str| -> Option<PdhHandle> {
                let w = wide(path);
                let mut c: PdhHandle = 0;
                // SAFETY: q is open, w is NUL-terminated
                (unsafe { PdhAddEnglishCounterW(q, w.as_ptr(), 0, &mut c) } == ERROR_SUCCESS)
                    .then_some(c)
            };
            let busy = add("\\RK3576 NPU(*)\\% Busy Time");
            let jobs = add("\\RK3576 NPU(*)\\Jobs/sec");
            let bytes = add("\\RK3576 NPU Memory\\Buffer Bytes");
            match (busy, jobs, bytes) {
                (Some(busy), Some(jobs), Some(bytes)) => {
                    PdhCollectQueryData(q);
                    Some(Query {
                        q,
                        busy,
                        jobs,
                        bytes,
                    })
                }
                _ => {
                    PdhCloseQuery(q);
                    None
                }
            }
        }
    }

    fn array(counter: PdhHandle) -> Vec<(String, f64)> {
        let mut out = Vec::new();
        // SAFETY: the buffer is sized by PDH's first call and 8-aligned
        unsafe {
            let mut size = 0u32;
            let mut count = 0u32;
            let r = PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                std::ptr::null_mut(),
            );
            if r != PDH_MORE_DATA || size == 0 {
                return out;
            }
            let mut buf = vec![0u64; (size as usize).div_ceil(8)];
            let r = PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                buf.as_mut_ptr() as *mut c_void,
            );
            if r != ERROR_SUCCESS {
                return out;
            }
            let items = std::slice::from_raw_parts(buf.as_ptr() as *const FmtItem, count as usize);
            for it in items {
                let mut n = 0usize;
                while *it.name.add(n) != 0 {
                    n += 1;
                }
                let name = String::from_utf16_lossy(std::slice::from_raw_parts(it.name, n));
                if name != "_Total" {
                    out.push((name, it.value.value));
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    pub fn counters() -> Option<(Vec<Core>, Option<f64>)> {
        let mut g = QUERY.lock().unwrap();
        if g.is_none() {
            *g = open();
        }
        let q = g.as_ref()?;
        // SAFETY: our own query
        if unsafe { PdhCollectQueryData(q.q) } != ERROR_SUCCESS {
            *g = None;
            return None;
        }
        let busy = array(q.busy);
        let jobs = array(q.jobs);
        let cores = busy
            .iter()
            .map(|(n, b)| Core {
                name: n.clone(),
                busy: Some(*b),
                jobs_per_sec: jobs.iter().find(|(m, _)| m == n).map(|(_, j)| *j),
                state: None,
            })
            .collect();
        let mut v = FmtValue {
            cstatus: 0,
            value: 0.0,
        };
        let mut kind = 0u32;
        // SAFETY: valid out pointers
        let bytes =
            (unsafe { PdhGetFormattedCounterValue(q.bytes, PDH_FMT_DOUBLE, &mut kind, &mut v) }
                == ERROR_SUCCESS)
                .then_some(v.value);
        Some((cores, bytes))
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn layout() {
            // PDH_FMT_COUNTERVALUE_ITEM_W on 64-bit: a pointer, then a
            // 16-byte PDH_FMT_COUNTERVALUE
            assert_eq!(std::mem::size_of::<super::FmtItem>(), 24);
        }
    }
}
