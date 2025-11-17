import { test, testModule, deepEqual } from './testutils.js'
import Enumerable from '../linq.js'

testModule('Window functions');

test('windowed produces sliding windows', function () {
    const base = Enumerable.range(1, 5).windowed(3).toArray();
    deepEqual(base, [[1, 2, 3], [2, 3, 4], [3, 4, 5]]);

    const stepped = Enumerable.range(1, 6).windowed(3, 2).toArray();
    deepEqual(stepped, [[1, 2, 3], [3, 4, 5]]);

    const projected = Enumerable.range(1, 5)
        .windowed(3, function (window, index) {
            return { index: index, sum: Enumerable.from(window).sum() };
        })
        .toArray();

    deepEqual(projected, [
        { index: 0, sum: 6 },
        { index: 1, sum: 9 },
        { index: 2, sum: 12 }
    ]);
});

test('lag and lead expose neighbouring values', function () {
    const source = Enumerable.from([10, 20, 30]);
    deepEqual(source.lag(1, null).toArray(), [null, 10, 20]);
    deepEqual(source.lead(1, null).toArray(), [20, 30, null]);
});

test('windowBy partitions, orders, and frames rows', function () {
    const sales = [
        { region: 'east', month: 2, amount: 20 },
        { region: 'east', month: 1, amount: 10 },
        { region: 'west', month: 1, amount: 15 },
        { region: 'west', month: 3, amount: 35 },
        { region: 'west', month: 2, amount: 25 }
    ];

    const requireFull = Enumerable.from(sales)
        .windowBy(
            function (row) { return row.region },
            function (row) { return row.month },
            { preceding: 1, following: 0, requireFullWindow: true },
            function (ctx) {
                return {
                    region: ctx.partitionKey,
                    month: ctx.row.month,
                    windowAmounts: ctx.window.map(function (entry) { return entry.amount; })
                };
            }
        )
        .toArray();

    deepEqual(requireFull, [
        { region: 'east', month: 1, windowAmounts: [] },
        { region: 'east', month: 2, windowAmounts: [10, 20] },
        { region: 'west', month: 1, windowAmounts: [] },
        { region: 'west', month: 2, windowAmounts: [15, 25] },
        { region: 'west', month: 3, windowAmounts: [25, 35] }
    ]);

    const rollingSum = Enumerable.from(sales)
        .windowBy(
            function (row) { return row.region },
            function (row) { return row.month },
            { preceding: 1, following: 1, requireFullWindow: false },
            function (ctx) {
                return {
                    region: ctx.partitionKey,
                    month: ctx.row.month,
                    rolling: Enumerable.from(ctx.window).sum(function (entry) { return entry.amount; })
                };
            }
        )
        .toArray();

    deepEqual(rollingSum, [
        { region: 'east', month: 1, rolling: 30 },
        { region: 'east', month: 2, rolling: 30 },
        { region: 'west', month: 1, rolling: 40 },
        { region: 'west', month: 2, rolling: 75 },
        { region: 'west', month: 3, rolling: 60 }
    ]);
});
