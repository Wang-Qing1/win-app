/**
 * 中文人名生成器。
 *
 * 完全本地、不依赖任何模型或网络。它的定位是「给个起点」而不是「替你想」：
 * 卡在人名上时，扫一眼十几个候选，往往一眼就能挑中一个顺眼的，
 * 或者被某个字触发灵感改成别的。
 *
 * 因此刻意做了两件事：
 *   1. 按风格与性别分池，而不是把字一股脑混在一起 —— 「古风男名」和
 *      「现代女名」的用字差别极大，混池生成出来的东西四不像；
 *   2. 保证同批内不重名，避免出现「陈思远、陈思远、陈思远」这种结果。
 */

export const NAME_STYLES = ['modern', 'ancient'] as const
export type NameStyle = (typeof NAME_STYLES)[number]

export const NAME_STYLE_LABELS: Record<NameStyle, string> = {
  modern: '现代',
  ancient: '古风'
}

export const NAME_GENDERS = ['male', 'female', 'neutral'] as const
export type NameGender = (typeof NAME_GENDERS)[number]

export const NAME_GENDER_LABELS: Record<NameGender, string> = {
  male: '男',
  female: '女',
  neutral: '中性'
}

/** 常见姓氏。不追求覆盖百家姓全表，够用且不至于生成生僻到出戏的姓 */
const SURNAMES = [
  '赵', '钱', '孙', '李', '周', '吴', '郑', '王', '冯', '陈',
  '褚', '卫', '蒋', '沈', '韩', '杨', '朱', '秦', '许', '何',
  '吕', '施', '张', '孔', '曹', '严', '华', '金', '魏', '陶',
  '姜', '戚', '谢', '邹', '喻', '柏', '窦', '章', '云', '苏',
  '潘', '葛', '奚', '范', '彭', '郎', '鲁', '韦', '昌', '马',
  '苗', '花', '方', '俞', '任', '袁', '柳', '鲍', '史', '唐',
  '费', '廉', '岑', '薛', '雷', '贺', '倪', '汤', '滕', '殷',
  '罗', '毕', '郝', '邬', '安', '常', '乐', '于', '傅', '齐',
  '康', '伍', '余', '元', '卜', '顾', '孟', '平', '黄', '穆',
  '萧', '尹', '姚', '邵', '湛', '汪', '祁', '毛', '禹', '狄',
  '米', '贝', '明', '臧', '计', '伏', '成', '戴', '宋', '茅',
  '庞', '熊', '纪', '舒', '屈', '项', '祝', '董', '梁', '杜',
  '阮', '蓝', '闵', '席', '季', '麻', '强', '贾', '路', '娄',
  '危', '江', '童', '颜', '郭', '梅', '盛', '林', '刁', '钟',
  '徐', '邱', '骆', '高', '夏', '蔡', '田', '樊', '胡', '凌',
  '霍', '虞', '万', '支', '柯', '管', '卢', '莫', '房', '裘',
  '缪', '干', '解', '应', '宗', '丁', '宣', '邓', '郁', '单',
  '杭', '洪', '包', '诸', '左', '石', '崔', '吉', '钮', '龚',
  '程', '嵇', '邢', '滑', '裴', '陆', '荣', '翁', '荀', '羊',
  '甄', '曲', '封', '芮', '羿', '储', '靳', '汲', '邴', '糜'
] as const

/** 单字名用字。按「风格 × 性别」分开成池，避免生成四不像的名字 */
const GIVEN_CHARS: Record<NameStyle, Record<NameGender, readonly string[]>> = {
  modern: {
    male: [
      '伟', '强', '磊', '军', '洋', '勇', '杰', '涛', '明', '超',
      '鹏', '宇', '浩', '晨', '睿', '轩', '泽', '航', '阳', '峰',
      '博', '然', '毅', '楠', '恒', '铭', '嘉', '辰', '奕', '越',
      '谦', '野', '岩', '澈', '钧', '琛', '冽', '尧', '洛', '屹'
    ],
    female: [
      '静', '敏', '丽', '艳', '娜', '芳', '燕', '霞', '婷', '雯',
      '娅', '琳', '薇', '岚', '茹', '珂', '汐', '苓', '婉', '蕾',
      '彤', '瑶', '萱', '曦', '漫', '柠', '晚', '念', '禾', '冉',
      '泠', '菡', '荞', '旖', '黛', '婳', '琬', '妤', '瑾', '菀'
    ],
    neutral: [
      '宁', '安', '亦', '柏', '洲', '砚', '白', '青', '岚', '水',
      '云', '川', '临', '简', '和', '乐', '知', '言', '少', '千',
      '程', '沐', '呈', '岑', '序', '行', '粲', '屿', '归', '杳',
      '斯', '栖', '桓', '萧', '珉', '昭', '榆', '湛', '徵', '荻'
    ]
  },
  ancient: {
    male: [
      '玄', '琰', '璟', '珩', '曜', '澈', '邈', '瑾', '玦', '翼',
      '闵', '烈', '烁', '虞', '祁', '罡', '徵', '铮', '戎', '牧',
      '阙', '钧', '晏', '聿', '彦', '韶', '澹', '玚', '翊', '骞',
      '瞻', '恪', '琮', '玢', '啸', '峻', '岐', '崧', '庾', '彧'
    ],
    female: [
      '婉', '姝', '妘', '妗', '婳', '嫤', '嬅', '蘅', '菱', '蔻',
      '菀', '蕖', '薇', '苒', '苓', '荑', '瑶', '珞', '璎', '琬',
      '珩', '瑛', '珺', '璆', '玥', '妤', '妁', '姒', '妍', '娆',
      '婥', '嫣', '缈', '纭', '绾', '缃', '霁', '霈', '霭', '曛'
    ],
    neutral: [
      '清', '澹', '岚', '珩', '玦', '翕', '衾', '衿', '筠', '笙',
      '徵', '晏', '旸', '晟', '暻', '杳', '棹', '楫', '楹', '殊',
      '泠', '汜', '洄', '凛', '冽', '濯', '澈', '孺', '疏', '砚',
      '祁', '望', '霁', '霄', '序', '临', '岑', '岳', '淮', '珩'
    ]
  }
}

/** 双字名第二字。与首字池分开，是为了避免出现「磊磊」这类叠字组合 */
const SECOND_CHARS: Record<NameStyle, readonly string[]> = {
  modern: [
    '宁', '安', '宸', '熙', '珩', '越', '言', '舟', '辰', '洲',
    '尔', '曦', '禾', '砚', '嘉', '屹', '然', '帆', '谦', '沐',
    '晚', '澈', '白', '瑜', '玲', '禾', '若', '洋', '楷', '晟'
  ],
  ancient: [
    '之', '清', '衍', '汐', '言', '瑶', '辞', '阙', '晏', '煦',
    '昀', '檀', '珩', '岚', '霄', '霜', '翎', '冽', '岑', '徽',
    '璟', '攸', '鸢', '蘅', '筝', '淮', '濡', '琤', '璎', '韶'
  ]
}

export interface NameSuggestion {
  full: string
  surname: string
  given: string
}

export interface GenerateNamesOptions {
  style: NameStyle
  gender: NameGender
  /** 名字字数：1 或 2 */
  length: 1 | 2
  count: number
}

export function generateNames(options: GenerateNamesOptions): NameSuggestion[] {
  const { style, gender, length, count } = options
  const firstPool = GIVEN_CHARS[style][gender]
  const secondPool = SECOND_CHARS[style]

  const seen = new Set<string>()
  const result: NameSuggestion[] = []
  // 生成上限：池子小的时候（比如单字名可选字只有几十个），
  // 不设上限会在凑不满 count 时无限循环
  const maxAttempts = count * 40

  for (let attempt = 0; attempt < maxAttempts && result.length < count; attempt += 1) {
    const surname = pick(SURNAMES)
    const first = pick(firstPool)
    const given = length === 1 ? first : first + pick(secondPool)
    const full = surname + given

    if (seen.has(full)) continue
    // 名字的字不能和姓相同，否则「陈陈」「林林」这种读起来很怪
    if (given.startsWith(surname)) continue
    // 双字名两个字相同即为叠字，除非本来就想要「芊芊」这类效果，这里排除掉
    if (length === 2 && given.length === 2 && given[0] === given[1]) continue

    seen.add(full)
    result.push({ full, surname, given })
  }

  return result
}

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]
}

/* ------------------------------------------------------------------ *
 * 主角名定型器（可选的第二步）
 *
 * 只做一件小事：把选中的名字记录到 localStorage，供下次生成时跳过。
 * 目的是「同一本书里不要出现两个陈思远」——这是作者最容易犯、
 * 又最难自己发现的重名错误。
 * ------------------------------------------------------------------ */

const TAKEN_KEY = 'winbook.editor.takenNames'

export function readTakenNames(): string[] {
  try {
    const raw = window.localStorage.getItem(TAKEN_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function rememberTakenName(name: string): void {
  try {
    const taken = readTakenNames()
    if (taken.includes(name)) return
    // 只留最近 200 个，避免这个列表无限增长
    window.localStorage.setItem(TAKEN_KEY, JSON.stringify([...taken, name].slice(-200)))
  } catch {
    /* 存不进去只影响提示效果 */
  }
}
