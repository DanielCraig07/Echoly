import React from 'react';
import type { GitCommitEntry } from '@deepseek-ide/shared';
import { GRAPH_BRANCH_COLORS, type GraphAnalysis } from '../services/gitGraph';

/**
 * 提交图的**纯渲染**部分：一行提交的轨道连线，以及行与行之间的竖向延续段。
 *
 * 从 `GitPanel.tsx` 拆出来（那里已经三千多行），拆的依据是这两个组件只依赖
 * `GraphAnalysis` —— 不碰面板状态、不发 IPC、不查字典，因此可以独立阅读，
 * 也不会因为面板里某个 state 变化而被牵连重渲染。
 */

export function GitGraphRowSvg({
  rowIndex,
  commit,
  analysis,
  totalRowHeight,
  isSelected,
}: {
  rowIndex: number;
  commit: GitCommitEntry;
  analysis: GraphAnalysis;
  totalRowHeight: number;
  isSelected?: boolean;
}) {
  const { commitLanes, edges } = analysis;
  const cLane = commitLanes.get(commit.hash) ?? 0;
  const cColor = GRAPH_BRANCH_COLORS[cLane % GRAPH_BRANCH_COLORS.length];
  const LANE_WIDTH = 12;
  const X_OFFSET = 10;
  const Y_MID = 13;
  const cx = X_OFFSET + cLane * LANE_WIDTH;
  const isMerge = (commit.parents?.length || 0) >= 2;

  const paths: React.ReactNode[] = [];

  // 计算当前行真正涉及的最大轨道编号（包括节点自身轨道，以及当前行所有连线的起点和终点轨道）
  let rowMaxLane = cLane;

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e.childRow <= rowIndex && rowIndex <= e.parentRow) {
      rowMaxLane = Math.max(rowMaxLane, e.parentLane);
      if (rowIndex === e.childRow) {
        rowMaxLane = Math.max(rowMaxLane, e.childLane);
      }

      const childX = X_OFFSET + e.childLane * LANE_WIDTH;
      const parentX = X_OFFSET + e.parentLane * LANE_WIDTH;
      const dash = e.isDashed ? '4 3' : undefined;

      if (rowIndex === e.childRow) {
        if (e.childLane === e.parentLane) {
          paths.push(
            <line
              key={`c-${i}`}
              x1={childX}
              y1={Y_MID}
              x2={childX}
              y2={totalRowHeight}
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={dash}
            />,
          );
        } else {
          // 分支拐弯：从 child 节点水平向右弯折，以顺滑 90 度圆弧过渡进入目标轨道 parentLane（对齐参考截图）
          const cpx1 = childX + (parentX - childX) * 0.7;
          const cpy1 = Y_MID;
          const cpx2 = parentX;
          const cpy2 = Y_MID + (totalRowHeight - Y_MID) * 0.3;
          paths.push(
            <path
              key={`c-${i}`}
              d={`M ${childX} ${Y_MID} C ${cpx1} ${cpy1}, ${cpx2} ${cpy2}, ${parentX} ${totalRowHeight}`}
              fill="none"
              stroke={e.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={dash}
            />,
          );
        }
      } else if (rowIndex === e.parentRow) {
        if (e.childLane === e.parentLane) {
          paths.push(
            <line
              key={`p-${i}`}
              x1={parentX}
              y1={0}
              x2={parentX}
              y2={Y_MID}
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={dash}
            />,
          );
        } else if (e.parentRow === e.childRow + 1) {
          paths.push(
            <line
              key={`p-${i}`}
              x1={parentX}
              y1={0}
              x2={parentX}
              y2={Y_MID}
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={dash}
            />,
          );
        } else {
          paths.push(
            <line
              key={`p-${i}`}
              x1={parentX}
              y1={0}
              x2={parentX}
              y2={Y_MID}
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={dash}
            />,
          );
        }
      } else {
        // 中间行垂直向下延续轨道
        paths.push(
          <line
            key={`m-${i}`}
            x1={parentX}
            y1={0}
            x2={parentX}
            y2={totalRowHeight}
            stroke={e.color}
            strokeWidth={2}
            strokeDasharray={dash}
          />,
        );
      }
    }
  }

  // 紧凑自适应宽度：由当前行实际涉及的最大轨道决定，消除右侧无效空白，使提交说明紧贴分支轨道
  const svgWidth = X_OFFSET + rowMaxLane * LANE_WIDTH + 8;

  return (
    <svg
      width={svgWidth}
      height={totalRowHeight}
      style={{ overflow: 'visible', display: 'block', flexShrink: 0 }}
    >
      {paths}
      {isMerge ? (
        <g>
          <circle
            cx={cx}
            cy={Y_MID}
            r={5}
            fill="var(--bg-panel, #181818)"
            stroke={cColor}
            strokeWidth={1.8}
          />
          <circle cx={cx} cy={Y_MID} r={2} fill={cColor} />
          {isSelected && (
            <circle
              cx={cx}
              cy={Y_MID}
              r={7.5}
              fill="none"
              stroke={cColor}
              strokeWidth={1.2}
              strokeDasharray="2 2"
              opacity={0.85}
            />
          )}
        </g>
      ) : (
        <g>
          <circle
            cx={cx}
            cy={Y_MID}
            r={4}
            fill={cColor}
            stroke="var(--bg-panel, #181818)"
            strokeWidth={1.5}
          />
          {isSelected && (
            <circle
              cx={cx}
              cy={Y_MID}
              r={7}
              fill="none"
              stroke={cColor}
              strokeWidth={1.2}
              strokeDasharray="2 2"
              opacity={0.85}
            />
          )}
        </g>
      )}
    </svg>
  );
}

export function GitGraphExpandSvg({
  rowIndex,
  analysis,
}: {
  rowIndex: number;
  analysis: GraphAnalysis;
}) {
  const { edges } = analysis;
  const LANE_WIDTH = 12;
  const X_OFFSET = 10;

  // 穿过本行与下一行之间的所有连线（即本行下方仍要延续的轨道）
  const passingEdges = edges.filter((e) => e.childRow <= rowIndex && rowIndex < e.parentRow);
  const maxActiveLane =
    passingEdges.length > 0 ? Math.max(...passingEdges.map((e) => e.parentLane)) : 0;
  const svgWidth = X_OFFSET + maxActiveLane * LANE_WIDTH + 8;

  return (
    <div style={{ width: svgWidth, flexShrink: 0, position: 'relative', display: 'flex' }}>
      <svg
        width={svgWidth}
        style={{
          width: svgWidth,
          height: '100%',
          display: 'block',
          overflow: 'visible',
        }}
        viewBox={`0 0 ${svgWidth} 100`}
        preserveAspectRatio="none"
      >
        {passingEdges.map((e, idx) => {
          const x = X_OFFSET + e.parentLane * LANE_WIDTH;
          return (
            <line
              key={`exp-${idx}-${x}`}
              x1={x}
              y1={0}
              x2={x}
              y2={100}
              vectorEffect="non-scaling-stroke"
              stroke={e.color}
              strokeWidth={2}
              strokeDasharray={e.isDashed ? '4 3' : undefined}
            />
          );
        })}
      </svg>
    </div>
  );
}
