//! 业务模块集合。
//!
//! 每个模块内部保持与 TS 侧一致的分层：命令层（控制器）→ 服务层 → 仓储层。
//! 渲染层不会感知这次换壳 —— 它看到的仍是同一组通道名与同一个响应信封。

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
