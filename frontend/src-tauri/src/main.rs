//! Atlas 앱 껍데기. 창 하나를 띄워 `frontend/dist`의 화면을 `tauri://localhost`에서 열고, 백엔드 프로세스 하나를 띄워 그 주소를
//! 화면에 알린다. macOS가 이 앱으로 열라고 넘긴 경로는 화면에 넘긴다. 레포의 판정과 도구 찾기, 분석 결과는 백엔드와 화면이 맡는다.

mod backend;
mod menu;
#[cfg(feature = "probe")]
mod probe;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, RunEvent, Url};

use backend::{Backend, STOP_TIMEOUT};

/// 이 껍데기를 빌드한 레포의 루트
const CHECKOUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

#[tauri::command]
fn backend_state(backend: tauri::State<Arc<Backend>>) -> backend::State {
    backend.state()
}

#[tauri::command(async)]
fn restart_backend(backend: tauri::State<Arc<Backend>>) {
    backend.restart();
}

/// 터미널 앱을 열어 `path`의 `claude`로 로그인하게 한다. 로그인은 브라우저 인증과 코드 붙여넣기를 거치므로 터미널이 맡는다.
#[tauri::command]
fn claude_login(path: String) -> Result<(), String> {
    let script = login_script(Path::new(&path))?;
    let file = std::env::temp_dir().join("atlas-claude-login.command");
    fs::write(&file, script)
        .and_then(|()| fs::set_permissions(&file, fs::Permissions::from_mode(0o700)))
        .map_err(|error| format!("{}: {error}", file.display()))?;
    match Command::new("/usr/bin/open").arg(&file).status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("터미널을 열지 못했다 ({status})")),
        Err(error) => Err(format!("터미널을 열지 못했다: {error}")),
    }
}

/// `claude auth login`을 실행하는 `.command` 파일의 내용. `claude`가 실행 파일이 아니면 까닭을 낸다.
/// `claude`가 든 폴더를 `PATH`의 앞에 넣어, 같은 폴더의 `node`로 도는 설치본도 터미널의 환경과 무관하게 실행된다.
fn login_script(claude: &Path) -> Result<String, String> {
    let runs = fs::metadata(claude).is_ok_and(|file| file.is_file() && file.permissions().mode() & 0o111 != 0);
    let (true, Some(dir)) = (runs && claude.is_absolute(), claude.parent()) else {
        return Err(format!("실행 파일이 아니다: {}", claude.display()));
    };
    let quoted = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"));
    Ok(format!("#!/bin/sh\nPATH={}:\"$PATH\" exec {} auth login\n", quoted(dir), quoted(claude)))
}

/// macOS가 이 앱으로 열라고 넘긴 경로. 터미널 명령 `atlas <폴더>`가 `open -a`로 넘긴다. 화면이 `take_opened`로 받아 갈 때까지 둔다.
#[derive(Default)]
struct Opened(Mutex<Vec<String>>);

#[tauri::command]
fn take_opened(opened: tauri::State<Opened>) -> Vec<String> {
    std::mem::take(&mut opened.0.lock().unwrap())
}

/// `urls` 가운데 파일 주소가 가리키는 경로
fn opened_paths(urls: &[Url]) -> Vec<String> {
    urls.iter().filter_map(|url| url.to_file_path().ok()).map(|path| path.to_string_lossy().into_owned()).collect()
}

/// 떠 있는 창을 앞으로 가져온다.
fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Opened::default())
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            let handle = app.handle().clone();
            let backend = Backend::new(
                move || backend::command(&resources, Path::new(CHECKOUT)),
                move |state| {
                    let _ = handle.emit("backend", state);
                },
            );
            app.manage(backend.clone());
            backend.start();
            menu::install(app.handle())?;
            Ok(())
        });
    #[cfg(not(feature = "probe"))]
    let builder = builder.invoke_handler(tauri::generate_handler![backend_state, restart_backend, claude_login, take_opened]);
    #[cfg(feature = "probe")]
    let builder = probe::attach(builder).invoke_handler(tauri::generate_handler![
        backend_state,
        restart_backend,
        claude_login,
        take_opened,
        probe::probe_report,
        probe::probe_done,
        probe::probe_window,
        probe::probe_close,
        probe::probe_menu
    ]);
    builder.build(tauri::generate_context!()).expect("Atlas를 띄우지 못했다").run(|app, event| match event {
        RunEvent::ExitRequested { .. } => app.state::<Arc<Backend>>().close(),
        RunEvent::Exit => app.state::<Arc<Backend>>().stop(STOP_TIMEOUT),
        RunEvent::Opened { urls } => {
            app.state::<Opened>().0.lock().unwrap().extend(opened_paths(&urls));
            show_window(app);
            let _ = app.emit("open", ());
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, mode: u32) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("atlas-login-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn login_script_runs_the_given_claude() {
        let claude = file("claude", 0o755);
        let dir = claude.parent().unwrap().display();
        assert_eq!(login_script(&claude).unwrap(), format!("#!/bin/sh\nPATH='{dir}':\"$PATH\" exec '{dir}/claude' auth login\n"));
    }

    #[test]
    fn login_script_quotes_the_path() {
        let claude = file("it's claude", 0o755);
        assert!(login_script(&claude).unwrap().ends_with("/it'\\''s claude' auth login\n"));
    }

    #[test]
    fn login_script_refuses_what_does_not_run() {
        let plain = file("notes.txt", 0o644);
        assert_eq!(login_script(&plain), Err(format!("실행 파일이 아니다: {}", plain.display())));
        assert!(login_script(plain.parent().unwrap()).is_err(), "폴더");
        assert!(login_script(Path::new("/nonexistent/claude")).is_err(), "없는 파일");
        assert!(login_script(Path::new("claude")).is_err(), "상대 경로");
    }

    #[test]
    fn opened_paths_keeps_only_file_urls() {
        let urls = ["file:///Users/me/my%20repo/", "https://example.com/repo", "file:///tmp/notes.txt"].map(|url| Url::parse(url).unwrap());
        assert_eq!(opened_paths(&urls), ["/Users/me/my repo/", "/tmp/notes.txt"]);
    }
}
