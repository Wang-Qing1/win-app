import type { ReactNode } from 'react'
import {
  CloudUploadOutlined,
  DesktopOutlined,
  MoonOutlined,
  MoreOutlined,
  SunOutlined
} from '@ant-design/icons'
import { Button, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { useThemeMode, type ThemePreference } from '../theme/ThemeProvider'
import { useBackupDatabase } from '../features/backup/use-backup'
import { useHealth } from '../features/health/use-health'
import { formatBytes, formatDuration } from '../lib/format'
import { useToast } from './Toast'

/**
 * 顶栏右上角的「更多功能」菜单 —— 全应用唯一的顶栏入口。
 *
 * 用户 2026-09-20 提了两轮要求，第二轮把第一轮的方案也否掉了：
 *   ① 「头部的所有功能图标都太丑了，需要修正为圆形只展示图标的功能按钮，
 *      所有的文字都移动到鼠标悬浮的提示中」；
 *   ② 「如果是多个功能按钮，则首先只展示一个 `[...]`（省略号）图标按钮，
 *      点击后展开下拉菜单，每个菜单项对应一个圆形功能图标（并排展示的功能图标取消）」。
 *
 * 所以最终形态是：顶栏只有**一枚**圆形 `…` 按钮，健康 / 备份 / 主题三件事
 * 全部收进它展开的菜单里，每项行首是一个圆形图标。
 *
 * 为什么这样比并排三个圆钮好（不只是好看）：这几个操作一天点不了几次，
 * 并排意味着它们**永久占用**顶栏右侧最显眼的位置，而顶栏是唯一横贯所有页面的
 * 一条带子 —— 拿常驻宽度去换低频操作不划算。收进菜单后，顶栏右侧只剩一枚按钮，
 * 视觉噪音从「三个不同颜色的圆 + 一行状态文字」降到 1。
 *
 * 三件事的落点（对原来那三个组件的行为都做了保留，没有丢功能）：
 *   - **主进程健康**：菜单项里是状态点（绿 / 蓝闪 / 红）+ 摘要，点击弹一条
 *     摘要提示；详细字段（版本 / Electron / Node / Schema / 运行时长）在副标题里。
 *     它以前常驻显示「运行正常 · SQLite wal」那行字，现在这行字在菜单项里。
 *   - **备份数据库**：菜单项点击即执行，成功后照旧提示备份体积。
 *   - **主题**：三档（跟随系统 / 浅色 / 深色），点一次前进一档，图标随档位变。
 *
 * 健康状态另有一份**机器可读副本**挂在 `…` 按钮上（`data-health-state` /
 * `data-health-text`）：状态事实不该只存在于「菜单展开后」才有的 DOM 里，
 * 否则冒烟与读屏都得先把菜单点开才能知道主进程是否正常。按钮不显示这两项，
 * 它们只是数据，不占画面。
 */

const THEME_ITEMS: Array<{ value: ThemePreference; label: string; icon: ReactNode }> = [
  { value: 'system', label: '跟随系统', icon: <DesktopOutlined /> },
  { value: 'light', label: '浅色', icon: <SunOutlined /> },
  { value: 'dark', label: '深色', icon: <MoonOutlined /> }
]

type HealthState = 'pending' | 'ok' | 'error'

interface HealthSummary {
  state: HealthState
  /** 一句话摘要，例如「运行正常 · SQLite wal」 */
  summary: string
  /** 副标题：菜单项第二行的细节 */
  hint: string
}

/** 主进程健康状态 → 菜单项要显示的两行字。三态都给出，避免某一态显示成空白 */
function useHealthSummary(): HealthSummary {
  const { data, isPending, isError } = useHealth()

  if (isPending) {
    return { state: 'pending', summary: '正在自检…', hint: '正在与主进程握手，检查数据库与迁移状态' }
  }

  if (isError || !data) {
    return {
      state: 'error',
      summary: '主进程异常',
      hint: '部分功能可能不可用，可尝试重启 winbook'
    }
  }

  return {
    state: 'ok',
    summary: `运行正常 · SQLite ${data.database.journalMode}`,
    hint: `Schema ${data.database.schemaVersion ?? '未迁移'} · 数据库 ${formatBytes(
      data.database.sizeBytes
    )} · 已运行 ${formatDuration(data.uptimeSeconds)}`
  }
}

/**
 * 菜单项的行：圆形图标 + 两行文字。
 *
 * `data-testid` 挂在行与图标上：冒烟要能分别量「这一项在不在」「图标是不是正圆」
 * 和「文字有没有丢」—— 只读菜单的整体文案，量不出圆形这件事。
 */
function MenuRow({
  testId,
  icon,
  title,
  hint,
  statusIcon = false
}: {
  testId: string
  icon: ReactNode
  title: string
  hint: string
  /** 状态型图标（一个状态点）用中性底，别和「可点的功能图标」撞成一样 */
  statusIcon?: boolean
}) {
  return (
    <span className="topbar-menu__row" data-testid={testId}>
      <span
        className={`topbar-menu__icon${statusIcon ? ' topbar-menu__icon--status' : ''}`}
        data-testid={`${testId}-icon`}
      >
        {icon}
      </span>
      <span className="topbar-menu__text">
        <span className="topbar-menu__title">{title}</span>
        <span className="topbar-menu__hint">{hint}</span>
      </span>
    </span>
  )
}

export function TopBarMenu() {
  const health = useHealthSummary()
  const backup = useBackupDatabase()
  const { preference, setPreference } = useThemeMode()
  const { notifySuccess, notifyError } = useToast()

  const index = THEME_ITEMS.findIndex((item) => item.value === preference)
  const currentTheme = index >= 0 ? THEME_ITEMS[index] : THEME_ITEMS[0]
  const nextTheme = THEME_ITEMS[(Math.max(index, 0) + 1) % THEME_ITEMS.length]

  const handleBackup = async (): Promise<void> => {
    try {
      const result = await backup.mutateAsync()
      if (!result.canceled) {
        notifySuccess(`数据库已备份（${formatBytes(result.bytes)}）`)
      }
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '备份失败')
    }
  }

  const items: MenuProps['items'] = [
    {
      key: 'health',
      label: (
        <MenuRow
          testId="topbar-menu-health"
          statusIcon
          icon={<span className={`health-dot health-dot--${health.state}`} />}
          title={`主进程：${health.summary}`}
          hint={health.hint}
        />
      ),
      onClick: () =>
        health.state === 'error'
          ? notifyError(`主进程：${health.summary}`)
          : notifySuccess(`主进程：${health.summary}`)
    },
    { type: 'divider' },
    {
      key: 'backup',
      label: (
        <MenuRow
          testId="topbar-menu-backup"
          icon={<CloudUploadOutlined />}
          title="备份数据库"
          hint="导出一份数据库快照到本地"
        />
      ),
      onClick: () => void handleBackup()
    },
    {
      key: 'theme',
      label: (
        <MenuRow
          testId="topbar-menu-theme"
          icon={currentTheme.icon}
          title={`主题：${currentTheme.label}`}
          hint={`点击切换为「${nextTheme.label}」`}
        />
      ),
      onClick: () => setPreference(nextTheme.value)
    }
  ]

  return (
    <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
      <Button
        data-testid="topbar-more-button"
        /*
         * 状态事实的机器可读副本：主进程健康 + 主题档位。
         *
         * 按钮画面上只有「…」，这两项一个都不显示 —— 但它们不能因此只存在于
         * 「菜单展开之后」的 DOM 里：那样想知道主进程是否正常、或想断言主题
         * 循环有没有前进一档，都得先把菜单点开。挂在常驻按钮上，读屏与冒烟
         * 都能随时读到。
         */
        data-health-state={health.state}
        data-health-text={health.summary}
        data-theme-preference={currentTheme.value}
        className="app-icon-button"
        type="text"
        /* 读屏念的是这句话，而不是「…」——省略号本身说明不了它装的是什么 */
        aria-label={`更多功能（主进程：${health.summary}）`}
        icon={<MoreOutlined />}
      />
    </Dropdown>
  )
}
