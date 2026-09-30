//! 命令入参的解析与校验（对应 TS 侧 zod schema 在命令边界的作用）。
//!
//! **为什么命令不直接收强类型参数**：Tauri 在反序列化失败时会 reject 整次
//! 调用，渲染层拿到的是「与主进程通信失败」—— 而 TS 版在同一种情况下回的是
//! `VALIDATION_ERROR` 信封，前端据此把错误落到具体输入框。语义必须一致，
//! 所以命令统一收 `Option<serde_json::Value>`，在这里解析，
//! 把「结构不合法」也变成一封正常的失败信封。
//!
//! ## 为什么不是「一个字段一个 Result」
//!
//! TS 侧的 zod 会**一次性收齐所有字段的问题**，回一个 issues 数组；
//! 渲染层的 `ApiError.fieldErrors()` 再把它铺到表单的每个输入框下方。
//! 如果这里遇到第一个错就返回，用户每改一个字段就要再点一次保存 ——
//! 所以 `Validator` 是「边验证边记账」的写法，最后 `finish()` 一次性回。
//!
//! 失败信封的形状也逐字对齐：`message` 是**通用文案**
//! `提交的数据未通过校验，请检查后重试`，真正的字段级文案在 `issues` 里。
//! 这一点很容易写错 —— 把具体文案塞进 `message` 会让表单上方的红色提示条
//! 显示「书名不能为空」，而输入框下方空空如也。

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::core::errors::{AppError, AppResult};
use crate::core::response::FieldIssue;

/// zod 校验失败时对用户说的话（逐字沿用，前端已有基于它的提示逻辑）
pub const VALIDATION_MESSAGE: &str = "提交的数据未通过校验，请检查后重试";

/// 把原样 JSON 解析成契约类型。
///
/// 解析失败归到 `VALIDATION_ERROR` 而不是 `INTERNAL_ERROR`：这是调用方
/// 传错了结构，不是后端故障，前端也不该重试。
pub fn parse<T: DeserializeOwned>(raw: Option<Value>, type_label: &str) -> AppResult<T> {
    let value = payload(raw);

    serde_json::from_value(value).map_err(|error| {
        AppError::validation_issues(
            VALIDATION_MESSAGE,
            vec![FieldIssue::new("_root", format!("{type_label} 结构不合法"))],
        )
        // 真正的解析细节只进日志：里面会带 JSON 片段，不该出现在界面上
        .with_detail(error.to_string())
    })
}

/// 把命令收到的原始入参归一成对象。缺失 / null 一律当空对象 ——
/// 于是「这条命令没有入参」只有一种处理方式，不必在每处 `unwrap_or_default`。
pub fn payload(raw: Option<Value>) -> Value {
    match raw {
        Some(Value::Null) | None => Value::Object(serde_json::Map::new()),
        Some(value) => value,
    }
}

/* ------------------------------------------------------------------ *
 * Validator
 *
 * 语义逐条对齐 zod：
 *   - 字段**缺失或为 null** 时取默认值（zod 只在 undefined 时取默认，
 *     null 会报错；这里放宽了 null —— 渲染层用 null 表达「不筛选」，
 *     若照搬 zod 会让书架页在默认状态下每次查询都被拒，见
 *     `bookListQuerySchema.status` 那段注释）
 *   - 字符串先 trim 再判空、再算长度
 *   - 长度按**字符数**算，不是字节数（一条中文占 3 字节，按字节算会把
 *     80 字的书名拦在 27 字）
 *   - 同一字段只记第一条问题（前端 `fieldErrors()` 也只取第一条）
 * ------------------------------------------------------------------ */

pub struct Validator<'a> {
    source: &'a Value,
    issues: Vec<FieldIssue>,
}

impl<'a> Validator<'a> {
    pub fn new(source: &'a Value) -> Self {
        Self {
            source,
            issues: Vec::new(),
        }
    }

    /// 取原始值。**null 视同缺失** —— 这是与 zod 的一处刻意差异，见类型注释。
    ///
    /// 返回值的生命周期显式绑到 `'a`（源 `Value`）而不是 `&self`：
    /// 绑到 `&self` 的话，`let raw = self.raw(k)` 之后就无法再调
    /// `self.record(...)`（一边持有不可变借用、一边要可变借用），
    /// 每个字段都得先 clone 一份值 —— 白白多一堆分配。
    fn raw(&self, key: &str) -> Option<&'a Value> {
        self.source.get(key).filter(|value| !value.is_null())
    }

    /// 记一条字段问题。**对外公开**，给「键集合由外部字段表驱动」的模块用
    /// —— 目前只有卡片的 `extra`：它有几个字段取决于 cardType，
    /// 没法在上面的固定方法里表达，只能在 `cards::commands` 里按表遍历。
    ///
    /// 同一路径只留第一条：前端 `fieldErrors()` 也是取第一条，
    /// 记多了只会让 issues 数组里出现用户看不到的重复项。
    pub fn record(&mut self, key: &str, message: impl Into<String>) {
        if self.issues.iter().any(|issue| issue.path == key) {
            return;
        }
        self.issues.push(FieldIssue::new(key, message));
    }

    /* ---------------- 字符串 ---------------- */

    /// 可空字符串：缺失 / null / trim 后为空 → 取默认值。
    pub fn string(
        &mut self,
        key: &str,
        default: &str,
        max: usize,
        empty_message: &str,
        too_long_message: &str,
    ) -> String {
        let Some(raw) = self.raw(key) else {
            return default.to_string();
        };
        let Some(text) = raw.as_str() else {
            self.record(key, empty_message);
            return default.to_string();
        };

        let trimmed = text.trim();
        if trimmed.is_empty() {
            return default.to_string();
        }
        if trimmed.chars().count() > max {
            self.record(key, too_long_message);
        }
        trimmed.to_string()
    }

    /// 必填字符串：缺失 / null / 空 / 超长都记账。
    pub fn required_string(
        &mut self,
        key: &str,
        max: usize,
        empty_message: &str,
        too_long_message: &str,
    ) -> String {
        let Some(raw) = self.raw(key) else {
            self.record(key, empty_message);
            return String::new();
        };
        let Some(text) = raw.as_str() else {
            self.record(key, empty_message);
            return String::new();
        };

        let trimmed = text.trim();
        if trimmed.is_empty() {
            self.record(key, empty_message);
            return String::new();
        }
        if trimmed.chars().count() > max {
            self.record(key, too_long_message);
        }
        trimmed.to_string()
    }

    /// 必填字符串，但**允许空串**。
    ///
    /// 用于 `z.string().max(N)` 这类「必须有这个字段、内容可以为空」的场合 ——
    /// 最典型的是章节正文：正文为空是完全合法的状态（新建的章），
    /// 但字段缺失绝不能当成空串处理，那等于把正文清空。
    pub fn required_string_allow_empty(
        &mut self,
        key: &str,
        max: usize,
        missing_message: &str,
        too_long_message: &str,
    ) -> String {
        let Some(raw) = self.raw(key) else {
            self.record(key, missing_message);
            return String::new();
        };
        let Some(text) = raw.as_str() else {
            self.record(key, missing_message);
            return String::new();
        };
        if text.chars().count() > max {
            self.record(key, too_long_message);
        }
        text.to_string()
    }

    /* ---------------- 数字 ---------------- */

    /// 整数：缺失 / null → 默认值；非整数、越界 → 记账并以默认值兜底。
    pub fn number(
        &mut self,
        key: &str,
        default: i64,
        min: i64,
        max: i64,
        not_integer_message: &str,
        min_message: &str,
        max_message: &str,
    ) -> i64 {
        let Some(raw) = self.raw(key) else {
            return default;
        };
        self.check_number(key, raw, min, max, not_integer_message, min_message, max_message)
            .unwrap_or(default)
    }

    /// 整数：必填（缺失即 `missing_message`）。
    pub fn required_number(
        &mut self,
        key: &str,
        min: i64,
        max: i64,
        missing_message: &str,
        min_message: &str,
        max_message: &str,
    ) -> i64 {
        let Some(raw) = self.raw(key) else {
            self.record(key, missing_message);
            return min;
        };
        self.check_number(key, raw, min, max, missing_message, min_message, max_message)
            .unwrap_or(min)
    }

    fn check_number(
        &mut self,
        key: &str,
        raw: &Value,
        min: i64,
        max: i64,
        not_integer_message: &str,
        min_message: &str,
        max_message: &str,
    ) -> Option<i64> {
        let Some(number) = raw.as_f64() else {
            self.record(key, not_integer_message);
            return None;
        };
        if number.fract() != 0.0 || number.is_nan() || number.is_infinite() {
            self.record(key, not_integer_message);
            return None;
        }
        if number < min as f64 {
            self.record(key, min_message);
            return None;
        }
        if number > max as f64 {
            self.record(key, max_message);
            return None;
        }
        Some(number as i64)
    }

    /// 正整数 ID。缺失 / 非正数 / 小数都算非法。
    ///
    /// 单独一个方法（而不是 `number(key, 0, 1, i64::MAX, ...)`）：
    /// ID 的非法文案全应用统一是「XX ID 非法」，散在各处写容易走样。
    pub fn id(&mut self, key: &str, invalid_message: &str) -> i64 {
        let Some(raw) = self.raw(key) else {
            self.record(key, invalid_message);
            return 0;
        };
        let Some(number) = raw.as_f64() else {
            self.record(key, invalid_message);
            return 0;
        };
        if number.fract() != 0.0 || number <= 0.0 {
            self.record(key, invalid_message);
            return 0;
        }
        number as i64
    }

    /// 可空的外键 ID：缺省或 null → None（表示「不挂到任何容器上」）。
    pub fn optional_id(&mut self, key: &str, invalid_message: &str) -> Option<i64> {
        if self.raw(key).is_none() {
            return None;
        }
        Some(self.id(key, invalid_message))
    }

    /// **必填但可空**的 ID：字段必须存在，取值可以是 null。
    ///
    /// 用于像 `chapterUpdateSchema.volumeId`（`number().positive().nullable()`，
    /// 没有默认值）这样的字段：缺字段是调用方 bug，而 null 是合法语义
    /// （「移出分卷」）。用 `optional_id` 会把这两件事混成一件 ——
    /// 前端少传一个字段就会被静默理解成「移出分卷」。
    pub fn required_nullable_id(&mut self, key: &str, invalid_message: &str) -> Option<i64> {
        let source = self.source;
        let Some(value) = source.get(key) else {
            self.record(key, invalid_message);
            return None;
        };
        if value.is_null() {
            return None;
        }
        Some(self.id(key, invalid_message))
    }

    /// **三态**的 ID：未提供 → None（不筛选）；null → `Some(None)`（只列未挂载的）；
    /// 数字 → `Some(Some(id))`（只列该容器下的）。
    ///
    /// 用于 `chapterListQuerySchema.volumeId`。三态必须由类型表达出来：
    /// 如果用 `Option<i64>` 并把 null 读成「不筛选」，用户点「未分卷」页签
    /// 就会看到整本书的章节；反之若读成 0，就会去查 `volume_id = 0` ——
    /// 一个永远查不到东西的容器。
    pub fn tri_state_id(&mut self, key: &str, invalid_message: &str) -> Option<Option<i64>> {
        let source = self.source;
        let Some(value) = source.get(key) else {
            return None;
        };
        if value.is_null() {
            return Some(None);
        }
        Some(Some(self.id(key, invalid_message)))
    }

    /* ---------------- 枚举 ---------------- */

    /// 枚举：缺失 / null → 默认值；不在值域内 → 记账。
    ///
    /// 值域随需求扩张，所以**不加数据库 CHECK**，只在这里拦
    /// （见迁移文件头那条约定）。
    pub fn enum_value(
        &mut self,
        key: &str,
        allowed: &[&str],
        default: &str,
        invalid_message: &str,
    ) -> String {
        let Some(raw) = self.raw(key) else {
            return default.to_string();
        };
        let Some(text) = raw.as_str() else {
            self.record(key, invalid_message);
            return default.to_string();
        };
        if allowed.contains(&text) {
            text.to_string()
        } else {
            self.record(key, invalid_message);
            default.to_string()
        }
    }

    /// 枚举：必填。
    pub fn required_enum(&mut self, key: &str, allowed: &[&str], invalid_message: &str) -> String {
        let Some(raw) = self.raw(key) else {
            self.record(key, invalid_message);
            return String::new();
        };
        let Some(text) = raw.as_str() else {
            self.record(key, invalid_message);
            return String::new();
        };
        if allowed.contains(&text) {
            text.to_string()
        } else {
            self.record(key, invalid_message);
            String::new()
        }
    }

    /// 宽松枚举：非法值**静默回落**而不是报错。
    ///
    /// 用于列表查询的排序与状态筛选：URL 里带来的旧值不该让整个页面打不开，
    /// 这是 TS 版 `normalizeBookListQuery` 的既有取舍，必须保住。
    pub fn lenient_enum(&self, key: &str, allowed: &[&str], default: &str) -> String {
        self.source
            .get(key)
            .and_then(|value| value.as_str())
            .filter(|text| allowed.contains(text))
            .unwrap_or(default)
            .to_string()
    }

    /* ---------------- 颜色 / 布尔 / 数组 ---------------- */

    /// 十六进制颜色。只接受 #RGB / #RRGGBB —— 这个值会被写进内联样式，
    /// 放开就等于允许把任意字符串塞进 CSS。
    pub fn hex_color(&mut self, key: &str, default: &str, invalid_message: &str) -> String {
        let value = self.string(key, default, 7, invalid_message, invalid_message);
        if is_hex_color(&value) {
            value
        } else {
            self.record(key, invalid_message);
            default.to_string()
        }
    }

    /// 必填十六进制颜色（更新接口用：整体替换语义下缺字段是真错）。
    pub fn required_hex_color(&mut self, key: &str, invalid_message: &str) -> String {
        let value = self.required_string(key, 7, invalid_message, invalid_message);
        if is_hex_color(&value) {
            value
        } else {
            self.record(key, invalid_message);
            String::new()
        }
    }

    pub fn boolean(&mut self, key: &str, default: bool, invalid_message: &str) -> bool {
        let Some(raw) = self.raw(key) else {
            return default;
        };
        match raw.as_bool() {
            Some(value) => value,
            None => {
                self.record(key, invalid_message);
                default
            }
        }
    }

    /// 正整数 ID 数组（重排接口用）。上限防止一次提交几万个 id 把库里写爆。
    pub fn id_array(&mut self, key: &str, max_len: usize, too_many_message: &str) -> Vec<i64> {
        let Some(raw) = self.raw(key) else {
            self.record(key, "缺少 ID 列表");
            return Vec::new();
        };
        let Some(items) = raw.as_array() else {
            self.record(key, "ID 列表必须是数组");
            return Vec::new();
        };
        if items.len() > max_len {
            self.record(key, too_many_message);
        }

        let mut result = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            match item.as_f64() {
                Some(number) if number.fract() == 0.0 && number > 0.0 => {
                    result.push(number as i64);
                }
                _ => {
                    // 路径带上下标，前端才能把错误指到具体那一个元素
                    self.record(&format!("{key}.{index}"), "ID 必须是正整数");
                    return Vec::new();
                }
            }
        }
        result
    }

    /// 字符串数组（标签等）。逐项 trim、丢弃空项、逐项限长。
    pub fn string_array(
        &mut self,
        key: &str,
        max_items: usize,
        max_length: usize,
        too_many_message: &str,
        too_long_message: &str,
    ) -> Vec<String> {
        let Some(raw) = self.raw(key) else {
            return Vec::new();
        };
        let Some(items) = raw.as_array() else {
            self.record(key, "必须是文本数组");
            return Vec::new();
        };
        if items.len() > max_items {
            self.record(key, too_many_message);
        }

        let mut result = Vec::new();
        for item in items {
            let Some(text) = item.as_str() else {
                self.record(key, "必须是文本数组");
                return Vec::new();
            };
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.chars().count() > max_length {
                self.record(key, too_long_message);
                continue;
            }
            result.push(trimmed.to_string());
        }
        result
    }

    /// 字符串数组，但**空项算校验失败**（对应 zod 的 `z.string().trim().min(1)`）。
    ///
    /// 与 `string_array` 的差别只有这一处：那边丢空项，这边记一条问题。
    /// 两者都要有 —— 卡片的标签属于「用户根本不会输入空标签，传了就是调用方
    /// 有 bug」的字段，静默丢掉会让边界校验形同虚设；而按长度截断之类的
    /// 宽容处理在别处仍然是想要的。
    pub fn string_array_strict(
        &mut self,
        key: &str,
        max_items: usize,
        max_length: usize,
        too_many_message: &str,
        empty_item_message: &str,
        too_long_message: &str,
    ) -> Vec<String> {
        let Some(raw) = self.raw(key) else {
            return Vec::new();
        };
        let Some(items) = raw.as_array() else {
            self.record(key, "必须是文本数组");
            return Vec::new();
        };
        if items.len() > max_items {
            self.record(key, too_many_message);
        }

        let mut result = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let Some(text) = item.as_str() else {
                self.record(key, "必须是文本数组");
                return Vec::new();
            };
            let trimmed = text.trim();
            if trimmed.is_empty() {
                // 路径带下标，前端才能把错误落到具体那一个标签上
                self.record(&format!("{key}.{index}"), empty_item_message);
                continue;
            }
            if trimmed.chars().count() > max_length {
                self.record(&format!("{key}.{index}"), too_long_message);
                continue;
            }
            result.push(trimmed.to_string());
        }
        result
    }

    /* ---------------- 收尾 ---------------- */

    /// 有任何一条问题就回失败信封；否则放行。
    ///
    /// 调用方约定：先做完所有取值，再 `finish()?`，最后才构造结构体。
    /// 这样即使字段非法也不会走到业务代码 —— 与 zod 的「parse 抛错则
    /// handle 根本不执行」是同一条保证。
    pub fn finish(self) -> AppResult<()> {
        if self.issues.is_empty() {
            Ok(())
        } else {
            Err(AppError::validation_issues(VALIDATION_MESSAGE, self.issues))
        }
    }

    /// 直接带上「字段名 → 取值」的装配：省掉调用方一次 `finish()?`。
    pub fn build<T>(self, assemble: impl FnOnce(&Self) -> T) -> AppResult<T> {
        let value = assemble(&self);
        self.finish()?;
        Ok(value)
    }
}

/// 十六进制颜色。只接受 #RGB / #RRGGBB。
pub fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !value.starts_with('#') {
        return false;
    }
    matches!(bytes.len(), 4 | 7) && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}
