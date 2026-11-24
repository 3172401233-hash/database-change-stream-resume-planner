# database-change-stream-resume-planner

规划变更流快照、断点恢复和事件去重。

## 背景

数据库变更流消费者通常先做一次快照，再从 resume token 处重放增量事件。
快照期间集合可能被删除重建（集合 UUID 改变），而旧 token 仍能重放部分旧事件，
消费者若不加甄别，会把旧集合化身的文档与新集合的文档按相同主键错误合并。
本模块把恢复过程建模为一个**纯函数规划器**：给定边界与事件输入，
计算可应用事件集合、快照读取顺序、事件过滤条件和无法恢复的窗口。

> **注意：本项目不连接真实数据库。** 所有输入（快照边界、resume token、
> 事件时间、集合 UUID、事务提交记录、删除重建历史、去重键）都以普通
> JavaScript 对象形式传入，输出仅为恢复计划，不执行任何实际写入。

## 使用

```js
import { planRecovery } from './src/planner.js';

const plan = planRecovery({
  snapshot: { id: 'snap-1', startedAt: 100, completedAt: 200 },
  resumeToken: { value: 'tok-1', eventTime: 200 },
  oplog: { earliestTime: 100, latestTime: 1000 },
  collections: [
    { uuid: 'uuid-users-2', name: 'users', state: 'current' },
    { uuid: 'uuid-users-1', name: 'users', state: 'dropped', droppedAt: 250, replacedBy: 'uuid-users-2' },
  ],
  events: [
    { collectionUUID: 'uuid-users-1', documentKey: 'u1', operationType: 'update', eventTime: 300 },
    { collectionUUID: 'uuid-users-2', documentKey: 'u1', operationType: 'insert', eventTime: 310 },
  ],
  appliedDedupKeys: [],
});
```

## 输出

- `snapshotReadOrder`：快照读取顺序。集合按名称排序，集合内按主键升序；
  `phases` 固定为 `['snapshot', 'catchup']`，即先完成快照再应用缓冲事件。
- `filterConditions`：事件过滤条件，包括最小事件时间（严格晚于 token）、
  当前/被排除的集合 UUID 列表、事务必须已提交、跳过已应用去重键。
- `applicableEvents`：可应用事件，按 `(事件时间, 事务提交时间, 事务号, 去重键)`
  确定性排序，乱序输入得到稳定输出。
- `skippedEvents`：被跳过的事件及原因（`at-or-before-resume-token`、
  `collection-rebuilt`、`unknown-collection`、`transaction-not-committed`、
  `already-applied`、`unrecoverable-window`）。
- `unrecoverableWindow`：无法恢复的窗口。token 已失效（`token-invalidated`）
  或 token 时间早于事件日志最早可重放点（`token-expired`）时非空，
  此时 `requiresResnapshot` 为 `true`，必须重新做全量快照。

## 一致性规则

- 去重键缺省时由 `collectionUUID#documentKey` 派生：同一主键在不同集合
  UUID 下是不同的键，旧集合化身的事件永远不会与新文档合并。
- 中断前已提交的去重键（`appliedDedupKeys`）在恢复后不会重复应用。
- 未提交事务的事件整体丢弃；已提交事务按提交时间参与排序。

## 测试

```sh
node --test
```

测试覆盖 token 过期、token 失效、事务事件、集合删除重建、事件乱序、
断点去重和快照读取顺序。要求 Node.js >= 24.16.0。
