# Window Functions in `linq.js`: Design & Implementation Guide

This document describes how to extend `linq.js` with **MoreLINQ-style primitives** and a higher-level **`windowBy`** operator tailored for analytic use cases (SQL window functions).

We’ll:

1. Add **core window primitives**:
   - `windowed` (sliding windows)
   - `lag`
   - `lead`
2. Implement **`windowBy`** on top of standard LINQ operators (and optionally using those primitives).
3. Outline behaviour, trade-offs, and test scenarios.

All code samples assume the usual import:

```js
import Enumerable from './linq.js'
````

---

## 1. Goals & Overview

We want a small, coherent set of sequence operators that:

* Make **sliding windows** and **neighbor access** easy (`windowed`, `lag`, `lead`).
* Provide a high-level, SQL-like operator for analytics:

  ```sql
  ... OVER (PARTITION BY … ORDER BY … ROWS BETWEEN …)
  ```

  Implemented as:

  ```ts
  windowBy(
    partitionKeySelector,
    orderKeySelector,
    frame,
    selector
  )
  ```

This lets your semantic engine write:

```js
Enumerable.from(rows)
  .windowBy(
    r => r.regionId,
    r => r.month,
    { preceding: 2, following: 0, requireFullWindow: true },
    ({ row, window }) => ({
      ...row,
      salesRolling3: Enumerable.from(window).sum(w => w.totalSalesAmount),
    })
  )
```

instead of hand-rolling `groupBy + orderBy + index arithmetic` every time.

---

## 2. Core Primitive: `windowed`

### 2.1 Concept

`windowed` produces **sliding windows** over a sequence, similar to Kotlin’s `windowed` or MoreLINQ’s `Window`.

**Examples:**

```js
// Basic sliding window of size 3
Enumerable.range(1, 5).windowed(3).toArray()
// => [[1,2,3], [2,3,4], [3,4,5]]

// With selector
Enumerable.range(1, 5)
  .windowed(3, 1, (win, i) => ({ index: i, sum: Enumerable.from(win).sum() }))
  .toArray()
// => [
//   { index: 0, sum: 6 },
//   { index: 1, sum: 9 },
//   { index: 2, sum: 12 }
// ]
```

### 2.2 API

Conceptual TypeScript:

```ts
interface Enumerable<T> {
  windowed(size: number): Enumerable<T[]>
  windowed<R>(
    size: number,
    step: number,
    selector: (window: T[], index: number) => R
  ): Enumerable<R>
}
```

* `size`: window size (must be ≥ 1).
* `step`: number of elements to advance per window (default: 1).
* `selector`: transforms each window; if omitted, windows are emitted as arrays.

### 2.3 Behaviour

* Windows are contiguous slices: `[start, start+size)`.
* Last window is emitted only when there is a **full** window.
* If `step` is omitted or `null`, treat it as `1`.

### 2.4 Implementation Sketch

Use `Enumerable.defer` to keep it lazy; internally materialize to an array for v1.

```js
Enumerable.prototype.windowed = function(size, stepOrSelector, maybeSelector) {
  const source = this
  const hasStep = typeof stepOrSelector === 'number'
  const step = hasStep ? stepOrSelector : 1
  const selector =
    typeof stepOrSelector === 'function'
      ? stepOrSelector
      : (maybeSelector || ((w) => w))

  if (size <= 0) {
    throw new Error('windowed: size must be >= 1')
  }
  if (step <= 0) {
    throw new Error('windowed: step must be >= 1')
  }

  return Enumerable.defer(() => {
    const arr = source.toArray()
    const result = []

    for (let start = 0, idx = 0; start + size <= arr.length; start += step, idx++) {
      const win = arr.slice(start, start + size)
      result.push(selector(win, idx))
    }

    return Enumerable.from(result)
  })
}
```

---

## 3. Convenience Primitive: `lag` / `lead`

### 3.1 Concept

`lag` and `lead` expose **previous** or **next** elements relative to each position.

```js
// lag: previous value
Enumerable.from([10, 20, 30])
  .lag(1, null)
  .toArray()
// => [null, 10, 20]

// lead: next value
Enumerable.from([10, 20, 30])
  .lead(1, null)
  .toArray()
// => [20, 30, null]
```

Can be combined with `zip` to compute deltas:

```js
const sales = Enumerable.from([100, 120, 90])
const curr = sales
const prev = sales.lag(1, null)

curr
  .zip(prev, (c, p) => (p == null ? null : c - p))
  .toArray()
// => [null, 20, -30]
```

### 3.2 API

```ts
interface Enumerable<T> {
  lag(offset: number, defaultValue?: T): Enumerable<T | undefined>
  lead(offset: number, defaultValue?: T): Enumerable<T | undefined>
}
```

### 3.3 Implementation Sketch

Again, array-based first:

```js
Enumerable.prototype.lag = function(offset, defaultValue = undefined) {
  const source = this
  if (offset < 0) {
    throw new Error('lag: offset must be >= 0')
  }

  return Enumerable.defer(() => {
    const arr   = source.toArray()
    const result = []

    for (let i = 0; i < arr.length; i++) {
      const j = i - offset
      result.push(j >= 0 ? arr[j] : defaultValue)
    }

    return Enumerable.from(result)
  })
}

Enumerable.prototype.lead = function(offset, defaultValue = undefined) {
  const source = this
  if (offset < 0) {
    throw new Error('lead: offset must be >= 0')
  }

  return Enumerable.defer(() => {
    const arr    = source.toArray()
    const result = []

    for (let i = 0; i < arr.length; i++) {
      const j = i + offset
      result.push(j < arr.length ? arr[j] : defaultValue)
    }

    return Enumerable.from(result)
  })
}
```

---

## 4. High-Level Operator: `windowBy`

### 4.1 Concept

`windowBy` is the SQL-like analytic operator:

* `PARTITION BY` → `partitionKeySelector`
* `ORDER BY` → `orderKeySelector`
* `ROWS BETWEEN ...` → `frame` (`preceding` / `following`)

It returns a new sequence where each element is produced by a `selector` that sees:

* the current row
* the entire ordered partition
* the window slice around that row

### 4.2 Types

```ts
export type WindowFrame = {
  preceding: number       // rows before the current row
  following: number       // rows after the current row
  requireFullWindow?: boolean // default true
}

export interface WindowContext<T> {
  partitionKey: any
  row: T
  index: number          // index within ordered partition
  partition: T[]         // full ordered partition
  window: T[]            // framed window for this row (may be [])
}

interface Enumerable<T> {
  windowBy<R>(
    partitionKeySelector: (item: T) => any,
    orderKeySelector: (item: T) => any,
    frame: WindowFrame,
    selector: (ctx: WindowContext<T>) => R
  ): Enumerable<R>
}
```

### 4.3 Behaviour

Given a partition with `n` elements and a row at index `i`:

```txt
start = max(0, i - preceding)
end   = min(n - 1, i + following)
window = partition.slice(start, end + 1)
```

* If `requireFullWindow` is `true` (default):

  * `fullWindowSize = preceding + following + 1`
  * If `window.length < fullWindowSize`, the operator still calls `selector`, but passes `window: []`.
* If `requireFullWindow` is `false`:

  * Partial windows are allowed; `window` will contain as many rows as are available.

The **output sequence length equals the input length**: one output per input row.

### 4.4 Example Usage

#### Rolling 3-period sum per region, ordered by month

```js
Enumerable.from(rows)
  .windowBy(
    r => r.regionId,
    r => r.month,
    { preceding: 2, following: 0, requireFullWindow: true },
    ({ row, window }) => ({
      ...row,
      salesRolling3: window.length
        ? Enumerable.from(window).sum(w => w.totalSalesAmount)
        : null,
    })
  )
  .toArray()
```

#### Rank products by sales within region

```js
Enumerable.from(rows)
  .windowBy(
    r => r.regionId,
    r => -r.totalSalesAmount, // descending by sales
    { preceding: Number.MAX_SAFE_INTEGER, following: 0, requireFullWindow: false },
    ({ row, index }) => ({
      ...row,
      salesRankInRegion: index + 1,
    })
  )
  .toArray()
```

### 4.5 Implementation Plan

Initial implementation can be array-based using existing operators:

1. `groupBy` by partition key.
2. For each group:

   * `orderBy` by order key.
   * Convert to `partition` array.
3. For each index in partition:

   * Compute `start`, `end`, `window`.
   * Apply `requireFullWindow` logic.
   * Call `selector` with `WindowContext`.
4. Accumulate results across all partitions into an array.
5. Return `Enumerable.defer(() => Enumerable.from(out))`.

### 4.6 Implementation Sketch

```js
Enumerable.prototype.windowBy = function(
  partitionKeySelector,
  orderKeySelector,
  frame,
  selector
) {
  const source = this
  const {
    preceding,
    following,
    requireFullWindow = true,
  } = frame

  if (preceding < 0 || following < 0) {
    throw new Error('windowBy: preceding/following must be >= 0')
  }

  return Enumerable.defer(() => {
    const groups = Enumerable.from(source)
      .groupBy(
        partitionKeySelector,
        x => x
      )
      .toArray()

    const out = []
    const fullWindowSize = preceding + following + 1

    for (const group of groups) {
      const key = group.key()
      const partition = group
        .orderBy(orderKeySelector)
        .toArray()

      const n = partition.length

      for (let i = 0; i < n; i++) {
        const start = Math.max(0, i - preceding)
        const end   = Math.min(n - 1, i + following)
        const rawWindow = partition.slice(start, end + 1)

        const window =
          requireFullWindow && rawWindow.length < fullWindowSize
            ? []
            : rawWindow

        out.push(
          selector({
            partitionKey: key,
            row: partition[i],
            index: i,
            partition,
            window,
          })
        )
      }
    }

    return Enumerable.from(out)
  })
}
```

Later, if needed, you can replace the array-based processing with a streaming enumerator using `Enumerable.Utils.createEnumerable` / `createEnumerator`.

---

## 5. Relationship to MoreLINQ

This design is intentionally similar to MoreLINQ but adapted to your JS library:

* **`windowed`** ≈ MoreLINQ’s `Window` (sliding windows).
* **`lag` / `lead`** ≈ MoreLINQ’s `Lag` / `Lead`.
* **`windowBy`** is a higher-level composition that:

  * partitions (`groupBy`)
  * orders (`orderBy`)
  * frames windows (using indices)
  * exposes a rich `WindowContext` to the caller

You can treat `windowBy` as your “SQL window function” operator built on top of a **MoreLINQ-like core**.

---

## 6. Testing Plan

### 6.1 `windowed`

* Basic sliding behaviour:

  ```js
  Enumerable.range(1, 5).windowed(3).toArray()
  // => [[1,2,3], [2,3,4], [3,4,5]]
  ```

* With custom `step`:

  ```js
  Enumerable.range(1, 7).windowed(3, 3).toArray()
  // => [[1,2,3], [4,5,6]]
  ```

* Edge cases:

  * `size > length` → empty.
  * `size == 1` → each element in its own window.
  * Invalid `size` or `step` → throws.

### 6.2 `lag` / `lead`

* Basic offsets, including `offset = 0` (should echo input).
* Default value when index falls out of range.
* Composition with `zip` for deltas.

### 6.3 `windowBy`

* **Single partition**:

  * No partitioning differences.
  * Validate window contents for various `preceding` / `following` values.
* **Multiple partitions**:

  * Windows never cross partition boundaries.
  * Output count matches input count.
* `requireFullWindow`:

  * With `preceding = 2, following = 0`, partition length 3:

    * `requireFullWindow = true` → first two rows get `window: []`.
    * `requireFullWindow = false` → windows of sizes 1, 2, 3.
* Empty input:

  * Returns empty sequence without error.

---

## 7. Summary

To implement window functions in `linq.js`:

1. **Add sequence-level primitives**:

   * `windowed(size, step?, selector?)`
   * `lag(offset, defaultValue?)`
   * `lead(offset, defaultValue?)`

2. **Add a SQL-style operator**:

   * `windowBy(partitionKeySelector, orderKeySelector, frame, selector)`

3. **Use `windowBy` inside your semantic metrics engine** for:

   * rolling sums / averages,
   * period-over-period changes,
   * ranks and percent-of-total within partitions.

These additions keep the library general-purpose (MoreLINQ-style) while giving you a powerful analytic abstraction that aligns with how you’re modelling metrics and context in your engine.

```
::contentReference[oaicite:0]{index=0}
```
