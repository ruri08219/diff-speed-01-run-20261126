// Fast drop-in for makefun-diff 1.0.0 (make.fun's own line diff, MIT, derived from jsdiff 9.0.0).
//
// run(input) returns exactly the answer makefun-diff 1.0.0 returns for { old, new }: the same patch,
// byte for byte. The only difference from the reference is speed: the lines are hashed to integer ids
// once, the Myers search runs on typed arrays with no per-step allocation, and the exact edit script
// is recovered by backtracking over the per-d furthest-reach arrays.
//
// The rule, restated from the reference's header:
//   - Lines are cut after every "\n" (a "\r" is part of its line); a last line with no "\n" is a line too.
//   - Common prefix kept, then common suffix of what is left; between them Myers's greedy search from
//     the first lines: on each diagonal the path reaching furthest into the old text wins, and when a
//     deletion and an insertion reach the same point the deletion's (jsdiff takes the insertion's); no
//     move past either text's end; no edge-diagonal pruning; every run of equal lines followed as far
//     as it goes; the first path to reach both ends is the script.
//   - Patch: "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", then per hunk "@ os ol ns nl"
//     and one line per covered line ("=" kept, "-" deleted, "+" inserted); deletions before insertions
//     in each change run; up to 3 kept lines before and after each run; runs at most 6 kept lines
//     apart share a hunk. A line ending its text with no newline is written with one and followed by
//     a line "%". Identical texts are the first line alone.
//
// The backtrack reproduces the forward choice exactly: at step d on diagonal k, the last edit was a
// deletion exactly when the forward rule picked the deletion from diagonal k-1 at d-1 (furthest into
// the old text, deletion on a tie), else an insertion from k+1. The snake between the edit and the
// recorded furthest reach is keeps, counted arithmetically, never re-walked by equality (re-walking
// could overshoot the edit point when the previous path's snake stopped on a text end, not a mismatch).

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
function tokenize(text) {
  const parts = text.split('\n');
  const lines = [];
  const last = parts.length - 1;
  for (let i = 0; i < last; i++) lines.push(parts[i] + '\n');
  if (parts[last] !== '') lines.push(parts[last]);
  return lines;
}

/**
 * The runs of the edit script of A into B: [{ kind, count }], in order.
 * A, B are Int32Array views of line ids; n, m their lengths.
 * Returns [] when both are empty.
 *
 * The furthest reaches are kept in ONE flat typed array: the reaches after d edits sit at
 * offset d*d (their count is 2d+1, so the next d starts at (d+1)^2). Each entry holds x+1,
 * so 0 means "diagonal never reached" and no fill pass is needed (the buffer is zero-filled).
 * Uint16Array while x fits (the generator caps texts at 40,000 lines), else Int32Array.
 */
function myersRuns(A, B, n, m) {
  const Ctor = n <= 65534 ? Uint16Array : Int32Array;
  let capD = 256;
  let buf = new Ctor((capD + 1) * (capD + 1));
  const ensure = (d) => {
    if (d > capD) {
      let nd = capD;
      while (nd < d) nd *= 2;
      const nb = new Ctor((nd + 1) * (nd + 1));
      nb.set(buf.subarray(0, (capD + 1) * (capD + 1)));
      buf = nb;
      capD = nd;
    }
  };
  let x0 = 0;
  while (x0 < n && x0 < m && A[x0] === B[x0]) x0++;
  buf[0] = x0 + 1;
  if (x0 >= n && x0 >= m) return [];

  for (let d = 1; d <= n + m; d++) {
    ensure(d);
    const prevOff = (d - 1) * (d - 1);
    const curOff = d * d;
    const plen = 2 * d - 1;
    // Only diagonals k with k = d (mod 2) are reachable after d edits (each edit moves k by
    // one), so i = k + d is even; the odd i hold nothing and are skipped. pDel/pIns walk the
    // previous row in step with i, and k walks with them, so no index math runs per diagonal.
    let pDel = prevOff - 2;
    let pIns = prevOff;
    let k = -d;
    for (let i = 0; i <= 2 * d; i += 2, k += 2, pDel += 2, pIns += 2) {
      // Deletion source: diagonal k-1 at d-1, raw value at pDel.
      // Insertion source: diagonal k+1 at d-1, raw value at pIns.
      const rDel = i >= 2 ? buf[pDel] : 0;
      const rIns = i < plen ? buf[pIns] : 0;
      const xDel = rDel - 1;
      const xIns = rIns - 1;
      let x;
      if (rDel !== 0 && xDel < n) {
        // Deletion is a candidate; it wins unless the insertion is a candidate and reaches
        // further into the old text (xIns), the deletion winning the tie (xDel >= xIns - 1).
        if (rIns === 0 || xIns - k - 1 >= m || xDel >= xIns - 1) x = xDel + 1;
        else x = xIns;
      } else if (rIns !== 0 && xIns - k - 1 < m) {
        x = xIns;
      } else {
        continue; // no candidate on this diagonal
      }
      // The snake from (x, x - k): at most min(n - x, m - y) steps, and B[y] is B[x - k].
      const xEnd = x + Math.min(n - x, m - (x - k));
      while (x < xEnd && A[x] === B[x - k]) x++;
      const y = x - k;
      buf[curOff + i] = x + 1;
      if (x >= n && y >= m) return backtrack(buf, d, k, n, m);
    }
  }
  throw new Error('makefun-diff: the search ended without reaching both ends');
}

/** Rebuild the runs from the recorded furthest reaches. See the header for why the edit is picked first. */
function backtrack(buf, D, kWin, n, m) {
  const rev = []; // single ops in reverse order: KEEP / DELETE / INSERT
  let x = n;
  let y = m;
  let d = D;
  while (d > 0) {
    const k = x - y;
    const i = k + d; // index of diagonal k in the d-th row
    const prevOff = (d - 1) * (d - 1);
    const plen = 2 * d - 1;
    const rDel = i >= 2 ? buf[prevOff + i - 2] : 0;
    const rIns = i < plen ? buf[prevOff + i] : 0;
    const xDel = rDel - 1;
    const xIns = rIns - 1;
    const canDel = rDel !== 0 && xDel < n;
    const canIns = rIns !== 0 && xIns - k - 1 < m;
    if (canDel && (!canIns || xDel >= xIns - 1)) {
      // Deletion from (xDel, xDel - (k - 1)); the edit lands at (xDel + 1, xDel + 1 - k).
      const xe = xDel + 1;
      const keeps = x - xe;
      for (let t = 0; t < keeps; t++) rev.push(KEEP);
      rev.push(DELETE);
      x = xDel;
      y = xDel - (k - 1);
    } else if (canIns) {
      // Insertion from (xIns, xIns - (k + 1)); the edit lands at (xIns, xIns - k).
      const xe = xIns;
      const keeps = x - xe;
      for (let t = 0; t < keeps; t++) rev.push(KEEP);
      rev.push(INSERT);
      x = xIns;
      y = xIns - (k + 1);
    } else {
      throw new Error('makefun-diff: backtrack found no predecessor');
    }
    d--;
  }
  // The d=0 snake, from (0,0) to (x, y) with x === y.
  for (let t = 0; t < x; t++) rev.push(KEEP);
  const runs = [];
  for (let idx = rev.length - 1; idx >= 0; idx--) {
    const kind = rev[idx];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count++;
    else runs.push({ kind, count: 1 });
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** make.fun's own patch of two texts, by the header's rule. */
function diffPatch(oldText, newText) {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;

  // Hash every line to an integer id (one shared map, so equal lines share an id).
  const ids = new Map();
  let nextId = 0;
  const A = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const line = a[i];
    let id = ids.get(line);
    if (id === undefined) {
      id = nextId++;
      ids.set(line, id);
    }
    A[i] = id;
  }
  const B = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    const line = b[j];
    let id = ids.get(line);
    if (id === undefined) {
      id = nextId++;
      ids.set(line, id);
    }
    B[j] = id;
  }

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && A[n - 1 - suffix] === B[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(
    ...myersRuns(A.subarray(prefix, n - suffix), B.subarray(prefix, m - suffix), n - prefix - suffix, m - prefix - suffix),
  );
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const CONTEXT = 3;
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a[at]));
  }
  return out.join('');
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  return diffPatch(input.old, input.new);
}
