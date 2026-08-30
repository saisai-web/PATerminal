//! 実行中の AI エージェント CLI（claude / codex）の検知。
//! ペインのシェルの子孫プロセスを走査し、argv からエージェント名を判定する。
//! セッション保存時の「実行中エージェント」記録（復元時の自動再開）と、
//! エージェント終了バナーの検知に使う。
//!
//! macOS / Linux は `ps` を1回だけ実行してプロセステーブルを取り、全ペイン分を
//! その1枚から解決する（5秒スイープ×ペイン数の FFI やサブプロセスを作らない）。
//! Windows は Toolhelp スナップショット + node 等のラッパーだけ PEB のコマンドライン
//! 読み取りで補完する。cwd.rs と同じく、クレートの他部分に依存しない**単体で
//! 切り出せる**モジュールにしてある（Windows 固有部分を
//! `rustc --target ... --emit=metadata` で型チェックするため）。

use std::collections::HashMap;

/// 検知対象のエージェント CLI。argv の実行名と突き合わせる。
/// 追加するときはフロント側 `src/features/agents/agents.ts` の再開コマンド表も揃えること
const AGENT_NAMES: [&str; 2] = ["claude", "codex"];

/// node 等の実行環境。argv[0] がこれらのときだけスクリプトパス（argv[1] 以降）も見る
const WRAPPER_NAMES: [&str; 4] = ["node", "bun", "deno", "volta-shim"];

pub(crate) struct ProcEntry {
    pub pid: i32,
    pub ppid: i32,
    /// コマンドラインを空白で分割した語。argv 相当（パスに空白を含む場合は崩れるが、
    /// 対象 CLI の実行名判定には影響しない）
    pub words: Vec<String>,
}

/// パス・拡張子を落とした1語がエージェント名か。
/// "claude" / "claude.exe" / "codex-x86_64-pc-windows-msvc.exe" は拾い、
/// "claudette" のような別コマンドは拾わない
fn agent_from_word(word: &str) -> Option<&'static str> {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let base = base.to_ascii_lowercase();
    AGENT_NAMES.iter().copied().find(|name| {
        base == *name
            || (base.starts_with(name)
                && matches!(base.as_bytes().get(name.len()), Some(b'.') | Some(b'-')))
    })
}

/// スクリプトパスからの判定。基本は実行名（basename）のみ。
/// npm 配布の CLI は `.../node_modules/@anthropic-ai/claude-code/cli.js` のように
/// basename が cli.js になるため、node_modules 配下に限りパス成分も見る
fn agent_from_script_path(path: &str) -> Option<&'static str> {
    if let Some(kind) = agent_from_word(path) {
        return Some(kind);
    }
    if path.contains("node_modules") {
        for comp in path.split(['/', '\\']) {
            if let Some(kind) = agent_from_word(comp) {
                return Some(kind);
            }
        }
    }
    None
}

/// 1プロセスの argv 相当からエージェント種別を判定する
pub(crate) fn agent_from_args(words: &[String]) -> Option<&'static str> {
    let first = words.first()?;
    if let Some(kind) = agent_from_word(first) {
        return Some(kind);
    }
    // node 経由（npm / volta インストール）の CLI は argv[0] が node になる。
    // オプションを飛ばした最初の引数 = スクリプトパスだけを判定に使う
    // （それ以外の引数まで見ると `vim claude-notes.md` のような別コマンドを誤検知する）
    let base0 = first.rsplit(['/', '\\']).next().unwrap_or(first);
    let base0 = base0.to_ascii_lowercase();
    let base0 = base0.strip_suffix(".exe").unwrap_or(&base0);
    if WRAPPER_NAMES.contains(&base0) {
        if let Some(script) = words.iter().skip(1).find(|w| !w.starts_with('-')) {
            return agent_from_script_path(script);
        }
    }
    None
}

/// root（シェルの pid）自身とその子孫からエージェントを探す（幅優先・深さ上限つき）。
/// pid 再利用による循環に備えて visited を持つ
pub(crate) fn find_agent(table: &[ProcEntry], root: i32) -> Option<&'static str> {
    let mut children: HashMap<i32, Vec<&ProcEntry>> = HashMap::new();
    for entry in table {
        children.entry(entry.ppid).or_default().push(entry);
    }
    let mut visited = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::from([(root, 0usize)]);
    while let Some((pid, depth)) = queue.pop_front() {
        if depth > 6 || !visited.insert(pid) {
            continue;
        }
        if pid != root {
            if let Some(entry) = table.iter().find(|e| e.pid == pid) {
                if let Some(kind) = agent_from_args(&entry.words) {
                    return Some(kind);
                }
            }
        }
        if let Some(kids) = children.get(&pid) {
            for kid in kids {
                queue.push_back((kid.pid, depth + 1));
            }
        }
    }
    // 直接起動ペイン（シェル無しで claude を spawn）は root 自身がエージェント
    table
        .iter()
        .find(|e| e.pid == root)
        .and_then(|e| agent_from_args(&e.words))
}

/// 各ペインのシェル pid → 検知したエージェント種別。1回のプロセステーブル取得で
/// 全ペイン分を解決する
pub(crate) fn scan_agents(shell_pids: &[(String, i32)]) -> HashMap<String, Option<String>> {
    let table = process_table();
    shell_pids
        .iter()
        .map(|(id, pid)| {
            (
                id.clone(),
                find_agent(&table, *pid).map(|kind| kind.to_string()),
            )
        })
        .collect()
}

/// `ps -axo pid=,ppid=,args=` の1行を (pid, ppid, words) に分解する
#[cfg(unix)]
pub(crate) fn parse_ps_line(line: &str) -> Option<ProcEntry> {
    let mut it = line.split_whitespace();
    let pid: i32 = it.next()?.parse().ok()?;
    let ppid: i32 = it.next()?.parse().ok()?;
    let words: Vec<String> = it.map(str::to_string).collect();
    if words.is_empty() {
        return None;
    }
    Some(ProcEntry { pid, ppid, words })
}

#[cfg(unix)]
fn process_table() -> Vec<ProcEntry> {
    // ps はスイープ1回につき1度だけ。失敗（環境不備）は「検知なし」に退化する
    let out = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,args="])
        .output();
    let Ok(out) = out else { return Vec::new() };
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().filter_map(parse_ps_line).collect()
}

/// Windows 用: コマンドライン文字列を引用符を考慮して語に分割する
#[cfg(any(windows, test))]
pub(crate) fn split_cmdline(cmdline: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in cmdline.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    words.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

/// Windows: Toolhelp スナップショットで pid / ppid / 実行名を取り、
/// node 等のラッパーだけ PEB からコマンドラインを読んでスクリプトパスを補完する
#[cfg(windows)]
fn process_table() -> Vec<ProcEntry> {
    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    struct Snapshot(isize);
    impl Drop for Snapshot {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return Vec::new();
    }
    let snapshot = Snapshot(snapshot);

    let mut entry = ProcessEntry32W {
        dw_size: std::mem::size_of::<ProcessEntry32W>() as u32,
        cnt_usage: 0,
        th32_process_id: 0,
        th32_default_heap_id: 0,
        th32_module_id: 0,
        cnt_threads: 0,
        th32_parent_process_id: 0,
        pc_pri_class_base: 0,
        dw_flags: 0,
        sz_exe_file: [0; 260],
    };
    let mut table = Vec::new();
    let mut ok = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while ok != 0 {
        let end = entry
            .sz_exe_file
            .iter()
            .position(|&u| u == 0)
            .unwrap_or(entry.sz_exe_file.len());
        let exe = String::from_utf16_lossy(&entry.sz_exe_file[..end]);
        let pid = entry.th32_process_id as i32;
        let exe_lower = exe.to_ascii_lowercase();
        // node.exe 等のラッパーはスクリプトパスを見ないと CLI 名が分からない。
        // それ以外は実行名だけで十分なのでプロセスメモリには触らない
        let words = if WRAPPER_NAMES
            .iter()
            .any(|w| exe_lower == format!("{w}.exe") || exe_lower == *w)
        {
            match pid_cmdline(pid) {
                Some(cmdline) => split_cmdline(&cmdline),
                None => vec![exe],
            }
        } else {
            vec![exe]
        };
        table.push(ProcEntry {
            pid,
            ppid: entry.th32_parent_process_id as i32,
            words,
        });
        ok = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    table
}

/// Windows: 対象プロセスの PEB → RTL_USER_PROCESS_PARAMETERS.CommandLine を読む。
/// `cwd.rs` の pid_cwd と同じ手口で、オフセットだけ CurrentDirectory ではなく
/// CommandLine（x64: +0x70 / x86: +0x40）を使う
#[cfg(windows)]
fn pid_cmdline(pid: i32) -> Option<String> {
    use std::ffi::c_void;

    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_VM_READ: u32 = 0x0010;
    const PROCESS_BASIC_INFORMATION: u32 = 0;
    #[cfg(target_pointer_width = "64")]
    const PEB_PARAMS_OFF: usize = 0x20;
    #[cfg(target_pointer_width = "64")]
    const CMDLINE_OFF: usize = 0x70;
    #[cfg(target_pointer_width = "32")]
    const PEB_PARAMS_OFF: usize = 0x10;
    #[cfg(target_pointer_width = "32")]
    const CMDLINE_OFF: usize = 0x40;
    const MAX_CMDLINE_BYTES: usize = 32767 * 2;

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
        return None;
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
    let mut ustr = [0u8; 16];
    if !read(params + CMDLINE_OFF, &mut ustr[..ptr_size * 2]) {
        return None;
    }
    let len = u16::from_ne_bytes([ustr[0], ustr[1]]) as usize;
    if len == 0 || len % 2 != 0 || len > MAX_CMDLINE_BYTES {
        return None;
    }
    let buffer = read_ptr(params + CMDLINE_OFF + ptr_size)?;
    let mut raw = vec![0u8; len];
    if !read(buffer, &mut raw) {
        return None;
    }
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    Some(String::from_utf16_lossy(&units))
}

/// `pid_cmdline` の CommandLine オフセットを windows-sys の公開定義と同じ形の struct で
/// コンパイル時に突き合わせる（`cwd.rs` の CurrentDirectory アサートと対）。
/// Windows 向けビルドでのみ評価される
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
    struct ProcessParameters {
        reserved1: [u8; 16],
        // ConsoleHandle .. DllPath。この中に CurrentDirectory がある
        reserved2: [*mut c_void; 10],
        image_path_name: UnicodeString,
        command_line: UnicodeString,
    }

    const PTR: usize = size_of::<usize>();
    #[cfg(target_pointer_width = "64")]
    const CMDLINE: usize = 0x70;
    #[cfg(target_pointer_width = "32")]
    const CMDLINE: usize = 0x40;

    assert!(offset_of!(ProcessParameters, command_line) == CMDLINE);
    assert!(size_of::<UnicodeString>() == PTR * 2);
};

#[cfg(not(any(unix, windows)))]
fn process_table() -> Vec<ProcEntry> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_agent_binaries() {
        assert_eq!(agent_from_args(&words(&["claude"])), Some("claude"));
        assert_eq!(
            agent_from_args(&words(&["/opt/homebrew/bin/claude", "--continue"])),
            Some("claude"),
        );
        assert_eq!(agent_from_args(&words(&["codex", "resume", "--last"])), Some("codex"));
        assert_eq!(
            agent_from_args(&words(&["C:\\Users\\me\\.codex\\bin\\codex-x86_64-pc-windows-msvc.exe"])),
            Some("codex"),
        );
        assert_eq!(agent_from_args(&words(&["claude.exe"])), Some("claude"));
    }

    #[test]
    fn detects_node_wrapped_agents() {
        assert_eq!(
            agent_from_args(&words(&["node", "/Users/me/.volta/bin/claude"])),
            Some("claude"),
        );
        assert_eq!(
            agent_from_args(&words(&[
                "node",
                "--max-old-space-size=4096",
                "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            ])),
            Some("claude"),
        );
        assert_eq!(
            agent_from_args(&words(&["node", "/opt/lib/node_modules/@openai/codex/bin/codex.js"])),
            Some("codex"),
        );
    }

    #[test]
    fn ignores_lookalikes_and_arguments() {
        assert_eq!(agent_from_args(&words(&["claudette"])), None);
        assert_eq!(agent_from_args(&words(&["vim", "claude-notes.md"])), None);
        assert_eq!(agent_from_args(&words(&["/bin/zsh", "-il"])), None);
        assert_eq!(agent_from_args(&words(&["node", "/srv/claude-experiments/server.js"])), None);
        assert_eq!(agent_from_args(&[]), None);
        assert_eq!(agent_from_args(&words(&["tail", "-f", "claude.log"])), None);
    }

    #[cfg(unix)]
    #[test]
    fn parses_ps_lines() {
        let entry = parse_ps_line("  501   123 /bin/zsh -il").expect("parse");
        assert_eq!(entry.pid, 501);
        assert_eq!(entry.ppid, 123);
        assert_eq!(entry.words, words(&["/bin/zsh", "-il"]));
        assert!(parse_ps_line("").is_none());
        assert!(parse_ps_line("abc def ghi").is_none());
    }

    #[test]
    fn finds_agent_in_descendants() {
        let table = vec![
            ProcEntry { pid: 10, ppid: 1, words: words(&["/bin/zsh", "-il"]) },
            ProcEntry { pid: 20, ppid: 10, words: words(&["node", "/opt/homebrew/bin/claude"]) },
            ProcEntry { pid: 30, ppid: 20, words: words(&["/bin/sh", "-c", "ls"]) },
        ];
        assert_eq!(find_agent(&table, 10), Some("claude"));
        assert_eq!(find_agent(&table, 30), None);
        // 直接起動ペイン: root 自身がエージェント
        let direct = vec![ProcEntry { pid: 40, ppid: 1, words: words(&["claude", "--continue"]) }];
        assert_eq!(find_agent(&direct, 40), Some("claude"));
    }

    #[test]
    fn find_agent_survives_pid_cycles() {
        // pid 再利用で親子が循環しても無限ループしない
        let table = vec![
            ProcEntry { pid: 10, ppid: 20, words: words(&["/bin/zsh"]) },
            ProcEntry { pid: 20, ppid: 10, words: words(&["/bin/bash"]) },
        ];
        assert_eq!(find_agent(&table, 10), None);
    }

    #[test]
    fn splits_cmdline_with_quotes() {
        assert_eq!(
            split_cmdline(r#""C:\Program Files\nodejs\node.exe" "C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js""#),
            words(&[
                r"C:\Program Files\nodejs\node.exe",
                r"C:\Users\me\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js",
            ]),
        );
        assert_eq!(split_cmdline("codex resume --last"), words(&["codex", "resume", "--last"]));
        assert_eq!(split_cmdline(""), Vec::<String>::new());
    }

    #[test]
    fn scan_agents_resolves_own_process_tree() {
        // 自プロセス（cargo test）はエージェントではない。
        // Windows では Toolhelp32 のスナップショット経路をまるごと踏む
        let pid = std::process::id() as i32;
        let got = scan_agents(&[("p1".to_string(), pid)]);
        assert_eq!(got.get("p1"), Some(&None));
    }

    /// CreateToolhelp32Snapshot / Process32FirstW が実際にプロセス表を返しているか。
    /// 空の表でも `scan_agents` は「エージェント無し」を返してしまうので、上のテストだけでは
    /// 取得経路が壊れたことに気付けない
    #[cfg(windows)]
    #[test]
    fn windows_process_table_contains_self() {
        let table = super::process_table();
        let me = table
            .iter()
            .find(|e| e.pid == std::process::id() as i32)
            .expect("自プロセスがプロセス表に居る");
        assert!(!me.words.is_empty(), "実行ファイル名が取れている");
    }
}
