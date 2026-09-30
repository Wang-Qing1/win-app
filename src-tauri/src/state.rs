//! 应用状态：组合根真正需要共享的那点东西。
//!
//! 装法很省事、也符合语言习惯：仓储与服务都是**无状态**的
//! （零大小结构体 + 方法接收 `&Connection`），因此真正需要共享的只有
//! 「配置 + 一个数据库连接」。这样既避免了在 State 里持有一堆相互引用的
//! 对象，又保留了分层：命令层拿到连接后转发给服务层，服务层再调仓储层。
//!
//! `Mutex<Connection>` 而不是裸 `Connection`：rusqlite 的 `Connection`
//! 是 `Send` 但**不是** `Sync`（它内部的语句缓存不是线程安全的）。
//! Tauri 的 `State<T>` 要求 `T: Send + Sync`，所以必须包一层锁。
//! 于是所有数据库访问是同步、串行的 —— 同一时刻只有一个命令在用连接。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::config::AppConfig;
use crate::core::errors::{AppError, AppResult};
use crate::modules::chapters::models::RevisionBaselines;
use crate::modules::health::HealthService;

pub struct AppState {
    pub config: AppConfig,
    pub db: Mutex<Connection>,
    pub db_file: PathBuf,
    pub health: HealthService,
    /// 章节历史版本的「留版基准」（见 `chapters::service::keep_snapshot`）。
    ///
    /// 它本来在 前端是服务层的一个私有字段。Rust 侧的服务是零大小结构体
    /// （无状态才能被任意连接复用），所以这份**进程内缓存**上移到 State。
    /// 放在这里而不是某张表里，是因为它只是比较用的中间值：丢了最坏是
    /// 多留一版重复内容，不值得为它加一张表或一列。
    pub revision_baselines: Mutex<RevisionBaselines>,
}

impl AppState {
    /// 取数据库连接。锁中毒（某个命令 panic 在持锁期间）时回一条可读错误，
    /// 而不是把 `PoisonError` 直接 unwrap 成第二次 panic —— 后者会让
    /// 一次偶发崩溃变成「之后每个命令都崩」。
    pub fn connection(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| AppError::internal("数据库连接状态异常，请重启应用"))
    }

    /// 取留版基准表。中毒时的处理同上。
    pub fn revision_baselines(&self) -> AppResult<MutexGuard<'_, RevisionBaselines>> {
        self.revision_baselines
            .lock()
            .map_err(|_| AppError::internal("历史版本缓存状态异常，请重启应用"))
    }
}
