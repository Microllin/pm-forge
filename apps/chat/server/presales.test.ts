import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCatalog } from "./presales.js";
import { createPresalesTemplates } from "./presales-templates.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";

/**
 * 售前材料库。
 *
 * 最要紧的一条不是 CRUD，而是**唯一现行版**：同一材料两份「可对外」，
 * 销售就会发错版本——这是本地售前目录里靠人守着的硬规矩，落进库里必须由代码守住。
 */

let db: Db;
let dir: string;
let now: number;
const tick = (): number => {
  now += 1000;
  return now;
};

let templates: ReturnType<typeof createPresalesTemplates>;

function makeLib(kind: "company" | "product" = "product") {
  return createCatalog(db, tick, templates).create(
    kind === "company" ? {} : { productId: makeProduct() },
  );
}

function makeProduct(): string {
  const id = `p-${String(Math.random()).slice(2, 8)}`;
  db.prepare(
    "INSERT INTO product_lines (id, name, description, sort_order, created_at, updated_at) VALUES ('l1', 'L', '', 1, 1, 1)",
  ).run();
  db.prepare(
    `INSERT INTO products (id, line_id, name, description, sort_order, created_at, updated_at)
     VALUES (?, 'l1', ?, '', 1, 1, 1)`,
  ).run(id, id);
  return id;
}

beforeEach(() => {
  db = openDb(IN_MEMORY);
  dir = mkdtempSync(join(tmpdir(), "pmforge-presales-"));
  now = 1_700_000_000_000;
  db.prepare("DELETE FROM products").run();
  db.prepare("DELETE FROM product_lines").run();
  // 出厂模板：建库时按库种类自动取对应的那一套。
  templates = createPresalesTemplates(db, tick);
  templates.seedBuiltins();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("建库与模板", () => {
  it("产品库按「标准售前模板」铺材料：15 类，11 类必备", () => {
    const { lib, slots } = makeLib("product");
    expect(lib.name).toBeTruthy();
    expect(lib.templateName).toBe("标准售前模板");
    expect(slots).toHaveLength(15);
    expect(slots.filter((s) => s.priority)).toHaveLength(11);
    expect(slots.map((s) => s.title)).toContain("产品白皮书");
    // 公司级条目不会混进产品库。
    expect(slots.map((s) => s.title)).not.toContain("公司整体PPT");
  });

  it("公司级库用「公司级材料」那套：6 类", () => {
    const company = makeLib("company");
    expect(company.lib.productId).toBeNull();
    expect(company.slots).toHaveLength(6);
    expect(company.slots.map((s) => s.title)).toContain("公司简介");
  });

  it("槽位带上了模板的检查要点与内外属性", () => {
    const { slots } = makeLib("product");
    const wp = slots.find((s) => s.title === "产品白皮书");
    expect(wp?.audience).toBe("external");
    expect(wp?.checkpoints.length).toBeGreaterThan(2);
    const bottom = slots.find((s) => s.title === "价格底线与折扣政策");
    expect(bottom?.audience).toBe("internal");
  });

  it("同一产品不能建两本库；公司级可以建多本", () => {
    const productId = makeProduct();
    const catalog = createCatalog(db, tick, templates);
    catalog.create({ productId });
    expect(() => catalog.create({ productId })).toThrow(/已经有售前库/);
    expect(() => catalog.create({})).not.toThrow();
    expect(() => catalog.create({})).not.toThrow();
  });

  it("补齐模板只加不删，重复调用返回 0", () => {
    const { lib } = makeLib("product");
    const catalog = createCatalog(db, tick, templates);
    expect(catalog.syncTemplate(lib.id)).toBe(0);

    // 删掉一类（不影响模板），补齐时只补回这一类。
    const first = catalog.get(lib.id)?.slots[0];
    if (first === undefined) throw new Error("没有槽位");
    catalog.removeSlot(first.id);
    expect(catalog.syncTemplate(lib.id)).toBe(1);
  });

  it("模板改了，补齐时按新条目加；已登记的材料不受影响", () => {
    const { lib } = makeLib("product");
    const catalog = createCatalog(db, tick, templates);
    const tpl = templates.byBuiltinKey("product");
    if (tpl === undefined) throw new Error("缺少出厂模板");
    const stage = tpl.stages[0];
    if (stage === undefined) throw new Error("模板没有阶段");
    templates.addItem(stage.id, { name: "选型对照表", required: false });

    expect(catalog.syncTemplate(lib.id)).toBe(1);
    expect(catalog.get(lib.id)?.slots.map((s) => s.title)).toContain(
      "选型对照表",
    );
  });

  it("没绑模板的库不能补模板", () => {
    const { lib } = makeLib("product");
    const catalog = createCatalog(db, tick, templates);
    catalog.setTemplate(lib.id, null);
    expect(() => catalog.syncTemplate(lib.id)).toThrow(/没绑售前模板/);
  });
});

describe("售前模板本身", () => {
  it("出厂模板可改、可复制、可恢复出厂", () => {
    const tpl = templates.byBuiltinKey("product");
    if (tpl === undefined) throw new Error("缺少出厂模板");
    const stage = tpl.stages[0];
    if (stage === undefined) throw new Error("模板没有阶段");

    templates.addItem(stage.id, { name: "临时材料", required: false });
    expect(templates.get(tpl.id).stages[0]?.items.map((i) => i.name)).toContain(
      "临时材料",
    );

    const copy = templates.duplicate(tpl.id);
    expect(copy.builtinKey).toBeNull();
    expect(copy.name).toContain("副本");
    expect(copy.stages.length).toBe(tpl.stages.length);

    const reset = templates.reset(tpl.id);
    expect(reset.stages[0]?.items.map((i) => i.name)).not.toContain("临时材料");
  });

  it("复制出来的模板自动避开重名", () => {
    const tpl = templates.byBuiltinKey("product");
    if (tpl === undefined) throw new Error("缺少出厂模板");
    const a = templates.duplicate(tpl.id);
    const b = templates.duplicate(tpl.id);
    expect(a.name).not.toBe(b.name);
  });

  it("自建模板不能「恢复出厂」", () => {
    const t = templates.create({ name: "我的模板" });
    expect(() => templates.reset(t.id)).toThrow(/出厂模板/);
  });

  it("阶段可增删改、可上下移；材料按阶段归属", () => {
    const t = templates.create({ name: "T" });
    const withStage = templates.addStage(t.id, {
      code: "S1",
      label: "第一层",
      question: "问什么",
    });
    const s1 = withStage.stages[0];
    if (s1 === undefined) throw new Error("没建出阶段");
    templates.addStage(t.id, { code: "S2", label: "第二层" });
    templates.addItem(s1.id, {
      name: "材料甲",
      required: true,
      audience: "internal",
      checkpoints: "要点一\n要点二",
    });

    const read = templates.get(t.id);
    expect(read.stages.map((x) => x.code)).toEqual(["S1", "S2"]);
    const item = read.stages[0]?.items[0];
    expect(item?.audience).toBe("internal");
    expect(item?.checkpoints).toEqual(["要点一", "要点二"]);

    templates.moveStage(s1.id, 1);
    expect(templates.get(t.id).stages.map((x) => x.code)).toEqual(["S2", "S1"]);
  });
});

describe("唯一现行版", () => {
  it("新版本设为可对外，旧现行版自动转归档", () => {
    const { lib, slots } = makeLib("product");
    const slot = slots.find((s) => s.title === "产品白皮书");
    if (slot === undefined) throw new Error("缺少白皮书槽位");
    const catalog = createCatalog(db, tick);

    catalog.addVersion(slot.id, { version: "v1.0", status: "current" });
    catalog.addVersion(slot.id, { version: "v2.0", status: "current" });

    const after = catalog.get(lib.id)?.slots.find((s) => s.id === slot.id);
    expect(after?.current?.version).toBe("v2.0");
    expect(after?.versions.find((v) => v.version === "v1.0")?.status).toBe(
      "archived",
    );
    expect(after?.versions.filter((v) => v.status === "current")).toHaveLength(
      1,
    );
  });

  it("改状态到 current 同样踢掉旧的现行版", () => {
    const { lib, slots } = makeLib("product");
    const slot = slots.find((s) => s.title === "产品介绍PPT");
    if (slot === undefined) throw new Error("缺少 PPT 槽位");
    const catalog = createCatalog(db, tick);
    const v1 = catalog.addVersion(slot.id, {
      version: "v1",
      status: "current",
    });
    const v2 = catalog.addVersion(slot.id, { version: "v2" });

    catalog.setVersionStatus(v2.id, "current");
    const after = catalog.get(lib.id)?.slots.find((s) => s.id === slot.id);
    expect(after?.current?.id).toBe(v2.id);
    expect(after?.versions.find((v) => v.id === v1.id)?.status).toBe(
      "archived",
    );
  });
});

describe("缺口统计", () => {
  it("只补高优先级一类时，重点缺口数相应下降", () => {
    const { lib, slots } = makeLib("product");
    const catalog = createCatalog(db, tick);
    const before = catalog.get(lib.id)?.lib.criticalGapCount ?? 0;
    const slot = slots.find((s) => s.title === "产品白皮书");
    if (slot === undefined) throw new Error("缺少白皮书槽位");
    catalog.addVersion(slot.id, { version: "v1", status: "current" });

    const after = catalog.get(lib.id)?.lib;
    expect(after?.criticalGapCount).toBe(before - 1);
    expect(after?.coveredCount).toBe(1);
  });

  it("有草稿但没现行版算「做了一半」，不算已备", () => {
    const { lib, slots } = makeLib("product");
    const slot = slots.find((s) => s.title === "产品白皮书");
    if (slot === undefined) throw new Error("缺少白皮书槽位");
    const catalog = createCatalog(db, tick);
    catalog.addVersion(slot.id, { version: "v1", status: "draft" });

    const after = catalog.get(lib.id)?.lib;
    expect(after?.coveredCount).toBe(0);
    expect(after?.inProgressCount).toBe(1);
  });
});

describe("产品被删", () => {
  it("库保留，只标 productExists=false", () => {
    const productId = makeProduct();
    const catalog = createCatalog(db, tick, templates);
    const created = catalog.create({ productId });
    expect(created.lib.productExists).toBe(true);

    db.prepare("DELETE FROM products WHERE id = ?").run(productId);
    const after = catalog.get(created.lib.id);
    expect(after).toBeDefined();
    expect(after?.lib.productExists).toBe(false);
    expect(after?.slots).toHaveLength(15);
  });
});

describe("文件", () => {
  it("挂文件后能读回路径与大小；删库把路径交回来供清盘", () => {
    const { lib, slots } = makeLib("product");
    const slot = slots.find((s) => s.title === "产品白皮书");
    if (slot === undefined) throw new Error("缺少白皮书槽位");
    const catalog = createCatalog(db, tick);
    const v = catalog.addVersion(slot.id, { version: "v1" });
    const attached = catalog.attachFile(v.id, {
      path: `/售前/${lib.id}/白皮书.pdf`,
      name: "白皮书.pdf",
      size: 2048,
    });
    expect(attached.fileName).toBe("白皮书.pdf");
    expect(attached.fileSize).toBe(2048);
    expect(attached.libId).toBe(lib.id);

    const paths = catalog.remove(lib.id);
    expect(paths).toEqual([`/售前/${lib.id}/白皮书.pdf`]);
    expect(catalog.get(lib.id)).toBeUndefined();
  });
});

describe("条目", () => {
  it("自定义条目按标题生成 key；同名再建被拒", () => {
    const { lib } = makeLib("product");
    const catalog = createCatalog(db, tick);
    const slot = catalog.addSlot(lib.id, {
      title: "模型资源价格表",
      stage: "proposal",
    });
    expect(slot.itemKey).toBe("模型资源价格表");
    expect(() =>
      catalog.addSlot(lib.id, { title: "模型资源价格表", stage: "proposal" }),
    ).toThrow(/已经有了/);
  });

  it("删条目连带删它的版本", () => {
    const { lib, slots } = makeLib("product");
    const slot = slots.find((s) => s.title === "产品白皮书");
    if (slot === undefined) throw new Error("缺少白皮书槽位");
    const catalog = createCatalog(db, tick);
    catalog.addVersion(slot.id, { version: "v1" });

    catalog.removeSlot(slot.id);
    const after = catalog.get(lib.id);
    expect(after?.slots.find((s) => s.id === slot.id)).toBeUndefined();
    expect(
      db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM presales_versions WHERE slot_id = ?",
        )
        .get(slot.id),
    ).toEqual({ n: 0 });
  });
});
