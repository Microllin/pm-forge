import { describe, expect, it } from "vitest";

import { CODE_ROOT as SERVER_CODE_ROOT } from "./paths.js";
import { CODE_ROOT as WEB_CODE_ROOT } from "../../web/src/files/location.js";

/*
 * 「代码」入口的根在前后端各有一份字面量，两边的注释都写着「必须一致，不然会漂」。
 * 注释不是约束——漂了也没人知道，表现是：服务端在 /代码库 下建目录，
 * 前端却从另一个路径起步，代码入口看起来是空的。
 *
 * 不合并成一份的原因：服务端 paths.ts 依赖 node:path，前端不该把它打进包里。
 * 所以用一条断言把两份钉在一起——漂的那一刻测试就红。
 */
describe("代码入口根路径", () => {
  it("前后端的 CODE_ROOT 必须逐字相同", () => {
    expect(WEB_CODE_ROOT).toBe(SERVER_CODE_ROOT);
  });
});
