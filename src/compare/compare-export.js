// The differences of a comparison as a standard unified diff, which any diff tool
// or code review can read. getLine(side, index) returns a line of that side.
import { KIND } from './compare-diff.js';

const CONTEXT_LINES = 3;

export function unifiedDiff(result, getLine, leftName, rightName) {
  const out = [`--- ${leftName}`, `+++ ${rightName}`];
  if (!result || result.identical) return `${out.join('\n')}\n`;
  const { ops } = result;
  const isChange = (op) => op.kind !== KIND.SAME && op.kind !== KIND.IGNORED;
  let index = 0;
  while (index < ops.length) {
    if (!isChange(ops[index])) {
      index += 1;
      continue;
    }
    // A hunk runs until a stretch of matches too long to keep as context.
    let end = index;
    for (let next = index + 1; next < ops.length; next += 1) {
      const op = ops[next];
      if (isChange(op)) end = next;
      else if (op.kind === KIND.SAME && op.lc > CONTEXT_LINES * 2) break;
    }
    const previous = ops[index - 1];
    const following = ops[end + 1];
    const before = previous?.kind === KIND.SAME ? Math.min(previous.lc, CONTEXT_LINES) : 0;
    const after = following?.kind === KIND.SAME ? Math.min(following.lc, CONTEXT_LINES) : 0;
    const body = [];
    let leftCount = before + after;
    let rightCount = before + after;
    for (let i = previous ? previous.lc - before : 0; before && i < previous.lc; i += 1) body.push(` ${getLine('left', previous.l + i)}`);
    for (let at = index; at <= end; at += 1) {
      const op = ops[at];
      if (op.kind === KIND.IGNORED) continue;
      if (op.kind === KIND.SAME) {
        for (let i = 0; i < op.lc; i += 1) body.push(` ${getLine('left', op.l + i)}`);
      } else {
        for (let i = 0; i < op.lc; i += 1) body.push(`-${getLine('left', op.l + i)}`);
        for (let i = 0; i < op.rc; i += 1) body.push(`+${getLine('right', op.r + i)}`);
      }
      leftCount += op.lc;
      rightCount += op.rc;
    }
    for (let i = 0; i < after; i += 1) body.push(` ${getLine('left', following.l + i)}`);
    // Unified diff counts from 1, and a side with no lines names the line before.
    const leftStart = ops[index].l - before + (leftCount ? 1 : 0);
    const rightStart = ops[index].r - before + (rightCount ? 1 : 0);
    out.push(`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`, ...body);
    index = end + 1;
  }
  return `${out.join('\n')}\n`;
}
