//! OS（Finder / Explorer）からのファイルドロップをペインへのパス入力にする。
//!
//! tauri.conf.json は `dragDropEnabled: false` のまま。true にすると tauri-runtime-wry の
//! ハンドラが**全ての**ドラッグに true を返し、wry が WebView 本来の処理（super）を呼ばなく
//! なるため、サイドバー・グループ・定型文・エクスプローラーの HTML5 DnD が macOS / Windows
//! ともに死ぬ。一方 false のままだと WebView の HTML5 `drop` は File オブジェクトしか渡さず
//! パスは取れない（WebKit / Chromium のセキュリティ仕様）。
//!
//! そこで WebView 自身のネイティブな drop 受け口を差し替え、**ファイルパスを持つドラッグ
//! だけ**を横取りしてフロントへ `filedrop:drag` / `filedrop:drop` を送る。それ以外のドラッグ
//! （アプリ内の HTML5 DnD、テキスト選択のドラッグ）は元の実装へそのまま流す。
//!
//! - macOS: wry の `WryWebView`（WKWebView のサブクラス）は `NSDraggingDestination` の 4 メソッド
//!   を実装し、ハンドラ無しのときは常に super へ流している。そのクラスの 4 メソッドの実装を
//!   `class_replaceMethod` で置き換える（クラス自体は差し替えない。差し替えると macOS 26 の
//!   AppKit が起動時に assert で落ちる）。
//! - Windows: 同じプロセス・UI スレッドの子 HWND が持つ IDropTarget だけを差し替える。
//!   CF_HDROP を持たないドラッグは元の IDropTarget へ委譲する。WebView2 の別プロセスが
//!   所有する HWND の COM ポインターは、このプロセスでは参照できないため触らない。
//! - Linux: 何もしない（フロントの window `dragover`/`drop` の preventDefault だけが効く）。
//!
//! 座標は WebView 左上原点の CSS px（macOS の pt = CSS px。Windows は DPI で割る）。
//! フロントはこの座標で `document.elementFromPoint` してペインを決める。

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const EVENT_DRAG: &str = "filedrop:drag";
pub(crate) const EVENT_DROP: &str = "filedrop:drop";

#[derive(Clone, Serialize)]
struct DragPayload {
    /// "enter" | "over" | "leave"
    kind: &'static str,
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize)]
struct DropPayload {
    paths: Vec<String>,
    x: f64,
    y: f64,
}

/// ネイティブのコールバックには自前の状態を持たせられない（macOS のサブクラスは ivar を
/// 足せず、Windows も COM オブジェクトの生成時にしか渡せない）ので、emit 先は static に置く。
static APP: OnceLock<AppHandle> = OnceLock::new();

fn emit_drag(kind: &'static str, x: f64, y: f64) {
    if let Some(app) = APP.get() {
        let _ = app.emit(EVENT_DRAG, DragPayload { kind, x, y });
    }
}

fn emit_drop(paths: Vec<PathBuf>, x: f64, y: f64) {
    if paths.is_empty() {
        return;
    }
    if let Some(app) = APP.get() {
        let paths = paths
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let _ = app.emit(EVENT_DROP, DropPayload { paths, x, y });
    }
}

/// main ウィンドウの WebView にフックを取り付ける。冪等なので `setup` と
/// ページ読み込み完了の両方から呼んでよい（Windows は子 HWND が遅れて作られることがある）。
pub(crate) fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    #[cfg(any(target_os = "macos", windows))]
    if let Err(e) = win.with_webview(|pw| unsafe { platform::hook(pw) }) {
        eprintln!("file drop hook failed: {e}");
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = win;
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{CStr, CString};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, ProtocolObject, Sel};
    use objc2::{ffi, msg_send, sel};
    use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSView};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSString};

    /// 差し替えたクラスの親（= WKWebView）。ファイル以外のドラッグはここへ素通しする。
    /// 呼び出し時に `this.class()` から辿らないのは、後から KVO のサブクラスが被さると
    /// 親が自分自身（差し替え済みメソッド）になり無限再帰するため。
    static SUPER: OnceLock<&'static AnyClass> = OnceLock::new();
    /// 進行中のドラッグがファイルを含むか。updated / exited / perform をどちらへ流すかの判定。
    static FILE_DRAG: AtomicBool = AtomicBool::new(false);

    /// `with_webview` はメインスレッドで呼ばれる（AppKit の要件を満たす）。
    ///
    /// `object_setClass` で動的サブクラスに差し替える方式は、macOS 26 の AppKit が
    /// `safeAreaRect` の内部プロパティ機構（NSDP）でクラス固有の IMP を引けず assert で
    /// 落ちる。クラスはそのままに、wry の WryWebView クラスのメソッド実装だけを
    /// `class_replaceMethod` で置き換える。
    pub(super) unsafe fn hook(pw: tauri::webview::PlatformWebview) {
        let ptr = pw.inner() as *const AnyObject;
        if ptr.is_null() || SUPER.get().is_some() {
            return; // 未生成 or 差し替え済み（ページ再読み込み後の再呼び出し）
        }
        // KVO が isa を被せていたらその下（wry の実クラス）を対象にする
        let mut cls = (*ptr).class();
        while cls.name().to_bytes().starts_with(b"NSKVONotifying_") {
            let Some(next) = cls.superclass() else { return };
            cls = next;
        }
        let Some(superclass) = cls.superclass() else {
            return;
        };
        let _ = SUPER.set(superclass);

        type Entered = unsafe extern "C-unwind" fn(
            &AnyObject,
            Sel,
            &ProtocolObject<dyn NSDraggingInfo>,
        ) -> NSDragOperation;
        type Perform = unsafe extern "C-unwind" fn(
            &AnyObject,
            Sel,
            &ProtocolObject<dyn NSDraggingInfo>,
        ) -> Bool;
        type Exited =
            unsafe extern "C-unwind" fn(&AnyObject, Sel, &ProtocolObject<dyn NSDraggingInfo>);

        replace(
            cls,
            sel!(draggingEntered:),
            std::mem::transmute::<Entered, Imp>(dragging_entered),
            NSDragOperation::ENCODING,
        );
        replace(
            cls,
            sel!(draggingUpdated:),
            std::mem::transmute::<Entered, Imp>(dragging_updated),
            NSDragOperation::ENCODING,
        );
        replace(
            cls,
            sel!(performDragOperation:),
            std::mem::transmute::<Perform, Imp>(perform_drag_operation),
            Bool::ENCODING,
        );
        replace(
            cls,
            sel!(draggingExited:),
            std::mem::transmute::<Exited, Imp>(dragging_exited),
            Encoding::Void,
        );
    }

    /// `- (ret)sel:(id)info` の実装を置き換える（無ければ追加）。
    unsafe fn replace(cls: &AnyClass, sel: Sel, imp: Imp, ret: Encoding) {
        let types = CString::new(format!(
            "{ret}{}{}{}",
            Encoding::Object,
            Encoding::Sel,
            Encoding::Object
        ))
        .expect("encoding has no NUL");
        let cls = cls as *const AnyClass as *mut AnyClass;
        let _ = ffi::class_replaceMethod(cls, sel, imp, types.as_ptr());
    }

    fn superclass() -> &'static AnyClass {
        SUPER
            .get()
            .expect("hook installed before any drag callback")
    }

    /// wry の `collect_paths` と同じ。NSFilenamesPboardType が無ければ空。
    #[allow(deprecated)]
    unsafe fn collect_paths(info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
        let pb = info.draggingPasteboard();
        let types = NSArray::arrayWithObject(objc2_app_kit::NSFilenamesPboardType);
        let mut out = Vec::new();
        if pb.availableTypeFromArray(&types).is_none() {
            return out;
        }
        let Some(list) = pb.propertyListForType(objc2_app_kit::NSFilenamesPboardType) else {
            return out;
        };
        let Ok(arr) = list.downcast::<NSArray>() else {
            return out;
        };
        for item in arr {
            if let Ok(s) = item.downcast::<NSString>() {
                let s = CStr::from_ptr(s.UTF8String())
                    .to_string_lossy()
                    .into_owned();
                out.push(PathBuf::from(s));
            }
        }
        out
    }

    /// 左上原点の pt（= CSS px）。AppKit は左下原点なので frame の高さで反転する（wry と同じ）。
    unsafe fn position(this: &AnyObject, info: &ProtocolObject<dyn NSDraggingInfo>) -> (f64, f64) {
        let dl: NSPoint = info.draggingLocation();
        let view: &NSView = &*(this as *const AnyObject).cast::<NSView>();
        let frame: NSRect = view.frame();
        (dl.x, frame.size.height - dl.y)
    }

    unsafe extern "C-unwind" fn dragging_entered(
        this: &AnyObject,
        _cmd: Sel,
        info: &ProtocolObject<dyn NSDraggingInfo>,
    ) -> NSDragOperation {
        let paths = collect_paths(info);
        if paths.is_empty() {
            FILE_DRAG.store(false, Ordering::Relaxed);
            return msg_send![super(this, superclass()), draggingEntered: info];
        }
        FILE_DRAG.store(true, Ordering::Relaxed);
        let (x, y) = position(this, info);
        super::emit_drag("enter", x, y);
        NSDragOperation::Copy
    }

    unsafe extern "C-unwind" fn dragging_updated(
        this: &AnyObject,
        _cmd: Sel,
        info: &ProtocolObject<dyn NSDraggingInfo>,
    ) -> NSDragOperation {
        if !FILE_DRAG.load(Ordering::Relaxed) {
            return msg_send![super(this, superclass()), draggingUpdated: info];
        }
        let (x, y) = position(this, info);
        super::emit_drag("over", x, y);
        NSDragOperation::Copy
    }

    unsafe extern "C-unwind" fn perform_drag_operation(
        this: &AnyObject,
        _cmd: Sel,
        info: &ProtocolObject<dyn NSDraggingInfo>,
    ) -> Bool {
        if !FILE_DRAG.swap(false, Ordering::Relaxed) {
            return msg_send![super(this, superclass()), performDragOperation: info];
        }
        let (x, y) = position(this, info);
        super::emit_drop(collect_paths(info), x, y);
        Bool::YES
    }

    unsafe extern "C-unwind" fn dragging_exited(
        this: &AnyObject,
        _cmd: Sel,
        info: &ProtocolObject<dyn NSDraggingInfo>,
    ) {
        if !FILE_DRAG.swap(false, Ordering::Relaxed) {
            let _: () = msg_send![super(this, superclass()), draggingExited: info];
            return;
        }
        super::emit_drag("leave", 0.0, 0.0);
    }
}

#[cfg(windows)]
mod platform {
    use std::cell::Cell;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use windows::core::{implement, w, Interface, BOOL};
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
    use windows::Win32::System::Ole::{
        IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, CF_HDROP, DROPEFFECT,
        DROPEFFECT_COPY, DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Shell::{DragFinish, DragQueryFileW, HDROP};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetPropW, GetWindowThreadProcessId,
    };

    /// 差し替え済みの HWND。ページ再読み込み等で再度呼ばれても二重に差し替えない。
    static HOOKED: Mutex<Vec<isize>> = Mutex::new(Vec::new());

    pub(super) unsafe fn hook(pw: tauri::webview::PlatformWebview) {
        let controller = pw.controller();
        let mut parent = HWND::default();
        if controller.ParentWindow(&mut parent).is_err() {
            return;
        }
        // wry と同じく子孫 HWND を全部見る（WebView2 は Chromium 側の子ウィンドウに登録する）
        unsafe extern "system" fn each(hwnd: HWND, _l: LPARAM) -> BOOL {
            inject(hwnd);
            BOOL(1)
        }
        let _ = EnumChildWindows(Some(parent), Some(each), LPARAM(0));
    }

    /// OLE's window property is a raw, apartment-local COM pointer. WebView2's
    /// descendant HWNDs can belong to its separate browser process; dereferencing
    /// that process's property in IUnknown::AddRef crashes before the UI loads.
    /// Leave windows outside this UI thread's process/apartment to WebView2.
    unsafe fn inject(hwnd: HWND) {
        let mut owner_process = 0;
        let owner_thread = GetWindowThreadProcessId(hwnd, Some(&mut owner_process));
        if owner_process != std::process::id() || owner_thread != GetCurrentThreadId() {
            return;
        }
        let key = hwnd.0 as isize;
        {
            let hooked = HOOKED.lock().unwrap_or_else(|e| e.into_inner());
            if hooked.contains(&key) {
                return;
            }
        }
        let prop = GetPropW(hwnd, w!("OleDropTargetInterface"));
        if prop.is_invalid() {
            return;
        }
        let Some(inner) = IDropTarget::from_raw_borrowed(&prop.0) else {
            return;
        };
        let inner = inner.clone(); // AddRef: RevokeDragDrop の Release 後も生かす
        if RevokeDragDrop(hwnd).is_err() {
            return;
        }
        let ours: IDropTarget = ForwardingDropTarget {
            hwnd,
            inner,
            files: Cell::new(false),
            effect: Cell::new(DROPEFFECT_NONE),
        }
        .into();
        if RegisterDragDrop(hwnd, &ours).is_ok() {
            HOOKED.lock().unwrap_or_else(|e| e.into_inner()).push(key);
            std::mem::forget(ours); // OLE が参照を持つ。ウィンドウと同寿命
        }
    }

    #[implement(IDropTarget)]
    struct ForwardingDropTarget {
        hwnd: HWND,
        /// WebView2 本来の drop 先。ファイル以外のドラッグ（HTML5 DnD）はここへ委譲する
        inner: IDropTarget,
        /// 進行中のドラッグが CF_HDROP を含むか
        files: Cell<bool>,
        effect: Cell<DROPEFFECT>,
    }

    impl ForwardingDropTarget {
        /// スクリーン座標 → クライアント座標 → CSS px
        fn client_css(&self, pt: &POINTL) -> (f64, f64) {
            let mut p = POINT { x: pt.x, y: pt.y };
            let _ = unsafe { ScreenToClient(self.hwnd, &mut p) };
            let dpi = unsafe { GetDpiForWindow(self.hwnd) };
            let scale = if dpi > 0 { dpi as f64 / 96.0 } else { 1.0 };
            (p.x as f64 / scale, p.y as f64 / scale)
        }

        /// wry の `iterate_filenames` と同じ。CF_HDROP を持たなければ None。
        unsafe fn read_paths(data: &IDataObject) -> Option<(HDROP, Vec<PathBuf>)> {
            let fmt = FORMATETC {
                cfFormat: CF_HDROP.0,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            let medium = data.GetData(&fmt).ok()?;
            let hdrop = HDROP(medium.u.hGlobal.0 as _);
            let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
            let mut paths = Vec::with_capacity(count as usize);
            for i in 0..count {
                let len = DragQueryFileW(hdrop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(hdrop, i, Some(&mut buf));
                paths.push(PathBuf::from(OsString::from_wide(&buf[..len])));
            }
            Some((hdrop, paths))
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for ForwardingDropTarget_Impl {
        fn DragEnter(
            &self,
            data: windows_core::Ref<'_, IDataObject>,
            keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows_core::Result<()> {
            let files = data
                .as_ref()
                .and_then(|d| unsafe { ForwardingDropTarget::read_paths(d) })
                .map_or(false, |(hdrop, paths)| {
                    unsafe { DragFinish(hdrop) }; // GetData の複製を解放（Drop 時に改めて読む）
                    !paths.is_empty()
                });
            self.files.set(files);
            if !files {
                return unsafe { self.inner.DragEnter(data.as_ref(), keys, *pt, effect) };
            }
            let (x, y) = self.client_css(pt);
            super::emit_drag("enter", x, y);
            unsafe { *effect = DROPEFFECT_COPY };
            self.effect.set(DROPEFFECT_COPY);
            Ok(())
        }

        fn DragOver(
            &self,
            keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows_core::Result<()> {
            if !self.files.get() {
                return unsafe { self.inner.DragOver(keys, *pt, effect) };
            }
            let (x, y) = self.client_css(pt);
            super::emit_drag("over", x, y);
            unsafe { *effect = self.effect.get() };
            Ok(())
        }

        fn DragLeave(&self) -> windows_core::Result<()> {
            if !self.files.replace(false) {
                return unsafe { self.inner.DragLeave() };
            }
            super::emit_drag("leave", 0.0, 0.0);
            Ok(())
        }

        fn Drop(
            &self,
            data: windows_core::Ref<'_, IDataObject>,
            keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows_core::Result<()> {
            if !self.files.replace(false) {
                return unsafe { self.inner.Drop(data.as_ref(), keys, *pt, effect) };
            }
            let read = data
                .as_ref()
                .and_then(|d| unsafe { ForwardingDropTarget::read_paths(d) });
            let (x, y) = self.client_css(pt);
            if let Some((hdrop, paths)) = read {
                super::emit_drop(paths, x, y);
                unsafe { DragFinish(hdrop) };
            }
            unsafe { *effect = DROPEFFECT_COPY };
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::env::HideConsole;
        use std::io::{BufRead, BufReader, Read, Write};
        use std::process::{Child, Command, Stdio};
        use std::sync::mpsc;
        use std::time::Duration;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, SetPropW, WINDOW_EX_STYLE, WS_POPUP,
        };

        fn foreign_drop_window() -> HWND {
            unsafe {
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!("PATerminal drop test"),
                    WS_POPUP,
                    0,
                    0,
                    1,
                    1,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap();
                // A non-null property from another process/apartment must never
                // be dereferenced, regardless of its value in our address space.
                SetPropW(
                    hwnd,
                    w!("OleDropTargetInterface"),
                    Some(HANDLE(1usize as _)),
                )
                .unwrap();
                hwnd
            }
        }

        struct Helper(Child);

        impl Drop for Helper {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        #[test]
        #[ignore = "subprocess fixture for ignores_foreign_process_drop_target"]
        fn foreign_window_helper() {
            let hwnd = foreign_drop_window();
            println!("DROP_TEST_HWND={}", hwnd.0 as usize);
            std::io::stdout().flush().unwrap();
            let _ = std::io::stdin().read(&mut [0]);
            unsafe { DestroyWindow(hwnd).unwrap() };
        }

        #[test]
        fn ignores_foreign_process_drop_target() {
            let mut helper = Helper(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--ignored",
                        "--exact",
                        "system::drop::platform::tests::foreign_window_helper",
                        "--nocapture",
                    ])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .hide_console()
                    .spawn()
                    .unwrap(),
            );
            let stdout = helper.0.stdout.take().unwrap();
            let (send, receive) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(raw) = line.strip_prefix("DROP_TEST_HWND=") {
                        let _ = send.send(raw.parse::<usize>().unwrap());
                        break;
                    }
                }
            });
            let hwnd = HWND(receive.recv_timeout(Duration::from_secs(10)).unwrap() as _);
            unsafe {
                assert!(!GetPropW(hwnd, w!("OleDropTargetInterface")).is_invalid());
                inject(hwnd);
                // The browser's original drop target must remain untouched.
                assert_eq!(GetPropW(hwnd, w!("OleDropTargetInterface")).0 as usize, 1);
            }
        }

        #[test]
        fn ignores_other_thread_drop_target() {
            let (send, receive) = mpsc::channel();
            let (finish, finished) = mpsc::channel();
            let thread = std::thread::spawn(move || {
                let hwnd = foreign_drop_window();
                send.send(hwnd.0 as usize).unwrap();
                let _ = finished.recv_timeout(Duration::from_secs(10));
                unsafe { DestroyWindow(hwnd).unwrap() };
            });
            let hwnd = HWND(receive.recv_timeout(Duration::from_secs(10)).unwrap() as _);
            unsafe { inject(hwnd) };
            finish.send(()).unwrap();
            thread.join().unwrap();
        }
    }
}
