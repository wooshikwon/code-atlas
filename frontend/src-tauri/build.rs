use tauri_build::{AppManifest, Attributes};

/// 화면이 부르는 명령. capability가 이름으로 허락한 것만 불린다.
const COMMANDS: &[&str] = &["backend_state", "restart_backend", "claude_login", "take_opened"];
const PROBE_COMMANDS: &[&str] =
    &["backend_state", "restart_backend", "claude_login", "take_opened", "probe_report", "probe_done", "probe_window", "probe_close", "probe_menu"];

fn main() {
    let commands = if std::env::var_os("CARGO_FEATURE_PROBE").is_some() { PROBE_COMMANDS } else { COMMANDS };
    tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(commands))).expect("앱 껍데기의 빌드 설정을 읽지 못했다");
}
