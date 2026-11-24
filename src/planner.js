// 变更流恢复规划器：根据快照边界、resume token、事件流和集合历史，
// 计算可应用事件集合、快照读取顺序、过滤条件与无法恢复的窗口。
// 纯函数实现，不连接真实数据库。

/**
 * @typedef {Object} ChangeEvent
 * @property {string} [dedupKey]      去重键；缺省时由 collectionUUID + documentKey 派生
 * @property {string} collectionUUID  事件所属集合的 UUID（集合重建后 UUID 会变化）
 * @property {string} documentKey     主键
 * @property {string} operationType   insert/update/replace/delete/...
 * @property {number} eventTime       事件时间（逻辑时间，毫秒或任意单调刻度）
 * @property {{ id: string, number: number, committed: boolean, commitTime?: number }} [txn]
 */

/**
 * @param {Object} input
 * @param {{ id: string, startedAt: number, completedAt: number }} input.snapshot 快照边界
 * @param {{ value: string, eventTime: number, collectionUUID?: string, invalidated?: boolean }} input.resumeToken
 * @param {{ earliestTime: number, latestTime: number }} input.oplog 可重放的事件日志窗口
 * @param {Array<{ uuid: string, name: string, state: 'current'|'dropped', droppedAt?: number, replacedBy?: string }>} input.collections
 * @param {ChangeEvent[]} input.events 候选事件（允许乱序）
 * @param {string[]} [input.appliedDedupKeys] 中断前已提交应用的去重键
 */
export function planRecovery(input) {
  const {
    snapshot,
    resumeToken,
    oplog,
    collections,
    events,
    appliedDedupKeys = [],
  } = input;

  const currentUUIDs = new Set(
    collections.filter((c) => c.state === 'current').map((c) => c.uuid),
  );
  const droppedUUIDs = new Set(
    collections.filter((c) => c.state === 'dropped').map((c) => c.uuid),
  );
  const applied = new Set(appliedDedupKeys);

  // ---- 无法恢复的窗口 -------------------------------------------------
  // token 已失效，或 token 指向的时间早于事件日志最早可重放点：
  // [token.eventTime, oplog.earliestTime) 之间的事件永久丢失，必须重新快照。
  let unrecoverableWindow = null;
  if (resumeToken.invalidated) {
    unrecoverableWindow = {
      from: resumeToken.eventTime,
      to: oplog.latestTime,
      reason: 'token-invalidated',
    };
  } else if (resumeToken.eventTime < oplog.earliestTime) {
    unrecoverableWindow = {
      from: resumeToken.eventTime,
      to: oplog.earliestTime,
      reason: 'token-expired',
    };
  }

  // ---- 快照读取顺序 ---------------------------------------------------
  // 先完成快照再应用缓冲事件；集合按名称排序，集合内按主键升序，
  // 保证中断后重跑快照的顺序确定、可比对。
  const snapshotReadOrder = collections
    .filter((c) => c.state === 'current')
    .map((c) => c.name)
    .sort()
    .map((name) => ({ collection: name, documentOrder: 'documentKey:asc' }));

  // ---- 事件过滤 -------------------------------------------------------
  const filterConditions = {
    minEventTime: resumeToken.eventTime, // 只接受严格晚于 token 的事件
    currentCollectionUUIDs: [...currentUUIDs].sort(),
    excludedCollectionUUIDs: [...droppedUUIDs].sort(),
    requireCommittedTransaction: true,
    skipAppliedDedupKeys: true,
  };

  const skipped = [];
  const applicable = [];

  if (!unrecoverableWindow) {
    // 事务分组：未提交的事务整体丢弃；已提交的按提交时间参与排序。
    const txnById = new Map();
    for (const event of events) {
      if (event.txn) {
        if (!txnById.has(event.txn.id)) txnById.set(event.txn.id, []);
        txnById.get(event.txn.id).push(event);
      }
    }
    const committedTxn = new Map();
    for (const [txnId, members] of txnById) {
      const head = members[0].txn;
      if (head.committed && typeof head.commitTime === 'number') {
        committedTxn.set(txnId, head.commitTime);
      }
    }

    for (const event of events) {
      const dedupKey = event.dedupKey ?? `${event.collectionUUID}#${event.documentKey}`;
      let reason = null;

      if (event.eventTime <= resumeToken.eventTime) {
        reason = 'at-or-before-resume-token';
      } else if (droppedUUIDs.has(event.collectionUUID)) {
        // 集合已删除重建：旧 UUID 的事件属于旧化身，丢弃，
        // 避免与新集合中相同主键的文档合并。
        reason = 'collection-rebuilt';
      } else if (!currentUUIDs.has(event.collectionUUID)) {
        reason = 'unknown-collection';
      } else if (event.txn && !committedTxn.has(event.txn.id)) {
        reason = 'transaction-not-committed';
      } else if (applied.has(dedupKey)) {
        // 中断前已提交的事件，恢复后不得重复应用。
        reason = 'already-applied';
      }

      if (reason) {
        skipped.push({ dedupKey, reason });
      } else {
        applicable.push({ ...event, dedupKey });
      }
    }
  } else {
    for (const event of events) {
      const dedupKey = event.dedupKey ?? `${event.collectionUUID}#${event.documentKey}`;
      skipped.push({ dedupKey, reason: 'unrecoverable-window' });
    }
  }

  // ---- 应用顺序 -------------------------------------------------------
  // 乱序事件按 (事件时间, 事务提交时间, 事务号, 去重键) 确定性排序。
  const txnCommitTime = (event) =>
    event.txn ? event.txn.commitTime ?? Number.MAX_SAFE_INTEGER : 0;
  const txnNumber = (event) => (event.txn ? event.txn.number : 0);

  applicable.sort((a, b) =>
    a.eventTime - b.eventTime ||
    txnCommitTime(a) - txnCommitTime(b) ||
    txnNumber(a) - txnNumber(b) ||
    (a.dedupKey < b.dedupKey ? -1 : a.dedupKey > b.dedupKey ? 1 : 0),
  );

  return {
    requiresResnapshot: unrecoverableWindow !== null,
    unrecoverableWindow,
    snapshotReadOrder,
    phases: ['snapshot', 'catchup'],
    filterConditions,
    applicableEvents: applicable,
    skippedEvents: skipped,
  };
}
