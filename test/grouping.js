import { test, testModule, deepEqual } from './testutils.js'
import Enumerable from '../linq.js'

testModule("Grouping");

var fileList = ["temp.xls", "temp2.xls", "temp.pdf", "temp.jpg", "temp2.pdf", "temp3.xls"];

test("groupBy", function ()
{
    let actual = Enumerable.from(fileList)
        .groupBy("file=>file.match(/\\.(.+$)/)[1]")
        .select("{key:$.key(),value:$.toArray()}")
        .toArray();
    let expected = [{ key: "xls", value: ["temp.xls", "temp2.xls", "temp3.xls"] },
                { key: "pdf", value: ["temp.pdf", "temp2.pdf"] },
                { key: "jpg", value: ["temp.jpg"]}];
    deepEqual(actual, expected);

    actual = Enumerable.from(fileList)
        .groupBy("file=>file.match(/\\.(.+$)/)[1]", "file=>file.match(/(^.+)\\..+$/)[1]")
        .select("{key:$.key(),value:$.toArray()}")
        .toArray();
    expected = [{ key: "xls", value: ["temp", "temp2", "temp3"] },
                { key: "pdf", value: ["temp", "temp2"] },
                { key: "jpg", value: ["temp"]}];
    deepEqual(actual, expected);

    actual = Enumerable.from(fileList).groupBy("file=>file.match(/\\.(.+$)/)[1]",
        "file=>file",
        "ext,group => {extension:ext,count:group.count(),files:group.toArray()}")
        .toArray();
    expected = [{ extension: "xls", count: 3, files: ["temp.xls", "temp2.xls", "temp3.xls"] },
                { extension: "pdf", count: 2, files: ["temp.pdf", "temp2.pdf"] },
                { extension: "jpg", count: 1, files: ["temp.jpg"]}];
    deepEqual(actual, expected);

    var objects = [
        { Date: new Date(2000, 1, 1), Id: 1 },
        { Date: new Date(2010, 5, 5), Id: 2 },
        { Date: new Date(2000, 1, 1), Id: 3 }
    ]
    actual = Enumerable.from(objects)
        .groupBy("$.Date", "$.Id",
            function (key, group) { return key.getFullYear() + "-" + group.toJoinedString(',') },
            function (key) { return key.toString() })
        .toArray();
    expected = ["2000-1,3", "2010-2"]
    deepEqual(actual, expected);
});

test("partitionBy", function ()
{
    let actual = Enumerable.from(fileList)
        .partitionBy("file=>file.match(/\\.(.+$)/)[1]")
        .select("{key:$.key(),value:$.toArray()}")
        .toArray();
    let expected = [{ key: "xls", value: ["temp.xls", "temp2.xls"] },
                { key: "pdf", value: ["temp.pdf"] },
                { key: "jpg", value: ["temp.jpg"] },
                { key: "pdf", value: ["temp2.pdf"] },
                { key: "xls", value: ["temp3.xls"] }
                ];
    deepEqual(actual, expected);

    actual = Enumerable.from(fileList)
        .partitionBy("file=>file.match(/\\.(.+$)/)[1]", "file=>file.match(/(^.+)\\..+$/)[1]")
        .select("{key:$.key(),value:$.toArray()}")
        .toArray();
    expected = [{ key: "xls", value: ["temp", "temp2"] },
                { key: "pdf", value: ["temp"] },
                { key: "jpg", value: ["temp"] },
                { key: "pdf", value: ["temp2"] },
                { key: "xls", value: ["temp3"] }
                ];
    deepEqual(actual, expected);

    actual = Enumerable.from(fileList)
        .partitionBy("file=>file.match(/\\.(.+$)/)[1]",
            "file=>file",
            "ext,group=>{extension:ext,count:group.count(),files:group.toArray()}")
        .toArray();
    expected = [{ extension: "xls", count: 2, files: ["temp.xls", "temp2.xls"] },
                { extension: "pdf", count: 1, files: ["temp.pdf"] },
                { extension: "jpg", count: 1, files: ["temp.jpg"] },
                { extension: "pdf", count: 1, files: ["temp2.pdf"] },
                { extension: "xls", count: 1, files: ["temp3.xls"] }
                ];
    deepEqual(actual, expected);

    var objects = [
        { Date: new Date(2000, 1, 1), Id: 1 },
        { Date: new Date(2000, 1, 1), Id: 2 },
        { Date: new Date(2010, 5, 5), Id: 3 },
        { Date: new Date(2000, 1, 1), Id: 4 },
        { Date: new Date(2010, 5, 5), Id: 5 },
        { Date: new Date(2010, 5, 5), Id: 6 }
    ]
    actual = Enumerable.from(objects)
        .partitionBy("$.Date", "$.Id",
            function (key, group) { return key.getFullYear() + "-" + group.toJoinedString(',') },
            function (key) { return key.toString() })
        .toArray();
    expected = ["2000-1,2", "2010-3", "2000-4", "2010-5,6"]
    deepEqual(actual, expected);
});

test("windowBy", function ()
{
    var rows = [
        { id: 3, value: 30 },
        { id: 1, value: 10 },
        { id: 2, value: 20 }
    ];

    var actual = Enumerable.from(rows)
        .windowBy(
            function () { return "all"; },
            function (row) { return row.id; },
            { preceding: 1, following: 0, requireFullWindow: false },
            function (ctx) {
                return {
                    id: ctx.row.id,
                    windowValues: Enumerable.from(ctx.window).select(function (x) { return x.value; }).toArray()
                };
            })
        .orderBy(function (entry) { return entry.id; })
        .toArray();

    var expected = [
        { id: 1, windowValues: [10] },
        { id: 2, windowValues: [10, 20] },
        { id: 3, windowValues: [20, 30] }
    ];
    deepEqual(actual, expected);

    var sales = [
        { region: "NA", month: 1, total: 10 },
        { region: "NA", month: 2, total: 20 },
        { region: "NA", month: 3, total: 30 },
        { region: "EU", month: 1, total: 5 },
        { region: "EU", month: 2, total: 15 },
        { region: "EU", month: 3, total: 25 }
    ];

    var rolling = Enumerable.from(sales)
        .windowBy(
            function (row) { return row.region; },
            function (row) { return row.month; },
            { preceding: 2, following: 0, requireFullWindow: true },
            function (ctx) {
                return {
                    region: ctx.partitionKey,
                    month: ctx.row.month,
                    sum: Enumerable.from(ctx.window).sum(function (x) { return x.total; })
                };
            })
        .orderBy(function (entry) { return entry.region + "-" + entry.month; })
        .toArray();

    var expectedRolling = [
        { region: "EU", month: 1, sum: 0 },
        { region: "EU", month: 2, sum: 0 },
        { region: "EU", month: 3, sum: 45 },
        { region: "NA", month: 1, sum: 0 },
        { region: "NA", month: 2, sum: 0 },
        { region: "NA", month: 3, sum: 60 }
    ];
    deepEqual(rolling, expectedRolling);
});

test("buffer", function ()
{
    let actual = Enumerable.range(1, 10).buffer("3").toArray();
    let expected = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]];
    deepEqual(actual, expected);
});
