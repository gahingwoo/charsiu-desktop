// SPDX-License-Identifier: GPL-2.0-only
//
// Finding and running charsiu's front door, and making sure what it starts
// dies with it.
//
// Windows: the front door is charsiu.ps1, so the process tree is
// powershell.exe -> charsiu_serve.exe. Killing powershell alone would leave
// the server holding the NPU, so every child goes into a job object that
// kills the whole tree when it is closed, including when this app crashes.
//
// Linux: `charsiu serve` execs charsiu_serve, so the pid is the server. It
// still runs in a process group of its own (a pull runs curl under sh), which
// is stopped as a whole when the app quits.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// The front door, or why there is none.
pub fn charsiu_path(override_path: &str) -> Result<PathBuf, String> {
    let o = override_path.trim();
    if !o.is_empty() {
        let p = PathBuf::from(o);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!("{o} does not exist"))
        };
    }
    for p in candidates() {
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("charsiu is not installed".into())
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        v.push(Path::new(&l).join("Programs").join("charsiu").join("charsiu.ps1"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            v.push(d.join("charsiu.ps1"));
        }
    }
    v
}

#[cfg(not(windows))]
fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            v.push(d.join("charsiu"));
        }
    }
    v.push(PathBuf::from("/usr/bin/charsiu"));
    v.push(PathBuf::from("/usr/local/bin/charsiu"));
    if let Some(h) = std::env::var_os("HOME") {
        v.push(Path::new(&h).join(".local/bin/charsiu"));
    }
    v
}

/// `charsiu ARGS...` as a Command, with stdin closed and both outputs piped.
pub fn command(front: &Path, args: &[&str]) -> Command {
    let mut c = base(front);
    c.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // never draw a progress bar into a pipe, never ask a question
    c.env("CHARSIU_NO_PROGRESS", "1");
    platform_setup(&mut c);
    c
}

#[cfg(windows)]
fn base(front: &Path) -> Command {
    let ext = front
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "ps1" {
        let ps = std::env::var_os("SystemRoot")
            .map(|r| {
                Path::new(&r)
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe")
            })
            .filter(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from("powershell.exe"));
        let mut c = Command::new(ps);
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(front);
        c
    } else {
        Command::new(front)
    }
}

#[cfg(not(windows))]
fn base(front: &Path) -> Command {
    Command::new(front)
}

#[cfg(windows)]
fn platform_setup(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    c.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn platform_setup(c: &mut Command) {
    use std::os::unix::process::CommandExt;
    // its own group, so stopping it stops what it started (curl under sh).
    // Not PR_SET_PDEATHSIG: that fires when the spawning THREAD exits, and
    // these are spawned from the async runtime's blocking pool, whose idle
    // threads exit after a few seconds.
    c.process_group(0);
}

#[cfg(not(any(windows, unix)))]
fn platform_setup(_c: &mut Command) {}

/// A running child and whatever keeps its tree together.
pub struct Proc {
    pub child: Child,
    #[cfg(windows)]
    job: Option<win::Job>,
}

impl Proc {
    #[cfg(windows)]
    pub fn spawn(mut c: Command) -> std::io::Result<Proc> {
        let child = c.spawn()?;
        let job = win::Job::new().ok();
        if let Some(j) = &job {
            j.assign(&child);
        }
        Ok(Proc { child, job })
    }

    #[cfg(not(windows))]
    pub fn spawn(mut c: Command) -> std::io::Result<Proc> {
        Ok(Proc { child: c.spawn()? })
    }

    /// Stop the child and everything it started, and reap it.
    #[cfg(windows)]
    pub fn kill(&mut self) {
        match &self.job {
            Some(j) => j.terminate(),
            None => {
                let _ = self.child.kill();
            }
        }
        let _ = self.child.wait();
    }

    /// Stop the child and everything it started, and reap it.
    #[cfg(unix)]
    pub fn kill(&mut self) {
        use std::time::{Duration, Instant};
        let pg = self.child.id() as libc::pid_t;
        let exited = matches!(self.child.try_wait(), Ok(Some(_)));
        // SAFETY: plain signals to the process group this child leads
        unsafe {
            libc::kill(-pg, libc::SIGTERM);
        }
        if !exited {
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(3) {
                if let Ok(Some(_)) = self.child.try_wait() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        // anything still in the group goes now
        unsafe {
            libc::kill(-pg, libc::SIGKILL);
        }
        let _ = self.child.wait();
    }

    #[cfg(not(any(windows, unix)))]
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    type Handle = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        v: [u64; 6],
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn CloseHandle(h: Handle) -> i32;
    }

    pub struct Job(Handle);
    // SAFETY: a job handle may be used and closed from any thread
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Result<Job, ()> {
            // SAFETY: documented calls with a correctly laid out structure
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(());
                }
                let mut info = ExtendedLimit::default();
                info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<ExtendedLimit>() as u32,
                );
                if ok == 0 {
                    CloseHandle(h);
                    return Err(());
                }
                Ok(Job(h))
            }
        }

        pub fn assign(&self, child: &Child) {
            // SAFETY: the child's process handle is valid while Child lives
            unsafe {
                AssignProcessToJobObject(self.0, child.as_raw_handle() as Handle);
            }
        }

        pub fn terminate(&self) {
            // SAFETY: our own handle
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing the last handle kills the tree (KILL_ON_JOB_CLOSE)
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn layout() {
            // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows
            assert_eq!(std::mem::size_of::<super::ExtendedLimit>(), 144);
        }
    }
}
