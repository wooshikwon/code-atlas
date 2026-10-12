//! Code Atlas 앱 껍데기. 창 하나를 띄우고 `frontend/dist`의 화면을 `tauri://localhost`에서 연다.

#[cfg(feature = "probe")]
mod probe;

use tauri::Manager;

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build());
    #[cfg(feature = "probe")]
    let builder = probe::attach(builder);
    builder
        .run(tauri::generate_context!())
        .expect("Code Atlas를 띄우지 못했다");
}
