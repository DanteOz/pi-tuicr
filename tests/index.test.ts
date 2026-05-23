import { expect, test } from "vite-plus/test";
import register from "../src/index.ts";

test("exports pi extension factory", () => {
  expect(typeof register).toBe("function");
});
