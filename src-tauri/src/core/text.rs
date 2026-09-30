//! 文本度量与 HTML 转纯文本（前端对应 `src/shared/text.ts`）。
//!
//! 这个文件决定 `hanzi_count` / `char_count` 两个落库的值，因此**口径必须与
//! 前端那一份实现（`src/shared/text.ts`）逐字一致**：不一致的症状是
//! 「编辑器里显示的字数与统计页对不上」—— 一边是 JS 算的、一边是 Rust 算的，
//! 同一本书里两种数字混着显示，而用户只会觉得「这软件的数字不准」。
//!
//! 三处刻意对齐的细节：
//!   - 汉字用 Unicode **Script** 属性（`\p{Han}`）而不是 `[\u4e00-\u9fa5]`
//!     区间 —— 后者漏掉扩展 B 区之后的生僻字，而这些人名、古籍风设定里很常见
//!   - 非空白字符用 **JS 的 `\s` 定义**，它比 Unicode `White_Space` 多一个
//!     U+FEFF（零宽不换行空格）、少一个 U+0085（NEL）
//!   - HTML 转文本必须**先剥标签再解实体**，反过来的话正文里字面写出的
//!     `&lt;p&gt;` 会在解码后变成 `<p>` 再被当成标签删掉

use once_cell::sync::Lazy;
use regex::Regex;

pub struct TextMetrics {
    /// 汉字数：不计标点、数字、字母、空格。**本项目的主口径**
    pub hanzi: usize,
    /// 非空白字符数（含标点与字母数字），用于与网文平台显示的字数对照
    pub characters: usize,
}

/// Unicode `Script=Han`。用正则 crate 的脚本属性支持，而不是自己写区间表 ——
/// 手写的区间表一定会漏掉 CJK 扩展平面，而漏掉的部分只在个别章节显形。
static HAN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\p{Han}").expect("汉字正则非法"));

/// JS 的 `\s` 定义（ECMAScript WhiteSpace + LineTerminator）。
///
/// 与 Rust 正则的 `\S` 有细微差别：JS 把 U+FEFF 算作空白，Unicode 的
/// `White_Space` 不算；反过来 U+0085 在 Unicode 里是空白，JS 不算。
/// 用显式集合而不是 `\S`，是为了让这两个边界字符的行为与前端实现一致。
///
/// 检索侧的切词（`modules::search`）也用它：那边要复刻 JS 的
/// `split(/\s+/)`，用 `Rust` 的 `split_whitespace` 会在全角空格以外的
/// 两个边界字符上走样 —— 中文输入法下打出的全角空格必须能切开词。
pub fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'          // Tab
        | '\u{000B}'        // 垂直制表
        | '\u{000C}'        // 换页
        | '\u{0020}'        // 空格
        | '\u{00A0}'        // 不间断空格
        | '\u{1680}'
        | '\u{2000}'..='\u{200A}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{202F}'
        | '\u{205F}'
        | '\u{3000}'
        | '\u{FEFF}'
    ) || ch == '\n'
        || ch == '\r'
}

pub fn count_hanzi(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    HAN.find_iter(text).count()
}

pub fn count_non_whitespace(text: &str) -> usize {
    text.chars().filter(|ch| !is_js_whitespace(*ch)).count()
}

pub fn measure_text(text: &str) -> TextMetrics {
    TextMetrics {
        hanzi: count_hanzi(text),
        characters: count_non_whitespace(text),
    }
}

/* ------------------------------------------------------------------ *
 * HTML → 纯文本
 * ------------------------------------------------------------------ */

/// 块级标签：它们的边界应当转换为换行。
///
/// 少了这一步，两段之间的字会被当成同一行连起来，虽然不影响汉字总数，
/// 但会让基于 `content_text` 的搜索结果难以阅读。
const BLOCK_TAG_NAMES: &str =
    r"p|div|h[1-6]|li|blockquote|pre|tr|section|article|figure|figcaption";

static BR_TAG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)<br\s*/?>").expect("br 正则非法"));
static BLOCK_CLOSE_TAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(r"(?i)</(?:{BLOCK_TAG_NAMES})\s*>")).expect("块级闭标签正则非法")
});
static BLOCK_OPEN_TAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(r"(?i)<(?:{BLOCK_TAG_NAMES})\b[^>]*>")).expect("块级开标签正则非法")
});
static ANY_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]*>").expect("标签正则非法"));
static CR_LF: Lazy<Regex> = Lazy::new(|| Regex::new(r"\r\n?").expect("换行正则非法"));
static NBSP: Lazy<Regex> = Lazy::new(|| Regex::new("\u{a0}").expect("nbsp 正则非法"));
static SPACE_BEFORE_NEWLINE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[ \t]+\n").expect("行尾空白正则非法"));
static MANY_NEWLINES: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\n{3,}").expect("空行正则非法"));
static ENTITY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);").expect("实体正则非法")
});

/// 常用的命名实体。不在表里的实体会原样保留，不会被悄悄吃掉。
fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "hellip" => "\u{2026}",
        "mdash" => "\u{2014}",
        "ndash" => "\u{2013}",
        "middot" => "\u{00b7}",
        "times" => "\u{00d7}",
        _ => return None,
    })
}

/// 码点转字符。越界与代理区一律返回 None —— 与 JS `String.fromCodePoint`
/// 抛异常的行为对应（那边 catch 之后保留原文，这边返回 None 也一样）。
fn safe_from_code_point(code: u32) -> Option<char> {
    char::from_u32(code)
}

fn decode_entities(text: &str) -> String {
    ENTITY
        .replace_all(text, |caps: &regex::Captures<'_>| {
            let whole = caps.get(0).map(|m| m.as_str()).unwrap_or_default();
            let body = caps.get(1).map(|m| m.as_str()).unwrap_or_default();

            if body.len() > 1 && (body.starts_with("#x") || body.starts_with("#X")) {
                return u32::from_str_radix(&body[2..], 16)
                    .ok()
                    .and_then(safe_from_code_point)
                    .map(|ch| ch.to_string())
                    .unwrap_or_else(|| whole.to_string());
            }
            if let Some(digits) = body.strip_prefix('#') {
                return digits
                    .parse::<u32>()
                    .ok()
                    .and_then(safe_from_code_point)
                    .map(|ch| ch.to_string())
                    .unwrap_or_else(|| whole.to_string());
            }
            named_entity(&body.to_ascii_lowercase())
                .map(|value| value.to_string())
                .unwrap_or_else(|| whole.to_string())
        })
        .into_owned()
}

/// 把编辑器产出的 HTML 转成纯文本。
pub fn html_to_text(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }

    // 顺序即语义：先剥标签，最后才解实体（理由见文件头）
    let stripped = BR_TAG.replace_all(html, "\n");
    let stripped = BLOCK_CLOSE_TAG.replace_all(&stripped, "\n");
    let stripped = BLOCK_OPEN_TAG.replace_all(&stripped, "\n");
    let stripped = ANY_TAG.replace_all(&stripped, "");
    let decoded = decode_entities(&stripped);

    let normalized = CR_LF.replace_all(&decoded, "\n");
    let normalized = NBSP.replace_all(&normalized, " ");
    let normalized = SPACE_BEFORE_NEWLINE.replace_all(&normalized, "\n");
    let normalized = MANY_NEWLINES.replace_all(&normalized, "\n\n");

    normalized.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 汉字只数汉字() {
        assert_eq!(count_hanzi("他说：hello 123 世界"), 4);
        assert_eq!(count_hanzi(""), 0);
        assert_eq!(count_hanzi("abc"), 0);
    }

    #[test]
    fn 生僻字也算汉字() {
        // U+20000（CJK 扩展 B 区），旧实现用 [\u4e00-\u9fa5] 会漏掉
        assert_eq!(count_hanzi("\u{20000}"), 1);
    }

    #[test]
    fn 非空白字符不数空白() {
        assert_eq!(count_non_whitespace("你 好\n世\t界"), 4);
        // U+FEFF 在 JS 的 \s 里，因此不计入
        assert_eq!(count_non_whitespace("\u{feff}"), 0);
        // U+00A0 在 JS 的 \s 里，因此不计入
        assert_eq!(count_non_whitespace("\u{a0}"), 0);
    }

    #[test]
    fn 先剥标签再解实体() {
        // 正文里字面写出的 &lt;p&gt; 必须原样留下，不能被当成标签删掉
        assert_eq!(html_to_text("<p>&lt;p&gt;</p>"), "<p>");
        assert_eq!(html_to_text("<p>你好<br>世界</p>"), "你好\n世界");
        // 相邻块级标签之间会留下**一个空行**：开标签与闭标签各贡献一个换行。
        // 这不是 bug，而是**既有行为**：三处正则（br / 块级闭 / 块级开）
        // 依次替换，中间没有「合并相邻换行」的一步，`\n{3,}` 也压不到两行。
        // 保持它是因为 content_text 已经按这个形状落库了 —— 改了会让
        // 老数据的段落间距与新数据不一致。
        assert_eq!(html_to_text("<div>上</div><div>下</div>"), "上\n\n下");
        assert_eq!(html_to_text("&ldquo;引号&rdquo;"), "\u{201c}引号\u{201d}");
    }

    #[test]
    fn 空白归一() {
        assert_eq!(html_to_text("甲   \n乙"), "甲\n乙");
        assert_eq!(html_to_text("甲\n\n\n\n乙"), "甲\n\n乙");
        assert_eq!(html_to_text("  <p>甲</p>  "), "甲");
    }
}
