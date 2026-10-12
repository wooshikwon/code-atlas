//! 화면이 확인 결과를 파일에 남기는 통로. `probe` feature로 빌드한 앱에 `CODE_ATLAS_PROBE`(결과 파일 경로)를 줬을 때만 동작한다.
//!
//! `CODE_ATLAS_PROBE_SCRIPT`의 스크립트를 화면의 스크립트보다 먼저 실행한다. 스크립트는 `window.__probe.report(값)`으로
//! 결과를 한 줄씩 남기고 `window.__probe.done(종료 코드)`로 앱을 끝낸다. `CODE_ATLAS_PROBE_API`를 주면 화면의 `/api/` 요청을 그 주소로 보낸다.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::Mutex;
use std::{env, fs};

use tauri::{plugin, AppHandle, Builder, DragDropEvent, Manager, State, WindowEvent, Wry};

struct Out(Mutex<File>);

impl Out {
    fn write(&self, line: &str) {
        let mut file = self.0.lock().unwrap();
        let _ = writeln!(file, "{line}");
        println!("{line}");
    }
}

#[tauri::command]
fn probe_report(out: State<Out>, line: String) {
    out.write(&line);
}

#[tauri::command]
fn probe_done(app: AppHandle, code: i32) {
    app.exit(code);
}

pub fn attach(builder: Builder<Wry>) -> Builder<Wry> {
    let Ok(path) = env::var("CODE_ATLAS_PROBE") else {
        return builder;
    };
    let out = OpenOptions::new().create(true).append(true).open(&path).expect("CODE_ATLAS_PROBE의 파일을 열지 못했다");
    let api = env::var("CODE_ATLAS_PROBE_API").unwrap_or_default();
    let script = env::var("CODE_ATLAS_PROBE_SCRIPT").map(|path| fs::read_to_string(path).expect("CODE_ATLAS_PROBE_SCRIPT를 읽지 못했다")).unwrap_or_default();
    let bridge = include_str!("../probe/bridge.js").replace("__API__", &format!("{api:?}"));
    builder
        .manage(Out(Mutex::new(out)))
        .plugin(plugin::Builder::<Wry>::new("probe").js_init_script(format!("{bridge}\n{script}")).build())
        .invoke_handler(tauri::generate_handler![probe_report, probe_done])
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let paths: Vec<String> = paths.iter().map(|path| format!("{:?}", path.display().to_string())).collect();
                window.state::<Out>().write(&format!("{{\"step\":\"drop\",\"paths\":[{}]}}", paths.join(",")));
            }
        })
}
