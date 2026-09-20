import type { Db } from '../types'

export interface Migration {
  /** 唯一名称，落库后用于判断是否已执行。一旦发布不可修改 */
  readonly name: string
  readonly up: (db: Db) => void
}

/**
 * 迁移列表 —— 只允许在末尾追加，已发布的条目禁止改动。
 * 每条迁移在独立事务中执行，失败即整条回滚，不会留下半成品 schema。
 *
 * 关于 CHECK 约束的一条约定（重要）：
 *   只对**结构性不变式**加 CHECK（非空、非负、取值范围），
 *   不对**枚举值域**加 CHECK。
 *   原因：SQLite 无法 ALTER 一个已有的 CHECK，改枚举值域必须走重建表流程；
 *   而这些枚举（书本状态、卡片类型、大纲节点类型）恰恰是最容易随需求扩张的部分。
 *   枚举值域由 src/shared 的 Zod schema 在 IPC 边界强制，两侧同一份定义。
 */
export const migrations: readonly Migration[] = [
  {
    name: '001_init_contacts',
    up(db) {
      db.exec(`
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
      `)
    }
  },
  {
    name: '002_novel_schema',
    up(db) {
      db.exec(`
        /* ---------------------------------------------------------------- *
         * books —— 书籍
         * target_words 是用户自设的写作目标，用于进度条；0 表示不设目标。
         * accent_color 给书籍卡片/封面用，让书架有辨识度而不需要真的传图。
         * ---------------------------------------------------------------- */
        CREATE TABLE books (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          title        TEXT    NOT NULL,
          pen_name     TEXT    NOT NULL DEFAULT '',
          genre        TEXT    NOT NULL DEFAULT '',
          status       TEXT    NOT NULL DEFAULT 'idea',
          summary      TEXT    NOT NULL DEFAULT '',
          target_words INTEGER NOT NULL DEFAULT 0,
          accent_color TEXT    NOT NULL DEFAULT '#0f6cbd',
          created_at   TEXT    NOT NULL,
          updated_at   TEXT    NOT NULL,
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
         * 不变式「改正文必须同步改这三个字段」由 service 层的事务保证。
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
         * chapter_id 让一个构想节点可以「落地」成真实章节并保持双向关联，
         * 章节写完后节点状态可自动回标 —— 这是大纲与章节联动的关键。
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
         * 三类卡片共用一张表：它们的共性（标题、一句话简介、正文、标签、
         * 归属书籍）是大部分，差异（人物有身份/关系，物品有品阶/来源）
         * 放进 extra 这个 JSON 列，由共享层的 Zod discriminated union 约束形状。
         * 好处是三套 CRUD 只写一遍，将来加「地点」「势力」卡不用改表结构。
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
         * 既成事实，不该因为今天的结构调整被抹掉。所以每次写作单独落一条记录。
         *
         * 三个字数是怎么用的（这是「仅统计汉字」口径下的必要设计）：
         *   校对会删字，净变化可能为负。若直接用它算「今日写了多少」，
         *   精修一天稿子会显示成负数，显然不对。因此：
         *     写作量 = peak_words - start_words   → 首页今日数字、趋势图
         *     净  增 = end_words  - start_words   → 书籍进度条、目标完成度
         *
         * book_id / chapter_id 用 ON DELETE SET NULL：删书删章后会话记录保留，
         * 全局写作量统计不受影响，只是失去了按书归集的能力。
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
      `)
    }
  },
  {
    name: '003_drop_contacts',
    up(db) {
      // contacts 是脚手架阶段的示例模块，小说助手不需要它。
      // 单独一条迁移而不是回改 001：已发布的迁移改动后，老用户的库不会重新执行，
      // 只有新增迁移才能保证「新装」与「升级」两条路径得到同一个 schema。
      // 表上的索引随表一起删除，无需单独 DROP INDEX。
      db.exec('DROP TABLE IF EXISTS contacts;')
    }
  },
  {
    name: '004_chapter_target_words',
    up(db) {
      // 章节级的目标字数，用于编辑器底部「计划：剩 N」。
      // books.target_words 是整本书的目标，而作者在写单章时关心的是
      // 「这一章还差多少」——两者的时间尺度差了两个数量级，
      // 用一个字段同时表达只能得到两个都不好用的结果。
      //
      // 默认 0 表示未设目标；ALTER TABLE ADD COLUMN 带非空默认值是
      // SQLite 支持的常量默认场景，老数据自动填 0，不需要回填脚本。
      db.exec('ALTER TABLE chapters ADD COLUMN target_words INTEGER NOT NULL DEFAULT 0;')
    }
  },
  {
    name: '005_book_chapter_words',
    up(db) {
      // 「每章最少字数」从章节级上提到书籍级。
      //
      // 004 给章节加了 target_words，编辑器的「本章目标」让作者逐章去填。
      // 实际使用下来这是纯粹的重复劳动：「每章至少 2000 字」本来就是一本书
      // 定一次、全书生效的规则，逐章再填一遍既没人愿意做，填出来的值也必然
      // 互相打架（同一本书里有的章 2000、有的章 0 未设）。所以把它上提到
      // books，编辑器那一整行输入也随之删掉。
      //
      // chapters.target_words 保留不动：它已经落在用户的库里，删列要重建表；
      // 而它现在只是「建章那一刻书级设置的快照」，仍被导出与统计读到。
      db.exec(`
        ALTER TABLE books ADD COLUMN chapter_words INTEGER NOT NULL DEFAULT 2000;
      `)

      // 回填：老库里作者认真填过的章节目标字数是他真实意图，直接丢掉会让人
      // 升级后发现「每章最少字数」全变回 2000。取每本书下章节目标字数的最大值 ——
      // 一本书里作者手动填过的那些章代表他的标准，没填的 0 是「懒得填」而非「要 0」。
      db.exec(`
        UPDATE books
           SET chapter_words = (
                 SELECT MAX(target_words) FROM chapters WHERE chapters.book_id = books.id
               )
         WHERE (SELECT MAX(target_words) FROM chapters WHERE chapters.book_id = books.id) > 0;
      `)
    }
  }
]
