import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Alert } from 'antd'

interface ChartBoundaryProps {
  children: ReactNode
  /** 出错时的替代内容说明，默认按图表处理 */
  label?: string
}

interface ChartBoundaryState {
  error: Error | null
}

/**
 * 图表错误边界。
 *
 * 图表库是本项目里唯一「渲染失败也不会影响核心功能」的依赖：
 * 数字本身由主进程算好、旁边的指标卡照常显示，只是少了一张曲线图。
 * 因此不能让它把整个页面带崩 —— 没有错误边界的话，图表里抛出的异常
 * 会一路冒泡到根节点，结果是首页整个变成白屏，用户会以为数据全丢了。
 *
 * 必须是类组件：React 的错误边界只有类组件能实现，这是框架层面的限制。
 */
export class ChartBoundary extends Component<ChartBoundaryProps, ChartBoundaryState> {
  override state: ChartBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ChartBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留一份完整信息，便于开发时定位；
    // 界面上只给一句人话，不把堆栈摆给用户看
    console.error('[winbook] 图表渲染失败：', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children

    return (
      <Alert
        type="warning"
        showIcon
        message={`${this.props.label ?? '图表'}渲染失败`}
        description="数据本身没有丢失，只是这张图暂时画不出来。其余统计数字仍然可用。"
      />
    )
  }
}
