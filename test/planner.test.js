import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRecovery } from '../src/planner.js';

const baseInput = () => ({
  snapshot: { id: 'snap-1', startedAt: 100, completedAt: 200 },
  resumeToken: { value: 'tok-1', eventTime: 200 },
  oplog: { earliestTime: 100, latestTime: 1000 },
  collections: [
    { uuid: 'uuid-users-1', name: 'users', state: 'current' },
    { uuid: 'uuid-orders-1', name: 'orders', state: 'current' },
  ],
  events: [],
  appliedDedupKeys: [],
});

test('token 过期：产生无法恢复窗口，要求重新快照，事件全部跳过', () => {
  const input = baseInput();
  input.resumeToken = { value: 'tok-old', eventTime: 50 }; // 早于 oplog.earliestTime
  input.events = [
    { collectionUUID: 'uuid-users-1', documentKey: 'u1', operationType: 'insert', eventTime: 300 },
  ];

  const plan = planRecovery(input);

  assert.equal(plan.requiresResnapshot, true);
  assert.deepEqual(plan.unrecoverableWindow, {
    from: 50,
    to: 100,
    reason: 'token-expired',
  });
  assert.equal(plan.applicableEvents.length, 0);
  assert.equal(plan.skippedEvents[0].reason, 'unrecoverable-window');
});

test('token 失效（invalidate）：整个窗口无法恢复', () => {
  const input = baseInput();
  input.resumeToken = { value: 'tok-inv', eventTime: 200, invalidated: true };

  const plan = planRecovery(input);

  assert.equal(plan.requiresResnapshot, true);
  assert.equal(plan.unrecoverableWindow.reason, 'token-invalidated');
  assert.equal(plan.unrecoverableWindow.to, 1000);
});

test('事务事件：未提交事务整体丢弃，已提交事务按提交顺序应用', () => {
  const input = baseInput();
  input.events = [
    {
      collectionUUID: 'uuid-users-1', documentKey: 'u1', operationType: 'update', eventTime: 300,
      txn: { id: 'txn-a', number: 1, committed: true, commitTime: 350 },
    },
    {
      collectionUUID: 'uuid-users-1', documentKey: 'u2', operationType: 'update', eventTime: 310,
      txn: { id: 'txn-b', number: 2, committed: false },
    },
    {
      collectionUUID: 'uuid-users-1', documentKey: 'u3', operationType: 'update', eventTime: 320,
      txn: { id: 'txn-a', number: 1, committed: true, commitTime: 350 },
    },
  ];

  const plan = planRecovery(input);
  const keys = plan.applicableEvents.map((e) => e.documentKey);

  assert.deepEqual(keys, ['u1', 'u3']);
  const dropped = plan.skippedEvents.find((s) => s.dedupKey === 'uuid-users-1#u2');
  assert.equal(dropped.reason, 'transaction-not-committed');
});

test('集合删除重建：旧 UUID 事件被丢弃，同主键不同 UUID 不混淆', () => {
  const input = baseInput();
  input.collections = [
    { uuid: 'uuid-users-2', name: 'users', state: 'current' },
    { uuid: 'uuid-users-1', name: 'users', state: 'dropped', droppedAt: 250, replacedBy: 'uuid-users-2' },
  ];
  input.events = [
    // 旧集合化身的重放事件：同一主键 u1，必须丢弃，不能与新文档合并
    { collectionUUID: 'uuid-users-1', documentKey: 'u1', operationType: 'update', eventTime: 300 },
    // 新集合化身的合法事件
    { collectionUUID: 'uuid-users-2', documentKey: 'u1', operationType: 'insert', eventTime: 310 },
  ];

  const plan = planRecovery(input);

  assert.equal(plan.applicableEvents.length, 1);
  assert.equal(plan.applicableEvents[0].collectionUUID, 'uuid-users-2');
  assert.equal(plan.applicableEvents[0].dedupKey, 'uuid-users-2#u1');
  const stale = plan.skippedEvents.find((s) => s.dedupKey === 'uuid-users-1#u1');
  assert.equal(stale.reason, 'collection-rebuilt');
  assert.deepEqual(plan.filterConditions.excludedCollectionUUIDs, ['uuid-users-1']);
  assert.deepEqual(plan.filterConditions.currentCollectionUUIDs, ['uuid-users-2']);
});

test('事件乱序：输出按事件时间确定性排序', () => {
  const input = baseInput();
  input.events = [
    { collectionUUID: 'uuid-users-1', documentKey: 'u3', operationType: 'update', eventTime: 500 },
    { collectionUUID: 'uuid-users-1', documentKey: 'u1', operationType: 'insert', eventTime: 300 },
    { collectionUUID: 'uuid-users-1', documentKey: 'u2', operationType: 'update', eventTime: 400 },
  ];

  const plan = planRecovery(input);

  assert.deepEqual(plan.applicableEvents.map((e) => e.documentKey), ['u1', 'u2', 'u3']);
});

test('中断后恢复：已提交的去重键不重复应用，token 之前的事件被跳过', () => {
  const input = baseInput();
  input.appliedDedupKeys = ['uuid-users-1#u1'];
  input.events = [
    { collectionUUID: 'uuid-users-1', documentKey: 'u0', operationType: 'insert', eventTime: 150 }, // token 之前
    { collectionUUID: 'uuid-users-1', documentKey: 'u1', operationType: 'update', eventTime: 300 }, // 已应用
    { collectionUUID: 'uuid-users-1', documentKey: 'u2', operationType: 'update', eventTime: 400 },
  ];

  const plan = planRecovery(input);

  assert.deepEqual(plan.applicableEvents.map((e) => e.documentKey), ['u2']);
  const reasons = Object.fromEntries(plan.skippedEvents.map((s) => [s.dedupKey, s.reason]));
  assert.equal(reasons['uuid-users-1#u0'], 'at-or-before-resume-token');
  assert.equal(reasons['uuid-users-1#u1'], 'already-applied');
});

test('快照读取顺序：集合按名称排序，集合内主键升序，先快照后追事件', () => {
  const input = baseInput();
  input.collections = [
    { uuid: 'uuid-users-1', name: 'users', state: 'current' },
    { uuid: 'uuid-orders-1', name: 'orders', state: 'current' },
    { uuid: 'uuid-logs-0', name: 'logs', state: 'dropped', droppedAt: 150 },
  ];

  const plan = planRecovery(input);

  assert.deepEqual(plan.phases, ['snapshot', 'catchup']);
  assert.deepEqual(plan.snapshotReadOrder, [
    { collection: 'orders', documentOrder: 'documentKey:asc' },
    { collection: 'users', documentOrder: 'documentKey:asc' },
  ]);
});
