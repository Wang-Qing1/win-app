//! winbook 后端装配（Tauri 2）。
//!
//! 对应 TS 侧 `src/main/index.ts` 的启动编排，次序刻意保持一致：
//!   配置与日志 → GPU 开关 → 打开数据库 → 跑迁移 → 注册命令 → 建窗口。
//!
//! 次序是有原因的：
//!   1. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 必须在 WebView 创建**之前**
//!      进环境变量，而配置窗口是在 setup 之后才建的，所以 setup 是最后时机；
//!   2. 配置非法时可以立刻弹窗退出，不用白等一次窗口创建。

mod config;
mod core;
mod db;
mod modules;
mod state;

use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;

pub use state::AppState;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            modules::health::commands::health_ping,
            modules::health::commands::health_ready,
            modules::books::commands::books_list,
            modules::books::commands::books_get,
            modules::books::commands::books_create,
            modules::books::commands::books_update,
            modules::books::commands::books_remove,
            modules::books::commands::books_stats,
            modules::volumes::commands::volumes_list,
            modules::volumes::commands::volumes_create,
            modules::volumes::commands::volumes_update,
            modules::volumes::commands::volumes_remove,
            modules::volumes::commands::volumes_reorder,
            modules::chapters::commands::chapters_list,
            modules::chapters::commands::chapters_get,
            modules::chapters::commands::chapters_create,
            modules::chapters::commands::chapters_update,
            modules::chapters::commands::chapters_save_content,
            modules::chapters::commands::chapters_remove,
            modules::chapters::commands::chapters_reorder,
            modules::chapters::commands::chapters_move,
            modules::chapters::commands::chapters_list_revisions,
            modules::chapters::commands::chapters_get_revision,
            modules::chapters::commands::chapters_restore_revision,
            modules::outline::commands::outline_tree,
            modules::outline::commands::outline_create,
            modules::outline::commands::outline_update,
            modules::outline::commands::outline_remove,
            modules::outline::commands::outline_move,
            modules::outline::commands::outline_attach_chapter,
            modules::outline::commands::outline_materialize,
            modules::cards::commands::cards_list,
            modules::cards::commands::cards_create,
            modules::cards::commands::cards_update,
            modules::cards::commands::cards_remove,
            modules::cards::commands::cards_duplicate,
            modules::cards::commands::cards_set_timeline_order,
            modules::card_links::commands::cards_list_links,
            modules::card_links::commands::cards_list_by_chapter,
            modules::card_links::commands::cards_link_chapter,
            modules::card_links::commands::cards_unlink_chapter,
            modules::card_links::commands::cards_list_node_links,
            modules::card_links::commands::cards_list_by_node,
            modules::card_links::commands::cards_link_node,
            modules::card_links::commands::cards_unlink_node,
            modules::card_links::commands::cards_list_relations,
            modules::card_links::commands::cards_list_book_relations,
            modules::card_links::commands::cards_relate,
            modules::card_links::commands::cards_unrelate,
            modules::trash::commands::trash_list,
            modules::trash::commands::trash_restore,
            modules::trash::commands::trash_purge,
            modules::trash::commands::trash_empty,
            modules::search::commands::search_query,
            modules::sessions::commands::sessions_finish,
            modules::sessions::commands::sessions_list,
            modules::stats::commands::stats_overview,
            modules::stats::commands::stats_trend,
            modules::stats::commands::stats_books,
            modules::stats::commands::stats_heatmap,
            modules::exporter::commands::exporter_chapter,
            modules::exporter::commands::exporter_book,
            modules::exporter::commands::exporter_volume,
            modules::backup::commands::backup_database,
        ])
        .setup(|app| {
            bootstrap(app);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("winbook 启动失败：无法构建应用实例");

    app.run(|app_handle, event| {
        // 优雅停机：先做 WAL 检查点把日志并回主库，再把日志刷盘。
        // 少了这一步，退出后目录里会留下可能压着最后一次自动保存的 -wal 文件。
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Ok(conn) = state.db.lock() {
                    db::close(&conn);
                }
            }
            core::logger::flush();
        }
    });
}

fn bootstrap(app: &mut tauri::App) {
    let config = match config::load_config() {
        Ok(config) => config,
        Err(error) => {
            fail_fast(app.handle(), &error.to_string());
            return;
        }
    };

    core::logger::init(
        config.log_level,
        &config.log_dir,
        config.log_max_bytes,
        true,
    );

    core::logger::info(
        "winbook 正在启动",
        core::logger::fields(vec![
            ("version", serde_json::json!(env!("CARGO_PKG_VERSION"))),
            ("env", serde_json::json!(config.env)),
            ("shell", serde_json::json!("tauri")),
            ("tauriVersion", serde_json::json!(tauri::VERSION)),
            ("webviewVersion", serde_json::json!(health_webview_probe())),
        ]),
    );

    // 无显卡环境下 Chromium 内核的 GPU 进程会反复崩溃并带走整个应用
    // （Electron 版日志里表现为 "GPU process isn't usable. Goodbye."，退出码 3）。
    // WebView2 是同一个内核，所以同样需要关掉 GPU 路径 —— 只是开关的传法不同：
    // Tauri 没有 app.disableHardwareAcceleration() 这种 API，改由 WebView2 自己
    // 读环境变量。必须在 WebView 创建之前设置，否则不生效。
    if config.disable_gpu {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-gpu --disable-gpu-compositing --disable-software-rasterizer",
        );
        core::logger::warn(
            "已关闭硬件加速，改用软件渲染",
            core::logger::fields(vec![("reason", serde_json::json!("WINBOOK_DISABLE_GPU=true"))]),
        );
    }

    let mut conn = match db::open(&config) {
        Ok(conn) => conn,
        Err(error) => {
            fail_fast(
                app.handle(),
                &format!("应用初始化失败，无法启动。\n\n{}", error.message),
            );
            return;
        }
    };

    let outcome = match db::migrator::run_migrations(&mut conn) {
        Ok(outcome) => outcome,
        Err(error) => {
            fail_fast(
                app.handle(),
                &format!("应用初始化失败，无法启动。\n\n{}", error.message),
            );
            return;
        }
    };

    let db_file = db::database_file(&config);
    let health = modules::health::HealthService::new(config.clone(), db_file.clone());

    app.manage(AppState {
        config: config.clone(),
        db: std::sync::Mutex::new(conn),
        db_file,
        health,
        revision_baselines: std::sync::Mutex::new(Default::default()),
    });

    core::logger::info(
        "winbook 已就绪",
        core::logger::fields(vec![
            ("userDataDir", serde_json::json!(config.user_data_dir.display().to_string())),
            ("database", serde_json::json!(config.db_file_name)),
            ("appliedMigrations", serde_json::json!(outcome.applied)),
            ("schemaVersion", serde_json::json!(outcome.current)),
        ]),
    );

    if config.open_dev_tools {
        open_devtools(app);
    }
}

/// 打开开发者工具。
///
/// **这个函数的 cfg 条件必须和 tauri 自己的逐字一致**：`WebviewWindow::open_devtools`
/// 在 tauri 里的定义是
/// `#[cfg(any(debug_assertions, feature = "devtools"))]`
/// —— 也就是说 **release 构建默认根本没有这个方法**。
///
/// 踩过的坑：`cargo check` 跑的是 debug profile（`debug_assertions` 开着），
/// 所以这里不门控的话**编译检查永远发现不了**，只有 `tauri build` 才会炸：
///
/// ```text
/// error[E0599]: no method named `open_devtools` found for struct
///               `tauri::WebviewWindow<R>` in the current scope
/// ```
///
/// 纪律：**改完 Rust 代码至少要跑一次 `cargo check --release`**，
/// 否则「全绿」只是 debug 的全绿，release 编不编得过完全没被验证。
#[cfg(any(debug_assertions, feature = "devtools"))]
fn open_devtools(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
}

/// release 且未启用 `devtools` 特性时的替身：记一条日志，而不是静默忽略。
///
/// 静默会让「我明明设了 `WINBOOK_DEVTOOLS=true` 却没反应」变成查不出来的问题。
#[cfg(not(any(debug_assertions, feature = "devtools")))]
fn open_devtools(_app: &tauri::App) {
    core::logger::warn(
        "配置要求打开开发者工具，但当前构建不含 devtools 支持，已忽略",
        core::logger::fields(vec![(
            "hint",
            serde_json::json!(
                "release 版若要保留该能力，需给 Cargo.toml 的 tauri 启用 devtools feature"
            ),
        )]),
    );
}

/// 启动阶段致命错误：弹一个原生对话框讲清楚原因再退出。
///
/// 与 Electron 版的 `dialog.showErrorBox` 对齐。这里刻意**不用** `logger`
/// ——此刻日志可能还没初始化（配置非法时甚至连日志目录都不知道在哪），
/// 而「弹窗没出来、控制台也没有」是最难排查的一种启动失败。
///
/// 用非阻塞的 `show` 而不是 `blocking_show`：后者在**没有可见窗口**的场合
/// （冒烟自检、CI、远程会话）会一直等用户点确定，表现为进程静默挂死 ——
/// 比「弹窗没看清」难查得多。代价是需要给对话框留一点显示时间再退出。
fn fail_fast(app: &tauri::AppHandle, detail: &str) {
    eprintln!("[winbook] {detail}");
    app.dialog()
        .message(detail)
        .title("winbook 启动失败")
        .show(|_| {});
    std::thread::sleep(std::time::Duration::from_millis(600));
    std::process::exit(1);
}

/// 日志里那条 webview 版本探测复用健康检查的实现，避免两处各写一遍。
fn health_webview_probe() -> String {
    // 直接读注册表会引入一次进程创建；启动日志里这条只是备忘，
    // 取不到就写 unknown，真正的版本号由 health.ping 按需提供。
    std::env::var("WEBVIEW2_VERSION").unwrap_or_else(|_| "unknown".into())
}
