// SPDX-License-Identifier: GPL-2.0-only
//
// Starting the app again as administrator, for when the NPU admits only
// administrators: rknpu.sys lets ordinary users in once its Device
// Parameters\UserAccess is 1, which the RK3576 tools and charsiu's installer
// set, but it reads that when the device starts, so until the next restart
// only an elevated `charsiu serve` gets the NPU.
//
// The whole app starts again elevated, not only the server: an elevated
// child of an ordinary process could not be put in its job object or have
// its output read. The new instance gets `--after-pid <pid>` and waits for
// this one to be gone first, because WebView2 refuses a data folder that a
// process of the other elevation still holds.

/// `--after-pid N` among the arguments.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn after_pid(args: impl IntoIterator<Item = String>) -> Option<u32> {
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if a == "--after-pid" {
            return it.next().and_then(|n| n.parse().ok());
        }
    }
    None
}

#[cfg(windows)]
mod win {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "shell32")]
    extern "system" {
        fn IsUserAnAdmin() -> i32;
        fn ShellExecuteW(
            hwnd: *mut c_void,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> *mut c_void;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(h: *mut c_void, ms: u32) -> u32;
        fn CloseHandle(h: *mut c_void) -> i32;
    }

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn is_elevated() -> bool {
        // SAFETY: no arguments; true only for an elevated token under UAC
        unsafe { IsUserAnAdmin() != 0 }
    }

    pub fn relaunch() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let params = format!("--after-pid {}", std::process::id());
        let op = wide(OsStr::new("runas"));
        let file = wide(exe.as_os_str());
        let params = wide(OsStr::new(&params));
        // SAFETY: NUL-terminated wide strings that outlive the call
        let r = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                params.as_ptr(),
                std::ptr::null(),
                1,
            )
        } as isize;
        // above 32 is success; the UAC prompt answered No is an error too
        if r > 32 {
            Ok(())
        } else {
            Err(format!("Windows did not start it as administrator ({r})"))
        }
    }

    pub fn wait_for(pid: u32) {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        // SAFETY: a handle we open, wait on and close
        unsafe {
            let h = OpenProcess(SYNCHRONIZE, 0, pid);
            if !h.is_null() {
                WaitForSingleObject(h, 15_000);
                CloseHandle(h);
            }
        }
        // its WebView2 processes end just after it
        std::thread::sleep(std::time::Duration::from_millis(700));
    }
}

#[cfg(windows)]
pub use win::{is_elevated, relaunch};

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

#[cfg(not(windows))]
pub fn relaunch() -> Result<(), String> {
    Err("only on Windows".into())
}

/// The instance this one replaces, if it was started by `relaunch`, is gone.
#[cfg(windows)]
pub fn wait_for_previous() {
    if let Some(pid) = after_pid(std::env::args().skip(1)) {
        win::wait_for(pid);
    }
}

#[cfg(not(windows))]
pub fn wait_for_previous() {}

#[cfg(test)]
mod tests {
    use super::after_pid;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_pid_of_the_instance_it_replaces() {
        assert_eq!(after_pid(args(&["--after-pid", "4242"])), Some(4242));
        assert_eq!(after_pid(args(&["x", "--after-pid", "7", "y"])), Some(7));
    }

    #[test]
    fn nothing_or_nonsense() {
        assert_eq!(after_pid(args(&[])), None);
        assert_eq!(after_pid(args(&["--after-pid"])), None);
        assert_eq!(after_pid(args(&["--after-pid", "me"])), None);
        assert_eq!(after_pid(args(&["4242"])), None);
    }
}
