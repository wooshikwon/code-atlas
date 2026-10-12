//! 화면이 확인 결과를 파일에 남기는 통로. `probe` feature로 빌드한 앱에 `CODE_ATLAS_PROBE`(결과 파일 경로)를 줬을 때만 동작한다.
//!
//! `CODE_ATLAS_PROBE_SCRIPT`의 스크립트를 화면의 스크립트보다 먼저 실행한다. 스크립트는 `window.__probe.report(값)`으로
//! 결과를 한 줄씩 남기고 `window.__probe.done(종료 코드)`로 앱을 끝낸다. 사람 손이 필요한 조작(창 옮기기, 창 닫기, 메뉴 고르기)을
//! 대신하는 명령도 여기에 있다.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::Mutex;
use std::{env, fs};

use tauri::{plugin, AppHandle, Builder, DragDropEvent, LogicalPosition, LogicalSize, Manager, State, WebviewWindow, WindowEvent, Wry};

pub struct Out(Mutex<File>);

impl Out {
    fn write(&self, line: &str) {
        let mut file = self.0.lock().unwrap();
        let _ = writeln!(file, "{line}");
        println!("{line}");
    }
}

#[tauri::command]
pub fn probe_report(out: State<Out>, line: String) {
    out.write(&line);
}

#[tauri::command]
pub fn probe_done(app: AppHandle, code: i32) {
    app.exit(code);
}

/// `rect`(왼쪽, 위, 폭, 높이)를 주면 창을 그 사각형으로 옮기고, 창의 지금 사각형을 돌려준다.
#[tauri::command]
pub fn probe_window(window: WebviewWindow, rect: Option<[f64; 4]>) -> Result<[f64; 4], String> {
    let failed = |error: tauri::Error| error.to_string();
    if let Some([x, y, width, height]) = rect {
        window.set_position(LogicalPosition::new(x, y)).map_err(failed)?;
        window.set_size(LogicalSize::new(width, height)).map_err(failed)?;
    }
    let scale = window.scale_factor().map_err(failed)?;
    let position = window.outer_position().map_err(failed)?.to_logical::<f64>(scale);
    let size = window.inner_size().map_err(failed)?.to_logical::<f64>(scale);
    Ok([position.x, position.y, size.width, size.height])
}

/// 창의 닫기 버튼을 누른 것처럼 창을 닫는다.
#[tauri::command]
pub fn probe_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

/// 앱 메뉴에서 `id` 항목을 고른 것처럼 알린다.
#[tauri::command]
pub fn probe_menu(app: AppHandle, id: String) {
    crate::menu::choose(&app, &id);
}

pub fn attach(builder: Builder<Wry>) -> Builder<Wry> {
    let Ok(path) = env::var("CODE_ATLAS_PROBE") else {
        return builder;
    };
    let out = OpenOptions::new().create(true).append(true).open(&path).expect("CODE_ATLAS_PROBE의 파일을 열지 못했다");
    let script = env::var("CODE_ATLAS_PROBE_SCRIPT").map(|path| fs::read_to_string(path).expect("CODE_ATLAS_PROBE_SCRIPT를 읽지 못했다")).unwrap_or_default();
    let bridge = include_str!("../probe/bridge.js");
    builder
        .manage(Out(Mutex::new(out)))
        .plugin(
            plugin::Builder::<Wry>::new("probe")
                .js_init_script(format!("{bridge}\n{script}"))
                .setup(|app, _api| Ok(app.add_capability(include_str!("../probe/capability.json"))?))
                .build(),
        )
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let paths: Vec<String> = paths.iter().map(|path| format!("{:?}", path.display().to_string())).collect();
                window.state::<Out>().write(&format!("{{\"step\":\"drop\",\"paths\":[{}]}}", paths.join(",")));
            }
        })
}
