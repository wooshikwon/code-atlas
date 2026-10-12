//! 앱 메뉴. Tauri의 기본 메뉴와 같은 항목을 macOS 한국어 표준 메뉴의 이름으로 만들고 `파일 > 폴더 열기…`를 더한다.
//! 고른 항목은 `menu` 이벤트로 화면에 알린다.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter};

const OPEN: &str = "open";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let name = &app.package_info().name;
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let separator = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                name,
                true,
                &[
                    &PredefinedMenuItem::about(app, Some(&format!("{name}에 관하여")), Some(about))?,
                    &separator()?,
                    &PredefinedMenuItem::services(app, Some("서비스"))?,
                    &separator()?,
                    &PredefinedMenuItem::hide(app, Some(&format!("{name} 가리기")))?,
                    &PredefinedMenuItem::hide_others(app, Some("기타 가리기"))?,
                    &separator()?,
                    &PredefinedMenuItem::quit(app, Some(&format!("{name} 종료")))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "파일",
                true,
                &[
                    &MenuItem::with_id(app, OPEN, "폴더 열기…", true, Some("CmdOrCtrl+O"))?,
                    &separator()?,
                    &PredefinedMenuItem::close_window(app, Some("윈도우 닫기"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "편집",
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some("실행 취소"))?,
                    &PredefinedMenuItem::redo(app, Some("실행 복귀"))?,
                    &separator()?,
                    &PredefinedMenuItem::cut(app, Some("오려두기"))?,
                    &PredefinedMenuItem::copy(app, Some("복사하기"))?,
                    &PredefinedMenuItem::paste(app, Some("붙여넣기"))?,
                    &PredefinedMenuItem::select_all(app, Some("모두 선택"))?,
                ],
            )?,
            &Submenu::with_items(app, "보기", true, &[&PredefinedMenuItem::fullscreen(app, Some("전체 화면 시작"))?])?,
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "윈도우",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, Some("최소화"))?,
                    &PredefinedMenuItem::maximize(app, Some("확대/축소"))?,
                    &separator()?,
                    &PredefinedMenuItem::close_window(app, Some("윈도우 닫기"))?,
                ],
            )?,
            &Submenu::with_id(app, HELP_SUBMENU_ID, "도움말", true)?,
        ],
    )?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| choose(app, event.id().as_ref()));
    Ok(())
}

/// 메뉴에서 고른 항목을 화면에 알린다.
pub fn choose(app: &AppHandle, id: &str) {
    if id == OPEN {
        let _ = app.emit("menu", OPEN);
    }
}
