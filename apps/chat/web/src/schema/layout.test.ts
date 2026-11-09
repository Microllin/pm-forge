import { describe, expect, it } from "vitest";

import type { SchemaRelation, SchemaTable } from "./api";
import {
  ALL_LIMIT,
  MAX_PER_COL,
  MAX_ROWS,
  matchTable,
  neighborsOf,
  nodeId,
  schemaLayout,
} from "./layout";

/**
 * ER 图布局是纯函数。要钉住的口径：表多时不一次画全、一跳邻居分左右、
 * 邻居之间的线不画、主键外键优先露出、画面外的关联要计数而不是悄悄不见。
 */

const table = (name: string, fields: string[] = ["id"]): SchemaTable => ({
  name,
  entity: name,
  comment: null,
  source: `/r/${name}.sql`,
  fields: fields.map((f, i) => ({
    name: f,
    type: "int",
    nullable: false,
    flags: i === 0 ? ["主键"] : [],
    comment: null,
  })),
});
const rel = (
  from: string,
  to: string,
  field: string | null,
): SchemaRelation => ({
  from,
  to,
  field,
  kind: "many-to-one",
  label: null,
  source: "x",
});

describe("ER 图布局", () => {
  const tables = [
    table("users"),
    table("orders", ["id", "a", "b", "user_id"]),
    table("payments", ["id", "order_id"]),
    table("coupons"),
  ];
  const relations = [
    rel("orders", "users", "user_id"),
    rel("payments", "orders", "order_id"),
    rel("orders", "coupons", "coupon_id"),
    rel("payments", "users", "payer_id"),
  ];

  it("表不多且没选：画全部", () => {
    const l = schemaLayout(tables, relations, new Set());
    expect(l.mode).toBe("all");
    expect(l.nodes).toHaveLength(4);
    expect(l.edges).toHaveLength(4);
  });

  it("表多且没选：一个都不画，等人选", () => {
    const many = Array.from({ length: ALL_LIMIT + 1 }, (_, i) =>
      table(`t${String(i)}`),
    );
    const l = schemaLayout(many, [], new Set());
    expect(l.mode).toBe("focus");
    expect(l.nodes).toHaveLength(0);
  });

  it("选中后：被指向的在右、指向它的在左；邻居之间不连线", () => {
    const l = schemaLayout(tables, relations, new Set(["orders"]));
    const x = (name: string) =>
      l.nodes.find((n) => n.id === nodeId(name))?.position.x;
    expect(x("payments")).toBeLessThan(x("orders") ?? 0);
    expect(x("users")).toBeGreaterThan(x("orders") ?? 0);
    expect(x("coupons")).toBe(x("users"));
    // payments → users 是两张邻居之间的线：不画。
    expect(l.edges.map((e) => e.id)).not.toContain("payments.payer_id->users");
    expect(l.edges).toHaveLength(3);
  });

  it("节点上主键、外键先露出；超出的计数", () => {
    const wide = table("wide", [
      "id",
      ...Array.from({ length: MAX_ROWS + 2 }, (_, i) => `c${String(i)}`),
    ]);
    wide.fields.push({
      name: "owner_id",
      type: "int",
      nullable: false,
      flags: [],
      comment: null,
    });
    const l = schemaLayout(
      [wide, table("users")],
      [rel("wide", "users", "owner_id")],
      new Set(["wide"]),
    );
    const data = l.nodes.find((n) => n.id === nodeId("wide"))?.data;
    expect(data?.rows.slice(0, 2).map((r) => [r.name, r.key])).toEqual([
      ["id", "pk"],
      ["owner_id", "fk"],
    ]);
    expect(data?.hidden).toBe(wide.fields.length - MAX_ROWS);
  });

  it("连向画面之外的关联要计数", () => {
    const l = schemaLayout(tables, relations, new Set(["payments"]));
    const orders = l.nodes.find((n) => n.id === nodeId("orders"))?.data;
    // orders 连着 coupons（不在画面上）。
    expect(orders?.offscreen).toBe(1);
  });

  it("枢纽表的邻居太多时分成几列，不排成一长条", () => {
    const hub = table("users");
    const many = Array.from({ length: MAX_PER_COL + 3 }, (_, i) =>
      table(`t${String(i).padStart(2, "0")}`),
    );
    const l = schemaLayout(
      [hub, ...many],
      many.map((t) => rel(t.name, "users", "user_id")),
      new Set(["users"]),
    );
    const xs = new Set(l.nodes.map((n) => n.position.x));
    expect(xs.size).toBe(3);
    const hubX = l.nodes.find((n) => n.id === nodeId("users"))?.position.x;
    expect(Math.max(...xs)).toBe(hubX);
  });

  it("两边都沾的邻居放右边，不重复出现", () => {
    const { left, right } = neighborsOf(
      [rel("a", "b", "x"), rel("b", "a", "y")],
      new Set(["a"]),
    );
    expect([...left]).toEqual([]);
    expect([...right]).toEqual(["b"]);
  });

  it("清单搜索认表名、字段名、说明", () => {
    const t = { ...table("orders", ["id", "user_id"]), comment: "订单" };
    expect(matchTable(t, "订单")).toBe(true);
    expect(matchTable(t, "USER_ID")).toBe(true);
    expect(matchTable(t, "refund")).toBe(false);
  });
});
