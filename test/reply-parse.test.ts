// The tolerant reply parser (src/reply-parse.ts): typed replies are the fallback on every channel — the matrix
// below is the protocol: keys, lists (half/full-width), echoed labels, unique fragments; never a guess.
import { describe, expect, test } from "bun:test";
import { asciiFold, choice, parseChoice } from "../src/reply-parse";
import type { CardOption } from "../src/server";

const opt = (key: string, label: string, extra: Partial<CardOption> = {}): CardOption => ({ key, label, ...extra });
const DECISION = [opt("A", "A: merge now", { recommended: true }), opt("B", "B: wait"), opt("C", "C: 改完再合")];
const MENU = [opt("1", "1. 修 bug"), opt("2", "2. 写文档"), opt("3", "3. 升级依赖"), opt("all", "all（全做）"), opt("none", "none（都不做）")];

test("exact keys: letters, digits, case and full-width shapes", () => {
  expect(parseChoice("A", DECISION)).toEqual({ choice: "A", how: "key" });
  expect(parseChoice("a", DECISION)).toEqual({ choice: "A", how: "key" });
  expect(parseChoice(" ｂ ", DECISION)).toEqual({ choice: "B", how: "key" }); // full-width letter + spaces
  expect(parseChoice("2", MENU)).toEqual({ choice: "2", how: "key" });
  expect(parseChoice("all", MENU)).toEqual({ choice: "all", how: "key" });
  expect(parseChoice("NONE", MENU)).toEqual({ choice: "none", how: "key" });
});

test("key lists with half-width, full-width and CJK commas", () => {
  expect(parseChoice("1,3", MENU)).toEqual({ choice: "1,3", how: "key" });
  expect(parseChoice("1，3", MENU)).toEqual({ choice: "1,3", how: "key" });
  expect(parseChoice("1、 3", MENU)).toEqual({ choice: "1,3", how: "key" });
  expect(parseChoice("１，３", MENU)).toEqual({ choice: "1,3", how: "key" });
  expect(parseChoice("1, 2, 3", MENU)).toEqual({ choice: "1,2,3", how: "key" });
  // one bad key in the list: not a choice, not a guess
  expect("unrecognized" in parseChoice("1,9", MENU)).toBe(true);
});

test("echoed labels: with or without the key prefix", () => {
  expect(parseChoice("B: wait", DECISION)).toEqual({ choice: "B", how: "label" });
  expect(parseChoice("B：wait", DECISION)).toEqual({ choice: "B", how: "label" });
  expect(parseChoice("wait", DECISION)).toEqual({ choice: "B", how: "label" });
  expect(parseChoice("修 bug", MENU)).toEqual({ choice: "1", how: "label" });
  expect(parseChoice("A: merge now", DECISION)).toEqual({ choice: "A", how: "label" }); // an exact label echo
});

test("a fragment lands in exactly one label; two or zero hits are not a guess", () => {
  expect(parseChoice("先 wait 一下", DECISION)).toEqual({ choice: "B", how: "fragment" }); // contains "wait" only
  const zh = [opt("A", "A: 直接合并"), opt("B", "B: 先等等")];
  expect(parseChoice("就先等等", zh)).toEqual({ choice: "B", how: "fragment" }); // contains "先等等" only
  const two = [opt("A", "A: 等一下"), opt("B", "B: 再等等")];
  expect("unrecognized" in parseChoice("等", two)).toBe(true); // both labels contain it: ambiguous
  expect("unrecognized" in parseChoice("合并吧", DECISION)).toBe(true); // no label inside
});

test("hostile or degenerate option data never throws and never guesses", () => {
  // a key with regex metacharacters must not blow up the parser (options_json is file data, not trusted)
  const weird = [opt("A(", "A( 特殊"), opt("B)", "B) 普通")];
  expect(() => parseChoice("A(", weird)).not.toThrow();
  expect(parseChoice("A(", weird)).toEqual({ choice: "A(", how: "key" });
  expect(parseChoice("特殊", weird)).toEqual({ choice: "A(", how: "label" }); // the exact stripped label is a deliberate echo
  // identical stripped labels: the echo is ambiguous, not "the first one"
  const dup = [opt("A", "合"), opt("B", "合")];
  expect("unrecognized" in parseChoice("合", dup)).toBe(true);
});

test("trailing sentence punctuation is never part of an answer", () => {
  expect(parseChoice("B。", DECISION)).toEqual({ choice: "B", how: "key" });
  expect(parseChoice("B：", DECISION)).toEqual({ choice: "B", how: "key" });
  expect(parseChoice("1，3。", MENU)).toEqual({ choice: "1,3", how: "key" });
  expect(parseChoice("wait。", DECISION)).toEqual({ choice: "B", how: "label" });
});

test("free-form instructions and empty replies are unrecognized, carrying the words", () => {
  expect(parseChoice("先按 B 来，但把测试改成只跑单测", DECISION)).toEqual({ unrecognized: "先按 B 来，但把测试改成只跑单测" });
  expect(parseChoice("不要", DECISION)).toEqual({ unrecognized: "不要" }); // no unique label hit
  expect(parseChoice("", DECISION)).toEqual({ unrecognized: "" });
});

test("choice() stays the scorer's normalizer", () => {
  expect(choice("B: wait")).toBe("B");
  expect(choice(" 1, 3 ")).toBe("1,3");
  expect(choice("Approve it")).toBe("approve it");
  expect(choice(undefined)).toBe("");
  expect(choice("１")).toBe("1"); // full-width digit from the model normalizes like its ASCII shape
  expect(choice("Ｂ: merge")).toBe("B");
});

test("asciiFold is the shared full-width collapse", () => {
  expect(asciiFold("Ｂ：等一下")).toBe("B:等一下");
  expect(asciiFold("１２３")).toBe("123");
});
