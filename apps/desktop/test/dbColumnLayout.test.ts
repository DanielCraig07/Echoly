import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMN_WIDTH,
  INDEX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampColumnWidth,
  defaultColumnWidth,
  isOnlyOneColumnVisible,
  layoutColumns,
  pickVisibleColumns,
  resetColumnWidth,
  resizeFromDrag,
  sanitizeHidden,
  setAllColumnsHidden,
  setColumnHidden,
  setColumnWidth,
  commitColumnFrame,
  type ColumnLayoutPrefs,
} from '../src/renderer/src/services/dbColumnLayout';

const noMeta = () => undefined;

describe('dbColumnLayout · 列宽', () => {
  it('宽度夹进可用区间并取整', () => {
    expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(5000)).toBe(900);
    expect(clampColumnWidth(200.6)).toBe(201);
    expect(clampColumnWidth(Number.NaN)).toBe(DEFAULT_COLUMN_WIDTH);
  });

  it('按类型给初始宽度：短 CHAR 窄、TEXT/JSON 宽、时间列中等', () => {
    expect(defaultColumnWidth({ type: 'VARCHAR(8)' })).toBe(120);
    expect(defaultColumnWidth({ type: 'VARCHAR(255)' })).toBe(180);
    expect(defaultColumnWidth({ type: 'TEXT' })).toBe(260);
    expect(defaultColumnWidth({ type: 'JSONB' })).toBe(260);
    expect(defaultColumnWidth({ type: 'BIGINT' })).toBe(120);
    expect(defaultColumnWidth({ type: 'DATETIME' })).toBe(170);
    expect(defaultColumnWidth({ type: 'TINYINT(1) BOOL' })).toBe(120);
    expect(defaultColumnWidth(undefined)).toBe(DEFAULT_COLUMN_WIDTH);
  });

  it('拖过的宽度优先于类型推断', () => {
    const prefs = setColumnWidth({ widths: {}, hidden: [] }, 'name', 300);
    expect(prefs.widths.name).toBe(300);
  });

  it('拖动位移叠加在起点宽度上', () => {
    expect(resizeFromDrag(160, 40)).toBe(200);
    expect(resizeFromDrag(160, -400)).toBe(MIN_COLUMN_WIDTH);
  });

  it('恢复默认宽度就是删掉这条记录', () => {
    const prefs = setColumnWidth({ widths: {}, hidden: [] }, 'name', 300);
    const back = resetColumnWidth(prefs, 'name');
    expect('name' in back.widths).toBe(false);
    // 没记过宽度的列调用它应原样返回（避免制造无意义的新对象）
    expect(resetColumnWidth(back, 'other')).toBe(back);
  });

  it('拖完收尾：宽度与整表宽度一并落盘，下次布局原样重现（松手时表格不跳）', () => {
    const before = setColumnWidth({ widths: {}, hidden: [] }, 'id', 120);
    // 组件落盘的就是最后一帧：各列宽度 + 表格总宽（行号列 46）
    const frameWidths = { id: 400, name: 180 };
    const frameTableWidth = INDEX_COLUMN_WIDTH + 400 + 180;
    const after = commitColumnFrame(before, frameWidths, frameTableWidth);
    expect(after.widths).toEqual({ id: 400, name: 180 });
    expect(after.tableWidth).toBe(626);

    // 关键：松手后回到常规布局（没有 override），得到的结果必须与看了一路的拖动画面一致
    const relaid = layoutColumns(['id', 'name'], after, noMeta, 900, {
      column: 'id',
      width: 400,
      frozen: { id: 120, name: 180 },
    });
    const still = layoutColumns(['id', 'name'], after, noMeta, 900);
    expect(still).toEqual(relaid);
  });

  it('拖过之后就按用户定下的宽度渲染，不再被容器摊平顶宽', () => {
    const prefs = commitColumnFrame({ widths: {}, hidden: [] }, { id: 120, name: 180 }, 346);
    // 容器 900 宽也不铺满：用户拉出来的 120 就是 120
    const res = layoutColumns(['id', 'name'], prefs, noMeta, 900);
    expect(res.widths).toEqual({ id: 120, name: 180 });
    expect(res.tableWidth).toBe(346);
  });

  it('恢复默认列宽会一并丢掉整表宽度，回到铺满容器的默认表现', () => {
    const prefs = commitColumnFrame({ widths: {}, hidden: [] }, { id: 120, name: 180 }, 346);
    const back = resetColumnWidth(prefs, 'id');
    expect(back.tableWidth).toBeUndefined();
    expect(layoutColumns(['id', 'name'], back, noMeta, 900).tableWidth).toBe(900);
  });

  it('落盘时值全都没变就原样返回（避免无谓的重渲染）', () => {
    const prefs = commitColumnFrame({ widths: {}, hidden: [] }, { id: 120, name: 180 }, 346);
    expect(commitColumnFrame(prefs, { id: 120, name: 180 }, 346)).toBe(prefs);
    expect(commitColumnFrame(prefs, {}, 999) === prefs).toBe(false);
  });

  it('记宽度时值没变就原样返回（避免无谓的重渲染）', () => {
    const prefs = setColumnWidth({ widths: {}, hidden: [] }, 'id', 120);
    expect(setColumnWidth(prefs, 'id', 120)).toBe(prefs);
  });
});

describe('dbColumnLayout · 显示 / 隐藏字段', () => {
  const cols = ['id', 'name', 'created_at'];

  it('隐藏单列后该列不再渲染', () => {
    const prefs = setColumnHidden({ widths: {}, hidden: [] }, 'name', true);
    expect(pickVisibleColumns(cols, prefs.hidden)).toEqual(['id', 'created_at']);
    const back = setColumnHidden(prefs, 'name', false);
    expect(pickVisibleColumns(cols, back.hidden)).toEqual(cols);
  });

  it('表结构变了就丢掉不存在的列名（否则新列会一出生就是隐藏的）', () => {
    expect(sanitizeHidden(['gone', 'name'], cols)).toEqual(['name']);
  });

  it('全不选会留下一列：列全被藏着会让表格变成一片空白', () => {
    const prefs = setAllColumnsHidden({ widths: {}, hidden: [] }, cols, true);
    expect(prefs.hidden).toEqual(['name', 'created_at']);
    expect(pickVisibleColumns(cols, prefs.hidden)).toEqual(['id']);
  });

  it('全选清空隐藏列表', () => {
    const prefs = setAllColumnsHidden({ widths: {}, hidden: ['name'] }, cols, false);
    expect(prefs.hidden).toEqual([]);
  });

  it('数据里混进了不存在的列名时，依然能渲染出真正的列', () => {
    // 兜底：全都隐藏（含脏数据）时返回全部列，而不是空白
    expect(pickVisibleColumns(cols, ['ghost'])).toEqual(cols);
  });
});

describe('dbColumnLayout · 摊平到容器宽度', () => {
  const prefs: ColumnLayoutPrefs = { widths: { id: 120, name: 180 }, hidden: [] };

  it('列少时按比例把空白分给各列，表格铺满容器', () => {
    const res = layoutColumns(['id', 'name'], prefs, noMeta, 800);
    expect(res.tableWidth).toBe(800);
    // 空白 800 - 46 - 120 - 180 = 454，按 120:180 分
    expect(res.widths.id + res.widths.name).toBe(120 + 180 + 454);
    expect(res.widths.name).toBeGreaterThan(res.widths.id);
  });

  it('列宽之和超过容器时按原样撑开，产生横向滚动', () => {
    const res = layoutColumns(['id', 'name'], prefs, noMeta, 200);
    expect(res.tableWidth).toBe(INDEX_COLUMN_WIDTH + 120 + 180);
    expect(res.widths.name).toBe(180);
  });

  it('摊平是幂等的：反复布局不会把宽度越摊越宽', () => {
    // 分配基数取的是存下来的偏好而不是上一帧结果，所以两次结果必须完全一致
    const first = layoutColumns(['id', 'name'], prefs, noMeta, 800);
    const second = layoutColumns(['id', 'name'], prefs, noMeta, 800);
    expect(second.widths).toEqual(first.widths);
    expect(second.tableWidth).toBe(first.tableWidth);
  });

  it('拖动中只有被拖的那一列动：其余列冻结在按下那一刻的宽度', () => {
    // 按下时 id=120、name=180、created_at=170（DATETIME 的默认宽度）
    const frozen = { id: 120, name: 180, created_at: 170 };
    const res = layoutColumns(['id', 'name', 'created_at'], prefs, noMeta, 900, {
      column: 'id',
      width: 400,
      frozen,
    });
    expect(res.widths.id).toBe(400);
    // 关键回归：别的列**一点都不能变**。早期版本在这里做摊平，用户会看到
    // 「只拖了 id，其他列也跟着动」，这正是要杜绝的现象
    expect(res.widths.name).toBe(180);
    expect(res.widths.created_at).toBe(170);
    // 表格总宽随之增减，而不是被拉回容器宽度
    expect(res.tableWidth).toBe(INDEX_COLUMN_WIDTH + 400 + 180 + 170);
  });

  it('拖动时不铺满容器：表格宽度就是各列之和，所见即所得', () => {
    const res = layoutColumns(['id', 'name'], prefs, noMeta, 900, {
      column: 'id',
      width: 300,
      frozen: { id: 120, name: 180 },
    });
    expect(res.tableWidth).toBe(INDEX_COLUMN_WIDTH + 300 + 180);
  });

  it('没有 frozen 快照时退回按偏好取宽（拖动第一帧 / 外部直接给 override 的场景）', () => {
    const res = layoutColumns(['id', 'name'], prefs, noMeta, 900, { column: 'id', width: 400 });
    expect(res.widths.id).toBe(400);
    expect(res.widths.name).toBe(180);
    expect(res.tableWidth).toBe(INDEX_COLUMN_WIDTH + 400 + 180);
  });
});

describe('dbColumnLayout · 「全不选」按钮的可用性', () => {
  const cols = ['id', 'name', 'created_at'];

  it('还剩一列时置灰（再点也不会有变化了）', () => {
    expect(isOnlyOneColumnVisible(cols, ['name', 'created_at'])).toBe(true);
    expect(isOnlyOneColumnVisible(cols, ['name'])).toBe(false);
    expect(isOnlyOneColumnVisible(cols, [])).toBe(false);
  });

  it('脏数据（隐藏了不存在的列名）不会误判成「已到尽头」', () => {
    expect(isOnlyOneColumnVisible(cols, ['ghost'])).toBe(false);
    expect(isOnlyOneColumnVisible(cols, ['ghost', 'name', 'created_at'])).toBe(true);
  });

  it('只有一列的表没有可隐藏的余地', () => {
    expect(isOnlyOneColumnVisible(['id'], [])).toBe(true);
  });
});
