# Design Notes for Implementing `windowBy` in `linq.js`

## 1. Purpose and Scope

`windowBy` is a higher-level operator that mimics SQL’s window functions:

```sql
... OVER (PARTITION BY … ORDER BY … ROWS BETWEEN …)

It works over grouped, ordered partitions and exposes each row together with its window (the slice of rows around it).

We’ll add it as an instance method on Enumerable, so it composes with existing LINQ chains.

2. Target API

2.1 Type Signatures (conceptual)

type WindowFrame = {
  preceding: number;          // rows before the current row
  following: number;          // rows after the current row
  requireFullWindow?: boolean // if true, emit empty window (or null) until frame is fully available
};

interface WindowContext<T> {
  partitionKey: any;
  row: T;
  index: number;  // index within the partition
  partition: T[]; // full ordered partition
  window: T[];    // the window around the current row
}

interface Enumerable<T> {
  windowBy<R>(
    partitionKeySelector: (item: T) => any,
    orderKeySelector: (item: T) => any,
    frame: WindowFrame,
    selector: (ctx: WindowContext<T>) => R
  ): Enumerable<R>;
}

2.2 Example Usage

Rolling 3-row sum per region, ordered by month

Enumerable.from(rows)
  .windowBy(
    r => r.regionId,           // partition by region
    r => r.month,              // order by month
    { preceding: 2, following: 0, requireFullWindow: true },
    ({ row, window }) => ({
      ...row,
      salesRolling3: Enumerable.from(window).sum(w => w.totalSalesAmount),
    })
  )
  .toArray();

Rank products by sales within region

Enumerable.from(rows)
  .windowBy(
    r => r.regionId,
    r => -r.totalSalesAmount,  // descending order via negative
    { preceding: Number.MAX_SAFE_INTEGER, following: 0, requireFullWindow: false },
    ({ row, index }) => ({
      ...row,
      salesRankInRegion: index + 1,
    })
  )
  .toArray();


⸻

3. Behaviour and Semantics

3.1 Partitioning
	•	All elements are partitioned using partitionKeySelector(item).
	•	Each partition is processed independently.
	•	Partitions are not required to be contiguous in the original sequence; groupBy semantics apply.

3.2 Ordering
	•	Within each partition, rows are sorted by orderKeySelector(item).
	•	Standard orderBy is sufficient; secondary ordering (ties) is up to the caller (e.g. combine fields in orderKeySelector if needed).

3.3 Window Frame

Given a partition of size n and a row at index i:
	•	start = max(0, i - preceding)
	•	end   = min(n - 1, i + following)
	•	window = partition.slice(start, end + 1)

If requireFullWindow is true:
	•	A full window size is preceding + following + 1.
	•	If window.length < fullWindowSize, we still call selector but pass window as [] (or another convention; see below).

If requireFullWindow is false:
	•	Partial windows are allowed (e.g. at the beginning and end of the partition).

3.4 Selector and Output

For each row in each partition, the selector is called with:

{
  partitionKey: group.key(),
  row: partition[i],     // the current row
  index: i,              // index within ordered partition
  partition,             // full ordered array of the partition
  window                 // the framed slice for this row
}

	•	The selector return value is the output element of the resulting sequence.
	•	The resulting sequence preserves:
	•	Partition grouping, but not necessarily original global order.
	•	Within a partition, the order is by orderKeySelector.

If preserving original global order is required later, we can consider an optional stableKeySelector, but that’s out of scope for v1.

⸻

4. Implementation Plan

4.1 Location and Attachment
	•	Implement windowBy on Enumerable.prototype, alongside other higher-level operators (e.g. near groupBy, partitionBy).
	•	Use Enumerable.defer and Enumerable.from so that:
	•	Evaluation is lazy.
	•	Each iteration constructs a fresh enumerable.

4.2 High-Level Implementation (array-based first)

We can lean on existing operators:
	1.	Partition the source:

const groups = Enumerable.from(source)
  .groupBy(
    partitionKeySelector,
    x => x
  )
  .toArray();


	2.	Process each partition:
	•	Turn the group into an ordered array:

const partition = group
  .orderBy(orderKeySelector)
  .toArray();


	•	For each i in [0, partition.length):
	•	Compute start, end, window.
	•	Apply requireFullWindow logic.
	•	Call selector({ partitionKey, row, index, partition, window }).
	•	Push result into an accumulated array.

	3.	Return combined results as an Enumerable:

return Enumerable.defer(() => {
  const groups = ...;
  const out = [];
  // loop groups → partitions → rows, call selector, push to out
  return Enumerable.from(out);
});



Pseudocode

Enumerable.prototype.windowBy = function(
  partitionKeySelector,
  orderKeySelector,
  frame,
  selector
) {
  const source = this;
  const { preceding, following, requireFullWindow = true } = frame;

  return Enumerable.defer(() => {
    const groups = Enumerable.from(source)
      .groupBy(
        partitionKeySelector,
        x => x
      )
      .toArray();

    const out = [];

    for (const group of groups) {
      const key = group.key();
      const partition = group
        .orderBy(orderKeySelector)
        .toArray();

      const n = partition.length;
      const fullWindowSize = preceding + following + 1;

      for (let i = 0; i < n; i++) {
        const start = Math.max(0, i - preceding);
        const end = Math.min(n - 1, i + following);
        const window = partition.slice(start, end + 1);

        const effectiveWindow =
          requireFullWindow && window.length < fullWindowSize
            ? []
            : window;

        out.push(
          selector({
            partitionKey: key,
            row: partition[i],
            index: i,
            partition,
            window: effectiveWindow,
          })
        );
      }
    }

    return Enumerable.from(out);
  });
};

4.3 Integration with Existing Utilities
	•	If you have Enumerable.Utils.createEnumerable / createEnumerator, you can later convert the array-based logic into a streaming enumerator.
	•	For a first version, the toArray() usage is fine and keeps the logic easy to read.

⸻

5. Design Choices and Trade-offs

5.1 Array-based vs streaming enumerators

Array-based (initial plan):
	•	Pros:
	•	Straightforward, easy to reason about.
	•	Reuses existing groupBy, orderBy, toArray.
	•	Good enough for moderate partition sizes (analytics scenarios are often aggregated anyway).
	•	Cons:
	•	Requires materializing each partition in memory.
	•	Not ideal for extremely large partitions.

Enumerator-based (later enhancement):
	•	You could build windowBy on top of createEnumerable + createEnumerator to avoid full materialization, at the cost of more complex code.
	•	This can be deferred until you see a real need.

5.2 requireFullWindow semantics

We need to pick behaviour when there aren’t enough rows on one or both sides:
	•	Current suggestion: if requireFullWindow is true and there aren’t enough rows:
	•	Call selector with window: [] and let the selector decide how to handle it (usually return null or some default).
	•	Alternative: skip those rows entirely. This would change output length and complicate alignment, so less desirable for a general operator.

5.3 Ordering stability
	•	Within a partition, ordering is defined by orderKeySelector.
	•	Between partitions, the current plan just concatenates partitions in whatever order groupBy().toArray() yields them.
	•	If a stable global order is required by callers, we can consider:
	•	Adding an optional postOrderKeySelector and applying a final orderBy after windowBy, or
	•	Documenting that callers should re-sort if needed.

⸻

6. Testing Plan

6.1 Basic behaviour
	•	Single partition, simple data:

const rows = [
  { id: 1, v: 10 },
  { id: 2, v: 20 },
  { id: 3, v: 30 },
];

const result = Enumerable.from(rows)
  .windowBy(
    r => 'all',
    r => r.id,
    { preceding: 1, following: 0, requireFullWindow: false },
    ({ row, window }) => ({
      id: row.id,
      sumWindow: Enumerable.from(window).sum(x => x.v),
    })
  )
  .toArray();

Expected window sums: [10, 30, 50] (rows: [10], [10,20], [20,30]).

6.2 Multiple partitions
	•	Use regionId partitions, verify that each region’s windows don’t mix rows from other regions.
	•	Check that the number of output rows equals the number of input rows.

6.3 requireFullWindow flag
	•	With preceding = 2, following = 0, partition length 3:
	•	requireFullWindow = true → first two rows get window: [], last row gets full [r1, r2, r3].
	•	requireFullWindow = false → all rows get partial windows.

6.4 Edge cases
	•	Empty sequence → result is empty.
	•	Single-element partitions with various frames.
	•	Non-numeric windows (e.g. strings) to ensure the operator is type-agnostic.

⸻

7. Documentation and Examples

Once implemented:
	1.	Add windowBy to your operator tutorial with:
	•	Short conceptual mapping to SQL OVER (PARTITION BY … ORDER BY … ROWS BETWEEN …).
	•	At least two examples:
	•	Rolling 3-period sum.
	•	Rank within partition.
	2.	Clarify:
	•	That it is partition-based (uses groupBy internally).
	•	That it expects the selector to map WindowContext<T> to whatever shape the caller wants.
	•	The meaning of preceding, following, and requireFullWindow.

⸻

8. Summary

To implement windowBy:
	•	API: add windowBy(partitionKeySelector, orderKeySelector, frame, selector) on Enumerable.prototype.
	•	Core behaviour:
	•	Partition via groupBy.
	•	Order within partition via orderBy.
	•	For each row, compute a frame-based window (preceding/following).
	•	Call selector with full WindowContext.
	•	Implementation:
	•	Start with an array-based defer implementation using existing operators.
	•	Optionally refine to an enumerator-based version later.
	•	Usage:
	•	Use windowBy as the foundation for rolling sums, moving averages, ranks, and other window-style analytics in your semantic engine.

