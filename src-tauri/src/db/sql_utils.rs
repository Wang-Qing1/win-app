//! SQL 小工具（对应 TS 侧的 `src/main/db/sql-utils.ts`）。

/// 把用户输入包成 LIKE 的「包含」模式，并转义通配符。
///
/// 不转义的话，用户搜 `100%` 会变成「以 100 开头」、搜 `a_b` 会变成
/// 「a 任意字符 b」—— 搜出来的结果看着像随机的，很难联想到是通配符问题。
/// 配套的 SQL 必须写 `LIKE @keyword ESCAPE '\'`。
pub fn contains_pattern(keyword: &str) -> String {
    let mut escaped = String::with_capacity(keyword.len() + 2);
    escaped.push('%');
    for ch in keyword.chars() {
        match ch {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped.push('%');
    escaped
}

/// SQLite 的整数聚合在无匹配行时返回 NULL；统一收敛成 0，
/// 免得每个调用点都写一遍 `unwrap_or(0)` 并埋下漏掉的隐患。
pub fn to_number(value: Option<i64>) -> i64 {
    value.unwrap_or(0)
}

/// JSON 列的解析：内容坏掉时回 `None`，调用方按「这一列没有值」处理。
///
/// 对应 TS 侧 `parseJsonObject` 的目的：一行脏数据不该把整个列表打挂。
pub fn parse_json(raw: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(raw).ok()
}

/// JSON 数组列的安全解析（对应 TS 侧 `parseJsonArray`）。
///
/// **非字符串项被丢掉而不是转成字符串**：`tags` 这一列理论上只装字符串，
/// 出现数字说明这行数据是别处写坏的 —— 把它变成一个看起来正常的标签，
/// 只会让脏数据混进搜索结果里，还不如让它消失。
pub fn parse_string_array(raw: &str) -> Vec<String> {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| match item {
                serde_json::Value::String(text) => Some(text),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/* ------------------------------------------------------------------ *
 * 这里刻意**不放**分页归一化。
 *
 * 分页参数（page ≥ 1、1 ≤ pageSize ≤ 200）在 TS 侧是 zod schema 的
 * `.min/.max` —— 越界是**拒绝**并回一条 VALIDATION_ERROR，不是悄悄夹到
 * 边界值。若这里再放一个 clamp，就会出现两套口径：命令边界拒绝了，
 * 而别处调用又把它夹回来了，排查时看到的现象是「有时报错、有时不报」。
 * 因此归一化只有一个归属地：输入类型的 `validate()`。
 * ------------------------------------------------------------------ */
