import { Badge, Tooltip } from 'antd'
import { useHealth } from '../features/health/use-health'
import { formatBytes, formatDuration } from '../lib/format'

/**
 * 主进程与数据库的健康状态。
 *
 * data-state 是给冒烟测试用的稳定锚点：
 * 测试只认这个属性，不认 antd 的类名，所以以后换组件库或改样式
 * 都不会让测试变成「匹配不到元素却依然通过」的假阳性。
 */
export function HealthBadge() {
  const { data, isPending, isError } = useHealth()

  if (isPending) {
    return (
      <Tooltip title="正在与主进程握手，检查数据库与迁移状态">
        <span data-testid="health-badge" data-state="pending">
          <Badge status="processing" text="正在自检…" />
        </span>
      </Tooltip>
    )
  }

  if (isError || !data) {
    return (
      <Tooltip title="未能连接到主进程，部分功能可能不可用。可尝试重启 wapp。">
        <span data-testid="health-badge" data-state="error">
          <Badge status="error" text="主进程异常" />
        </span>
      </Tooltip>
    )
  }

  const details: Array<[string, string]> = [
    ['版本', data.runtime.appVersion],
    ['Electron', data.runtime.electronVersion],
    ['Node', data.runtime.nodeVersion],
    ['数据库', `${formatBytes(data.database.sizeBytes)} · ${data.database.journalMode}`],
    ['Schema', data.database.schemaVersion ?? '未迁移'],
    ['已运行', formatDuration(data.uptimeSeconds)]
  ]

  return (
    <Tooltip
      title={
        <div className="health-tooltip">
          {details.map(([label, value]) => (
            <div className="health-tooltip__row" key={label}>
              <span className="health-tooltip__label">{label}</span>
              <span>{value}</span>
            </div>
          ))}
        </div>
      }
    >
      <span data-testid="health-badge" data-state="ok" className="health-badge">
        <Badge status="success" text={`运行正常 · SQLite ${data.database.journalMode}`} />
      </span>
    </Tooltip>
  )
}
