//! 앱 메뉴. Tauri의 기본 메뉴에 `파일 > 폴더 열기…`를 더하고, 고른 항목을 `menu` 이벤트로 화면에 알린다.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter};

const OPEN: &str = "open";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    for item in menu.items()? {
        if let Some(file) = item.as_submenu().filter(|submenu| submenu.text().is_ok_and(|text| text == "File")) {
            file.set_text("파일")?;
            let open = MenuItem::with_id(app, OPEN, "폴더 열기…", true, Some("CmdOrCtrl+O"))?;
            file.prepend_items(&[&open, &PredefinedMenuItem::separator(app)?])?;
        }
    }
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
