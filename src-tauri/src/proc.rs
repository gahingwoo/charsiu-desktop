// SPDX-License-Identifier: GPL-2.0-only
//
// Finding and running charsiu's front door, and making sure what it starts
// dies with it.
//
// Windows: the front door is charsiu.ps1 (windows_candidates says where it
// is looked for), so the process tree is
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
    match first_file(candidates()) {
        Some(p) => Ok(p),
        None => Err("charsiu is not installed".into()),
    }
}

fn first_file(c: Vec<PathBuf>) -> Option<PathBuf> {
    c.into_iter().find(|p| p.is_file())
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    let path: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    windows_candidates(
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("ProgramFiles").map(PathBuf::from),
        &path,
    )
}

/// Where the front door is looked for on Windows, in this order:
/// - `%LOCALAPPDATA%\Programs\charsiu\charsiu.ps1`, charsiu-install.ps1's
///   per-user install, which someone installed on purpose;
/// - `%ProgramFiles%\RK3576\npu\charsiu.ps1`, the RK3576 tools' copy
///   (woa-rk3576 tools/rk3576-tools; Maskrom Studio installs it);
/// - on PATH, a `charsiu.ps1`, or the `charsiu.ps1` one folder above a
///   `bin\charsiu.cmd` (both installs put only that shim on PATH, and the
///   app runs the script itself, not through cmd).
///
/// Not cfg(windows), so its tests run everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_candidates(
    local_app_data: Option<PathBuf>,
    program_files: Option<PathBuf>,
    path: &[PathBuf],
) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(l) = local_app_data {
        v.push(l.join("Programs").join("charsiu").join("charsiu.ps1"));
    }
    if let Some(pf) = program_files {
        v.push(pf.join("RK3576").join("npu").join("charsiu.ps1"));
    }
    for d in path {
        v.push(d.join("charsiu.ps1"));
        let is_bin = d
            .file_name()
            .map(|n| n.eq_ignore_ascii_case("bin"))
            .unwrap_or(false);
        if is_bin && d.join("charsiu.cmd").is_file() {
            if let Some(up) = d.parent() {
                v.push(up.join("charsiu.ps1"));
            }
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
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
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

#[cfg(test)]
mod tests {
    use super::{first_file, windows_candidates};
    use std::fs;
    use std::path::{Path, PathBuf};

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(name: &str) -> Tmp {
            let name = format!("charsiu-desktop-{name}-{}", std::process::id());
            let d = std::env::temp_dir().join(name);
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(&d).unwrap();
            Tmp(d)
        }
        fn file(&self, rel: &[&str]) -> PathBuf {
            let p = rel.iter().fold(self.0.clone(), |p, r| p.join(r));
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, b"#").unwrap();
            p
        }
        fn dir(&self, rel: &[&str]) -> PathBuf {
            let p = rel.iter().fold(self.0.clone(), |p, r| p.join(r));
            fs::create_dir_all(&p).unwrap();
            p
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn find(t: &Tmp, path: &[PathBuf]) -> Option<PathBuf> {
        first_file(windows_candidates(
            Some(t.0.join("Local")),
            Some(t.0.join("Program Files")),
            path,
        ))
    }

    fn tools(t: &Tmp) -> PathBuf {
        t.file(&["Program Files", "RK3576", "npu", "bin", "charsiu.cmd"]);
        t.file(&["Program Files", "RK3576", "npu", "charsiu.ps1"])
    }

    #[test]
    fn nothing_installed() {
        let t = Tmp::new("none");
        let other = t.dir(&["Windows", "System32"]);
        assert_eq!(find(&t, &[other]), None);
    }

    #[test]
    fn the_rk3576_tools_alone() {
        let t = Tmp::new("tools");
        let ps1 = tools(&t);
        assert_eq!(find(&t, &[]), Some(ps1));
    }

    #[test]
    fn the_users_own_install_comes_first() {
        let t = Tmp::new("both");
        tools(&t);
        let own = t.file(&["Local", "Programs", "charsiu", "charsiu.ps1"]);
        assert_eq!(find(&t, &[]), Some(own));
    }

    #[test]
    fn a_bin_charsiu_cmd_on_path_means_the_script_above_it() {
        let t = Tmp::new("path");
        t.file(&["D", "charsiu", "bin", "charsiu.cmd"]);
        let ps1 = t.file(&["D", "charsiu", "charsiu.ps1"]);
        let bin = t.0.join("D").join("charsiu").join("bin");
        // ProgramFiles elsewhere, nothing in it
        let got = first_file(windows_candidates(None, Some(t.0.join("none")), &[bin]));
        assert_eq!(got, Some(ps1));
    }

    #[test]
    fn a_script_above_some_other_bin_is_not_taken() {
        let t = Tmp::new("otherbin");
        t.dir(&["X", "bin"]);
        t.file(&["X", "charsiu.ps1"]);
        let bin = t.0.join("X").join("bin");
        assert_eq!(first_file(windows_candidates(None, None, &[bin])), None);
    }

    #[test]
    fn a_charsiu_ps1_on_path() {
        let t = Tmp::new("ps1path");
        let ps1 = t.file(&["Y", "charsiu.ps1"]);
        let y = Path::new(&t.0).join("Y");
        assert_eq!(first_file(windows_candidates(None, None, &[y])), Some(ps1));
    }

    #[test]
    fn the_order() {
        let v = windows_candidates(
            Some(PathBuf::from("L")),
            Some(PathBuf::from("P")),
            &[PathBuf::from("Q")],
        );
        let l = PathBuf::from("L").join("Programs");
        let p = PathBuf::from("P").join("RK3576");
        assert_eq!(v.len(), 3);
        assert_eq!(v[0], l.join("charsiu").join("charsiu.ps1"));
        assert_eq!(v[1], p.join("npu").join("charsiu.ps1"));
        assert_eq!(v[2], PathBuf::from("Q").join("charsiu.ps1"));
    }
}
