//! PTY シェルの実 cwd 取得（変更ストリップの監視先追従用）。
//! OSC 7 はシェル統合が無いと飛んでこないため、シェルプロセスのカレント
//! ディレクトリを OS から直接読む。cd に確実に追従できる。

#[cfg(target_os = "macos")]
pub(crate) fn pid_cwd(pid: i32) -> Option<String> {
    extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            buffersize: i32,
        ) -> i32;
    }
    // struct proc_vnodepathinfo（サイズ 2352）。pvi_cdir.vip_path は
    // オフセット 152（vinfo_stat 136 + vi_type/vi_pad/vi_fsid 16）から MAXPATHLEN(1024)
    const PROC_PIDVNODEPATHINFO: i32 = 9;
    const SIZE: usize = 2352;
    const PATH_OFF: usize = 152;
    let mut buf = [0u8; SIZE];
    let n = unsafe {
        proc_pidinfo(
            pid,
            PROC_PIDVNODEPATHINFO,
            0,
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            SIZE as i32,
        )
    };
    if n <= 0 {
        return None;
    }
    let path = &buf[PATH_OFF..PATH_OFF + 1024];
    let end = path.iter().position(|&b| b == 0)?;
    if end == 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&path[..end]).into_owned())
}

#[cfg(target_os = "linux")]
pub(crate) fn pid_cwd(pid: i32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Windows には proc_pidinfo / /proc に相当する公開 API が無いため、対象プロセスの
/// PEB → RTL_USER_PROCESS_PARAMETERS.CurrentDirectory を ReadProcessMemory で読む
/// （Windows Terminal がタブ複製の cwd 継承に使っているのと同じ手口）。
/// SetCurrentDirectory を呼ぶシェル（cmd.exe / Git Bash / MSYS bash）はこれで cd に
/// 追従する。**PowerShell は Set-Location でプロセスの CWD を変えない**仕様なので、
/// `pty_spawn` が OSC 7 を吐くプロンプトを注入して補う（`shell::powershell_bootstrap_args`）
#[cfg(windows)]
pub(crate) fn pid_cwd(pid: i32) -> Option<String> {
    use std::ffi::c_void;

    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_VM_READ: u32 = 0x0010;
    const PROCESS_BASIC_INFORMATION: u32 = 0;
    // PEB / RTL_USER_PROCESS_PARAMETERS の固定オフセット（NT の公開ヘッダに無い内部構造）。
    // 32bit プロセスから 64bit プロセスは読めないが、アプリと PTY の子プロセスは
    // 同じビット数で動くので実用上問題にならない
    #[cfg(target_pointer_width = "64")]
    const PEB_PARAMS_OFF: usize = 0x20;
    #[cfg(target_pointer_width = "64")]
    const CURDIR_OFF: usize = 0x38;
    #[cfg(target_pointer_width = "32")]
    const PEB_PARAMS_OFF: usize = 0x10;
    #[cfg(target_pointer_width = "32")]
    const CURDIR_OFF: usize = 0x24;
    // Windows のパス長上限（\\?\ 付きで 32767 文字）。壊れた値で巨大確保をしない
    const MAX_PATH_BYTES: usize = 32767 * 2;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, pid: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn ReadProcessMemory(
            handle: isize,
            address: *const c_void,
            buffer: *mut c_void,
            size: usize,
            read: *mut usize,
        ) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            handle: isize,
            class: u32,
            info: *mut c_void,
            len: u32,
            ret_len: *mut u32,
        ) -> i32;
    }

    /// 途中で return しても必ず閉じる
    struct ProcHandle(isize);
    impl Drop for ProcHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    if pid <= 0 {
        return None;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid as u32) };
    if handle == 0 {
        return None; // 終了済み / 権限不足
    }
    let handle = ProcHandle(handle);

    let ptr_size = std::mem::size_of::<usize>();
    let read = |address: usize, out: &mut [u8]| -> bool {
        if address == 0 {
            return false;
        }
        let mut got = 0usize;
        let ok = unsafe {
            ReadProcessMemory(
                handle.0,
                address as *const c_void,
                out.as_mut_ptr() as *mut c_void,
                out.len(),
                &mut got,
            )
        };
        ok != 0 && got == out.len()
    };
    let read_ptr = |address: usize| -> Option<usize> {
        let mut buf = [0u8; 8];
        if !read(address, &mut buf[..ptr_size]) {
            return None;
        }
        Some(usize::from_ne_bytes(
            buf[..ptr_size].try_into().expect("ptr_size は 4 か 8"),
        ))
    };

    // PROCESS_BASIC_INFORMATION は ptr_size * 6。PebBaseAddress は 2 番目のフィールド
    let mut pbi = [0u8; 48];
    let pbi_size = ptr_size * 6;
    let status = unsafe {
        NtQueryInformationProcess(
            handle.0,
            PROCESS_BASIC_INFORMATION,
            pbi.as_mut_ptr() as *mut c_void,
            pbi_size as u32,
            std::ptr::null_mut(),
        )
    };
    if status != 0 {
        return None;
    }
    let peb = usize::from_ne_bytes(
        pbi[ptr_size..ptr_size * 2]
            .try_into()
            .expect("ptr_size は 4 か 8"),
    );

    let params = read_ptr(peb + PEB_PARAMS_OFF)?;
    // CURDIR = UNICODE_STRING DosPath + HANDLE。UNICODE_STRING は
    // Length(u16) + MaximumLength(u16) + パディング + Buffer(ポインタ)
    let mut ustr = [0u8; 16];
    if !read(params + CURDIR_OFF, &mut ustr[..ptr_size * 2]) {
        return None;
    }
    let len = u16::from_ne_bytes([ustr[0], ustr[1]]) as usize;
    if len == 0 || len % 2 != 0 || len > MAX_PATH_BYTES {
        return None;
    }
    let buffer = read_ptr(params + CURDIR_OFF + ptr_size)?;
    let mut raw = vec![0u8; len];
    if !read(buffer, &mut raw) {
        return None;
    }

    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    let path = String::from_utf16_lossy(&units);
    // CurrentDirectory は "C:\Users\me\" のように区切りで終わる。フロントの normPath は
    // 末尾を落とすが、ドライブルートだけは "C:\" のまま残す必要がある
    let trimmed = path.trim_end_matches('\\');
    let out = if trimmed.is_empty() {
        path.as_str()
    } else {
        trimmed
    };
    if out.is_empty() {
        None
    } else {
        Some(out.to_string())
    }
}

/// `pid_cwd` が使う PEB / RTL_USER_PROCESS_PARAMETERS のオフセットは NT の内部構造で、
/// 間違えても実行時に静かに変な値を読むだけで気づけない。windows-sys が公開している
/// 定義（Win32::System::Threading / Win32::Foundation）と同じ形の struct を置き、
/// コンパイル時に突き合わせる。Windows 向けビルドでしか評価されない
#[cfg(windows)]
const _: () = {
    use std::ffi::c_void;
    use std::mem::{offset_of, size_of};

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }
    #[repr(C)]
    struct Peb {
        reserved1: [u8; 2],
        being_debugged: u8,
        reserved2: [u8; 1],
        reserved3: [*mut c_void; 2],
        ldr: *mut c_void,
        process_parameters: *mut c_void,
    }
    #[repr(C)]
    struct ProcessParameters {
        reserved1: [u8; 16],
        // ConsoleHandle .. DllPath。この中に CurrentDirectory がある
        reserved2: [*mut c_void; 10],
        image_path_name: UnicodeString,
        command_line: UnicodeString,
    }
    #[repr(C)]
    struct BasicInformation {
        exit_status: i32,
        peb_base_address: *mut c_void,
        affinity_mask: usize,
        base_priority: i32,
        unique_process_id: usize,
        inherited_from_unique_process_id: usize,
    }

    const PTR: usize = size_of::<usize>();
    #[cfg(target_pointer_width = "64")]
    const PARAMS_OFF: usize = 0x20;
    #[cfg(target_pointer_width = "64")]
    const CURDIR: usize = 0x38;
    #[cfg(target_pointer_width = "32")]
    const PARAMS_OFF: usize = 0x10;
    #[cfg(target_pointer_width = "32")]
    const CURDIR: usize = 0x24;

    assert!(offset_of!(Peb, process_parameters) == PARAMS_OFF);
    // PebBaseAddress は 2 番目のフィールド、全体は ptr * 6
    assert!(offset_of!(BasicInformation, peb_base_address) == PTR);
    assert!(size_of::<BasicInformation>() == PTR * 6);
    // UNICODE_STRING の Buffer 位置（pid_cwd は CURDIR + PTR で読む）
    assert!(offset_of!(UnicodeString, buffer) == PTR);
    assert!(size_of::<UnicodeString>() == PTR * 2);
    // CurrentDirectory から DosPath(2) + Handle(1) + DllPath(2) = ptr 5 個分進むと
    // 公開定義の ImagePathName に着く
    assert!(offset_of!(ProcessParameters, image_path_name) == CURDIR + PTR * 5);
    assert!(offset_of!(ProcessParameters, reserved2) == 0x10);
};

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub(crate) fn pid_cwd(_pid: i32) -> Option<String> {
    None // フロントが OSC 7 / spec.cwd にフォールバックする
}

#[cfg(test)]
mod tests {
    #[test]
    fn pid_cwd_returns_own_cwd() {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let got = super::pid_cwd(std::process::id() as i32).expect("cwd should resolve");
            let want = std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            assert_eq!(got, want);
        }
        // PEB のオフセットは公開ヘッダに無いので、上のコンパイル時アサートだけでは
        // 「合っているつもり」で通ってしまう。実際に自分の PEB を読んで確かめる
        #[cfg(windows)]
        {
            let got = super::pid_cwd(std::process::id() as i32).expect("cwd should resolve");
            let want = std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            // DosPath は末尾に区切りを持ち（ドライブルートは "C:\" のまま）、
            // 大文字小文字も呼び出し側の指定で揺れる
            let norm = |s: &str| s.trim_end_matches('\\').to_ascii_lowercase();
            assert_eq!(norm(&got), norm(&want));
        }
    }
}
