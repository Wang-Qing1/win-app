//! 迁移列表 —— 只允许在末尾追加，已发布的条目禁止改动。
//!
//! 逐条对应 TS 侧的 `src/main/db/migrations/index.ts`：**SQL 必须逐字一致**，
//! 因为两种壳要能打开同一个库文件。只要有一条 DDL 写法不同，升级路径
//! 就会分叉成两个 schema，而这种分叉在用户库里是看不出来的。
//!
//! 关于 CHECK 约束的一条约定（重要）：
//!   只对**结构性不变式**加 CHECK（非空、非负、取值范围），
//!   不对**枚举值域**加 CHECK。
//!   原因：SQLite 无法 ALTER 一个已有的 CHECK，改枚举值域必须走重建表流程；
//!   而这些枚举（书本状态、卡片类型、大纲节点类型）恰是最容易随需求扩张的部分。
//!   枚举值域由输入类型的 `validate()` 在命令边界强制，两侧同一份定义。

use rusqlite::Transaction;

use crate::core::errors::AppResult;

pub struct Migration {
    /// 唯一名称，落库后用于判断是否已执行。一旦发布不可修改
    pub name: &'static str,
    pub sql: &'static str,
    /// 纯 SQL 表达不了的一次性数据加工（只有 008 用到）
    pub post: Option<fn(&Transaction<'_>) -> AppResult<()>>,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        name: "001_init_contacts",
        sql: "
            CREATE TABLE contacts (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              name       TEXT    NOT NULL,
              email      TEXT    NOT NULL DEFAULT '',
              phone      TEXT    NOT NULL DEFAULT '',
              company    TEXT    NOT NULL DEFAULT '',
              tags       TEXT    NOT NULL DEFAULT '[]',
              note       TEXT    NOT NULL DEFAULT '',
              created_at TEXT    NOT NULL,
              updated_at TEXT    NOT NULL,
              CHECK (length(trim(name)) > 0)
            );

            CREATE INDEX idx_contacts_name       ON contacts(name COLLATE NOCASE);
            CREATE INDEX idx_contacts_company    ON contacts(company COLLATE NOCASE);
            CREATE INDEX idx_contacts_updated_at ON contacts(updated_at DESC);
        ",
        post: None,
    },
    Migration {
        name: "002_novel_schema",
        sql: "
            /* ---------------------------------------------------------------- *
             * books —— 书籍
             * target_words 是整本书的写作目标（0 表示不设）；chapter_words 是
             * 「每章最少字数」，全书统一生效，编辑器底栏的「计划：剩 N」按它算。
             * accent_color 给书籍卡片用，让书架有辨识度而不需要真的传图。
             * ---------------------------------------------------------------- */
            CREATE TABLE books (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              title         TEXT    NOT NULL,
              pen_name      TEXT    NOT NULL DEFAULT '',
              genre         TEXT    NOT NULL DEFAULT '',
              status        TEXT    NOT NULL DEFAULT 'idea',
              summary       TEXT    NOT NULL DEFAULT '',
              target_words  INTEGER NOT NULL DEFAULT 0,
              accent_color  TEXT    NOT NULL DEFAULT '#0f6cbd',
              created_at    TEXT    NOT NULL,
              updated_at    TEXT    NOT NULL,
              CHECK (length(trim(title)) > 0),
              CHECK (target_words >= 0)
            );

            CREATE INDEX idx_books_title      ON books(title COLLATE NOCASE);
            CREATE INDEX idx_books_updated_at ON books(updated_at DESC);

            /* ---------------------------------------------------------------- *
             * volumes —— 分卷
             * order_index 的作用域是所属书籍：同一本书内从 0 递增。
             * ---------------------------------------------------------------- */
            CREATE TABLE volumes (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
              title       TEXT    NOT NULL,
              summary     TEXT    NOT NULL DEFAULT '',
              order_index INTEGER NOT NULL DEFAULT 0,
              created_at  TEXT    NOT NULL,
              updated_at  TEXT    NOT NULL,
              CHECK (length(trim(title)) > 0)
            );

            CREATE INDEX idx_volumes_book_order ON volumes(book_id, order_index);

            /* ---------------------------------------------------------------- *
             * chapters —— 章节
             *
             * content_html 是富文本编辑器（TipTap）的真正来源；
             * content_text 是它的纯文本投影，供字数统计与全文搜索使用。
             *
             * 为什么冗余存一份纯文本：统计与搜索只需要文本。若每次都从 HTML
             * 现解析，就要正确处理去标签、HTML 实体解码、块级标签转换 —— 任何
             * 一处漏掉字数就是错的。纯文本体积约为 HTML 的 60%，用这点空间换掉
             * 一个高频且易错的解析步骤是划算的。
             *
             * hanzi_count 与 char_count 同样是冗余：列表与统计页都读它们，
             * 若每次去扫正文（可能几十万字），会反复冲掉 SQLite 的页缓存。
             * 不变式「改正文必须同步改这三个字段」由服务层的事务保证。
             *
             * volume_id 用 ON DELETE SET NULL 而不是 CASCADE：
             * 删掉一个分卷，卷下的章节应当保留并退回到「未分卷」，而不是跟着消失。
             * ---------------------------------------------------------------- */
            CREATE TABLE chapters (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
              volume_id    INTEGER REFERENCES volumes(id) ON DELETE SET NULL,
              title        TEXT    NOT NULL,
              content_html TEXT    NOT NULL DEFAULT '',
              content_text TEXT    NOT NULL DEFAULT '',
              hanzi_count  INTEGER NOT NULL DEFAULT 0,
              char_count   INTEGER NOT NULL DEFAULT 0,
              status       TEXT    NOT NULL DEFAULT 'draft',
              order_index  INTEGER NOT NULL DEFAULT 0,
              created_at   TEXT    NOT NULL,
              updated_at   TEXT    NOT NULL,
              CHECK (length(trim(title)) > 0),
              CHECK (hanzi_count >= 0),
              CHECK (char_count >= 0)
            );

            CREATE INDEX idx_chapters_book_order    ON chapters(book_id, order_index);
            CREATE INDEX idx_chapters_volume_order  ON chapters(volume_id, order_index);
            CREATE INDEX idx_chapters_updated_at    ON chapters(updated_at DESC);

            /* ---------------------------------------------------------------- *
             * outline_nodes —— 大纲节点
             *
             * parent_id 自引用，因此大纲支持任意层级（卷 → 主线 → 支线 → 事件）。
             * chapter_id 让一个构想节点可以「落地」成真实章节并保持双向关联。
             * ---------------------------------------------------------------- */
            CREATE TABLE outline_nodes (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
              parent_id   INTEGER REFERENCES outline_nodes(id) ON DELETE CASCADE,
              chapter_id  INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
              node_type   TEXT    NOT NULL DEFAULT 'plot',
              title       TEXT    NOT NULL,
              summary     TEXT    NOT NULL DEFAULT '',
              status      TEXT    NOT NULL DEFAULT 'planned',
              order_index INTEGER NOT NULL DEFAULT 0,
              created_at  TEXT    NOT NULL,
              updated_at  TEXT    NOT NULL,
              CHECK (length(trim(title)) > 0)
            );

            CREATE INDEX idx_outline_book_parent ON outline_nodes(book_id, parent_id, order_index);
            CREATE INDEX idx_outline_chapter     ON outline_nodes(chapter_id);

            /* ---------------------------------------------------------------- *
             * cards —— 灵感 / 人物 / 物品卡片
             *
             * 三类卡片共用一张表：共性（标题、一句话简介、正文、标签、归属书籍）
             * 是大部分，差异（人物有身份/关系，物品有品阶/来源）放进 extra 这个
             * JSON 列，由共享层的判别联合约束形状。好处是三套 CRUD 只写一遍。
             *
             * book_id 允许为 NULL：有些灵感是跨书通用的。
             * ---------------------------------------------------------------- */
            CREATE TABLE cards (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              book_id    INTEGER REFERENCES books(id) ON DELETE CASCADE,
              card_type  TEXT    NOT NULL,
              title      TEXT    NOT NULL,
              subtitle   TEXT    NOT NULL DEFAULT '',
              content    TEXT    NOT NULL DEFAULT '',
              tags       TEXT    NOT NULL DEFAULT '[]',
              extra      TEXT    NOT NULL DEFAULT '{}',
              created_at TEXT    NOT NULL,
              updated_at TEXT    NOT NULL,
              CHECK (length(trim(title)) > 0)
            );

            CREATE INDEX idx_cards_type  ON cards(card_type);
            CREATE INDEX idx_cards_book  ON cards(book_id, card_type);
            CREATE INDEX idx_cards_title ON cards(title COLLATE NOCASE);

            /* ---------------------------------------------------------------- *
             * writing_sessions —— 写作会话，统计的唯一事实源
             *
             * 为什么不直接拿章节目录的字数做统计：章节目录只是「当前快照」，
             * 删掉一章就会让历史写作量凭空消失。而「我昨天写了 2000 字」是
             * 既成事实，不该因为今天的结构调整被抹掉。
             *
             * 三个字数怎么用（「仅统计汉字」口径下的必要设计）：
             *   校对会删字，净变化可能为负。若直接用它算「今日写了多少」，
             *   精修一天稿子会显示成负数。因此：
             *     写作量 = peak_words - start_words   → 首页今日数字、趋势图
             *     净  增 = end_words  - start_words   → 书籍进度条、目标完成度
             *
             * book_id / chapter_id 用 ON DELETE SET NULL：删书删章后会话保留。
             * ---------------------------------------------------------------- */
            CREATE TABLE writing_sessions (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              book_id          INTEGER REFERENCES books(id) ON DELETE SET NULL,
              chapter_id       INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
              started_at       TEXT    NOT NULL,
              ended_at         TEXT    NOT NULL,
              duration_seconds INTEGER NOT NULL DEFAULT 0,
              start_words      INTEGER NOT NULL DEFAULT 0,
              end_words        INTEGER NOT NULL DEFAULT 0,
              peak_words       INTEGER NOT NULL DEFAULT 0,
              CHECK (duration_seconds >= 0),
              CHECK (start_words >= 0),
              CHECK (end_words >= 0),
              CHECK (peak_words >= 0)
            );

            CREATE INDEX idx_sessions_started_at ON writing_sessions(started_at DESC);
            CREATE INDEX idx_sessions_book       ON writing_sessions(book_id, started_at DESC);
        ",
        post: None,
    },
    Migration {
        name: "003_drop_contacts",
        // contacts 是脚手架阶段的示例模块，小说助手不需要它。
        // 单独一条迁移而不是回改 001：已发布的迁移改动后，老用户的库不会重新执行，
        // 只有新增迁移才能保证「新装」与「升级」两条路径得到同一个 schema。
        sql: "DROP TABLE IF EXISTS contacts;",
        post: None,
    },
    Migration {
        name: "004_chapter_target_words",
        // 章节级的目标字数，用于编辑器底部「计划：剩 N」。
        // 默认 0 表示未设目标；ALTER TABLE ADD COLUMN 带非空默认值属于
        // SQLite 支持的常量默认场景，老数据自动填 0，不需要回填脚本。
        sql: "ALTER TABLE chapters ADD COLUMN target_words INTEGER NOT NULL DEFAULT 0;",
        post: None,
    },
    Migration {
        name: "005_book_chapter_words",
        // 「每章最少字数」从章节级上提到书籍级。
        //
        // 004 给章节加了 target_words，让作者逐章去填 —— 实际用下来是纯粹的
        // 重复劳动：「每章至少 2000 字」本来就是一本书定一次、全书生效的规则。
        // 所以把它上提到 books，编辑器那一整行输入也随之删掉。
        //
        // chapters.target_words 保留不动：它已经落在用户的库里，删列要重建表；
        // 而它现在只是「建章那一刻书级设置的快照」，仍被导出与统计读到。
        sql: "
            ALTER TABLE books ADD COLUMN chapter_words INTEGER NOT NULL DEFAULT 2000;

            /* 回填：老库里作者认真填过的章节目标是他真实意图，直接丢掉会让人
               升级后发现「每章最少字数」全变回 2000。取每本书下章节目标字数的
               最大值 —— 手动填过的那些章代表他的标准，没填的 0 是「懒得填」
               而非「要 0」。 */
            UPDATE books
               SET chapter_words = (
                     SELECT MAX(target_words) FROM chapters WHERE chapters.book_id = books.id
                   )
             WHERE (SELECT MAX(target_words) FROM chapters WHERE chapters.book_id = books.id) > 0;
        ",
        post: None,
    },
    Migration {
        name: "006_card_chapter_links",
        /* 卡片 ↔ 章节的关联：「这条设定用在哪几章」「这一章用到了哪几条设定」。
         *
         * 为什么单独一张表，而不是在 cards 上加一个 chapter_ids 列：
         * 反查（从章节找卡片）是这个功能的另一半，而数组列上的反查
         * 只能全表扫后再逐行解析 JSON。一张关联表两个方向都走索引。
         *
         * 复合主键而不是自增 id：同一对 (card, chapter) 只能存在一次。
         * 靠代码去判重的话，「快速连点两下」那种竞态迟早会撞出重复行。
         *
         * 两个外键都是 CASCADE：卡片和章节的删除都是「这条资料本身没了」，
         * 关联随之消失是预期的。 */
        sql: "
            CREATE TABLE card_chapter_links (
              card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
              chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
              created_at TEXT    NOT NULL,
              PRIMARY KEY (card_id, chapter_id)
            );

            CREATE INDEX idx_card_links_chapter ON card_chapter_links (chapter_id);
        ",
        post: None,
    },
    Migration {
        name: "007_card_outline_links",
        /* 卡片 ↔ 大纲节点的关联。与 006 完全同构，只是目标换成 outline_nodes。
         *
         * **为什么不合并成一张带 target_type 的表**：两处关联在语义上确实不同 ——
         * 章节是「已经写出来的正文」，节点是「还没写的构想」。分开之后每一侧的
         * 查询都不必带一个恒定的过滤条件，也不必为「另一半」的字段让出可为 NULL
         * 的列。代价是两张表，换来两条各自独立的读路径。 */
        sql: "
            CREATE TABLE card_outline_links (
              card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
              node_id    INTEGER NOT NULL REFERENCES outline_nodes(id) ON DELETE CASCADE,
              created_at TEXT    NOT NULL,
              PRIMARY KEY (card_id, node_id)
            );

            CREATE INDEX idx_card_outline_node ON card_outline_links (node_id);
        ",
        post: None,
    },
    Migration {
        name: "008_card_relations",
        /* 卡片 ↔ 卡片的关系：人物卡的「关系」从一行纯文本改成指向另一张卡的
         * 关联，于是关系能被点着跳过去、能被反查、删掉一张卡时关系随之消失。
         *
         * 与 006 / 007 的差别是这一张表**没有方向**：两人之间是「师徒」不因从
         * 哪一头看而改变。所以加了 `CHECK (card_id < related_id)` —— 它把
         * 「A 连 B」与「B 连 A」收成同一种写法，于是一对卡之间只可能存在一条边
         * （重复建立变成改关系名，见仓储的 UPSERT），也顺带让「自己连自己」
         * 在结构层面就不可能表达。
         *
         * 这条 CHECK 属于**结构性不变式**而不是枚举值域（见文件头那条约定）。
         * 写入前由服务层用共享层的 `sortRelationPair` 排好序。 */
        sql: "
            CREATE TABLE card_relations (
              card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
              related_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
              relation   TEXT    NOT NULL,
              created_at TEXT    NOT NULL,
              PRIMARY KEY (card_id, related_id),
              CHECK (card_id < related_id)
            );

            CREATE INDEX idx_card_relations_related ON card_relations (related_id);
        ",
        post: Some(move_legacy_relationship),
    },
    Migration {
        name: "009_chapter_revisions",
        /* 章节的历史版本：解决「误删一大段拿不回来」。
         *
         * 现状是自动保存只覆盖不留存 —— 编辑器把每次改动都写回 chapters 那一行，
         * 前一版正文当场就没了。这一张表把每次保存的**前一个**版本留一份。
         *
         * 为什么存整份快照而不是存 diff：diff 省空间，但要还原第 N 版必须从基线
         * 一路重放，任何一版缺失或算法改动都会让老数据算不出来；而正文是换行很多
         * 的纯文本，一章也就几十 KB，总量仍在几十 MB 量级。用空间换「任何一版
         * 都能独立读出来」，是这类本地优先应用该做的取舍。
         *
         * content_text / hanzi_count / char_count 三个派生值同样存快照：回档时
         * 若只回正文、不复算这三个，列表上会显示回档前的字数，与正文自相矛盾。
         *
         * 索引按 (chapter_id, created_at DESC)：唯一要走的查询就是
         * 「这一章的版本，最新的在前」，正好是这个顺序。 */
        sql: "
            CREATE TABLE chapter_revisions (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              chapter_id   INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
              content_html TEXT    NOT NULL,
              content_text TEXT    NOT NULL,
              hanzi_count  INTEGER NOT NULL,
              char_count   INTEGER NOT NULL,
              created_at   TEXT    NOT NULL,
              CHECK (hanzi_count >= 0),
              CHECK (char_count >= 0)
            );

            CREATE INDEX idx_chapter_revisions_chapter ON chapter_revisions (chapter_id, created_at DESC);
        ",
        post: None,
    },
    Migration {
        name: "010_soft_delete",
        /* 回收站：卡片与章节的删除改为**软删除**。
         *
         * 现状是 DELETE 直接把行抹掉：作者删掉一章、一份人物设定，再想找回来
         * 只能从数据库备份里捞 —— 而备份是整库级别的，为了找回一张卡把三个月
         * 的稿子回退到某个时间点，显然不是可选项。加一列 deleted_at 之后，
         * 「删除」变成打一个时间戳，列表侧统一排除它，回收站页把它列出来。
         *
         * **NULL 表示还在（没被删）**，而不是用 0 / 空串表示「未删除」：
         * 用一个哨兵值会让每一处查询都要多写一个 OR。而且 deleted_at IS NULL
         * 正是 SQLite 能走部分索引的形状。
         *
         * 为什么只有 cards 与 chapters 两张表：
         *   - books（书籍）与 volumes（分卷）是容器，删它们走 CASCADE，
         *     语义是「连同内容一起清掉」，与「误删一张卡想找回来」不是一回事；
         *   - outline_nodes 是大纲树，删一个父节点会连坐整棵子树，
         *     软删除会让「子树里哪些是被删的、哪些是活的」变得极难推理。
         *
         * 索引是**部分索引**（WHERE deleted_at IS NOT NULL）：回收站页要的就是
         * 「全部被删的条目，按删除时间倒序」，条目数在几十的量级，体积极小，
         * 而且不会让「查活着的行」那侧多维护一份索引。 */
        sql: "
            ALTER TABLE cards    ADD COLUMN deleted_at TEXT;
            ALTER TABLE chapters ADD COLUMN deleted_at TEXT;

            CREATE INDEX idx_cards_deleted_at
                ON cards (deleted_at DESC) WHERE deleted_at IS NOT NULL;
            CREATE INDEX idx_chapters_deleted_at
                ON chapters (deleted_at DESC) WHERE deleted_at IS NOT NULL;
        ",
        post: None,
    },
];

/// 008 的一次性搬迁：人物卡旧的「与主角关系」是一行纯文本
/// （`extra.relationship`），现在这个字段被关系表取代，而 `normalize_extra`
/// 只保留登记过的键 —— 也就是说，不动它的话，作者写过的那段关系会在下一次
/// 保存这张卡时 **无声消失**。
///
/// 文本里没有指向哪张卡，没法自动转成关联，所以搬到正文末尾：
/// 让作者在下一次打开这张卡时看见自己记过什么，再手动建成结构化关系。
///
/// 上限按 5000 收（与 CARD_LIMITS.content 一致）：正文已经很满的卡就只搬
/// 能放下的那一段，总好过让这张卡因为超限再也保存不了。
fn move_legacy_relationship(tx: &Transaction<'_>) -> AppResult<()> {
    const NOTE_PREFIX: &str = "\n\n【旧的关系记录】";
    const CONTENT_LIMIT: usize = 5000;

    // 先把待搬迁的行全部读出来，再逐行写回 —— 不能在遍历结果集的同时
    // 对同一张表执行 UPDATE，SQLite 会报「database table is locked」。
    let legacy: Vec<(i64, String, String)> = {
        let mut statement = tx.prepare(
            "SELECT id, content, json_extract(extra, '$.relationship') AS text
               FROM cards
              WHERE card_type = 'character'
                AND json_valid(extra)
                AND COALESCE(json_extract(extra, '$.relationship'), '') <> ''",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    for (id, content, text) in legacy {
        let text = text.trim();
        let content_len = content.chars().count();
        let prefix_len = NOTE_PREFIX.chars().count();

        // 正文已经写满的卡（5000 字上限）放不进这一段，只能放弃这段文本；
        // 键照删 —— 留着它只会让这张卡多一个界面上看不见、导出时却还在的字段
        let note = if text.is_empty() || content_len + prefix_len >= CONTENT_LIMIT {
            String::new()
        } else {
            let room = CONTENT_LIMIT - content_len - prefix_len;
            let taken: String = text.chars().take(room).collect();
            if taken.chars().count() < text.chars().count() {
                // 放不下就截断并加省略号，且省略号本身也要占位
                let trimmed: String = text.chars().take(room.saturating_sub(1)).collect();
                format!("{NOTE_PREFIX}{trimmed}…")
            } else {
                format!("{NOTE_PREFIX}{taken}")
            }
        };

        tx.execute(
            "UPDATE cards
                SET content = ?1,
                    extra = json_remove(extra, '$.relationship')
              WHERE id = ?2",
            rusqlite::params![format!("{content}{note}"), id],
        )?;
    }

    Ok(())
}
