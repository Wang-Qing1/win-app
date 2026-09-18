import Database from 'better-sqlite3'

/**
 * better-sqlite3 的类型出口。
 * 用 InstanceType 推导实例类型，避免依赖 @types/better-sqlite3
 * 里 const 与 namespace 合并写法的解析差异。
 */
export type Db = InstanceType<typeof Database>
export type DbStatement = ReturnType<Db['prepare']>
