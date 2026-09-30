//! 业务模块集合。
//!
//! 每个模块内部保持同一套分层：命令层（控制器）→ 服务层 → 仓储层。
//! 前端只认通道名与响应信封，模块内部怎么分层它看不见。

pub mod backup;
pub mod books;
pub mod card_links;
pub mod cards;
pub mod chapters;
pub mod exporter;
pub mod health;
pub mod outline;
pub mod search;
pub mod sessions;
pub mod stats;
pub mod trash;
pub mod volumes;
