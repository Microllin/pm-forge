import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { IN_MEMORY, openDb, type Db } from "../../db.js";
import {
  createFileStore,
  openFilesIndex,
  type FileStore,
} from "../../files/store.js";
import { createKeyStore } from "../../model-config.js";
import { piPaths } from "../../pi/runtime.js";
import { createCatalog } from "../../products.js";
import { createSkillStore } from "../../skills.js";
import { createEvidenceService, type BriefState } from "../index.js";
import { extractKeywords } from "../keywords.js";
import {
  classify,
  createSchemaIndex,
  mergeSqlOnly,
  rankTables,
  schemaBriefFor,
} from "./index.js";
import {
  entDefaultTable,
  parseEntSchemas,
  parsePrismaSchemas,
  parseSqlMigrations,
} from "./parse.js";

/**
 * 数据结构依据。
 *
 * 守的是几条「错了也看不出来」的口径：
 *   ① 三种写法都要认对表、字段、关联方向与一对一 / 多对一 / 多对多；
 *   ② 关联只取代码声明的，绝不按字段名猜；
 *   ③ 认不出来的如实计数，不悄悄丢；
 *   ④ 交给 AI 的只是命中的表，续聊按表去重，不整库塞。
 *
 * 样本都取自真实仓库里出现过的写法，各裁成最小片段。
 */

describe("ent（Go）", () => {
  const user = `package schema
type User struct { ent.Schema }
func (User) Annotations() []schema.Annotation {
	return []schema.Annotation{ entsql.Annotation{Table: "users"} }
}
func (User) Mixin() []ent.Mixin {
	return []ent.Mixin{ mixins.TimeMixin{} }
}
func (User) Fields() []ent.Field {
	return []ent.Field{
		field.String("email").
			MaxLen(255).
			Unique(),
		// 注释里的逗号, 不能把字段切成两半
		field.Enum("role").Values("admin", "member").Default("member").Comment("角色"),
	}
}
func (User) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("subscriptions", UserSubscription.Type),
		edge.To("profile", Profile.Type).Unique(),
		edge.To("groups", Group.Type),
	}
}`;
  // 订阅：多对一指回用户（From 一头带外键字段）。
  const sub = `package schema
// UserSubscription holds the schema definition for the UserSubscription entity.
// 用户订阅：一个用户可以有多份
type UserSubscription struct {
	ent.Schema
}
func (UserSubscription) Fields() []ent.Field {
	priceField := func(name, comment string) ent.Field {
		return field.Float(name).
			Optional().
			SchemaType(map[string]string{dialect.Postgres: "decimal(20,10)"}).
			Comment(comment)
	}
	return []ent.Field{
		field.Int64("user_id"),
		priceField("price", "单价"),
	}
}
func (UserSubscription) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("user", User.Type).
			Ref("subscriptions").
			Field("user_id").
			Unique().
			Required(),
	}
}`;
  const profile = `package schema
type Profile struct { ent.Schema }
func (Profile) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("owner", User.Type).Ref("profile").Field("user_id").Unique(),
	}
}`;
  const group = `package schema
type Group struct { ent.Schema }
func (Group) Edges() []ent.Edge {
	return []ent.Edge{ edge.From("users", User.Type).Ref("groups") }
}`;
  const mixin = `package mixins
type TimeMixin struct { mixin.Schema }
func (TimeMixin) Fields() []ent.Field {
	return []ent.Field{
		field.Time("created_at").Immutable().Default(time.Now),
	}
}`;
  const model = parseEntSchemas([
    { path: "/r/ent/schema/user.go", text: user },
    { path: "/r/ent/schema/user_subscription.go", text: sub },
    { path: "/r/ent/schema/profile.go", text: profile },
    { path: "/r/ent/schema/group.go", text: group },
    { path: "/r/ent/schema/mixins/time.go", text: mixin },
  ]);
  const table = (name: string) => {
    const t = model.tables.find((x) => x.name === name);
    if (t === undefined) throw new Error(`没有表 ${name}`);
    return t;
  };

  it("表名取 Annotation，没有就按 ent 规则推；mixin 字段并进来", () => {
    expect(model.tables.map((t) => t.name).sort()).toEqual([
      "groups",
      "profiles",
      "user_subscriptions",
      "users",
    ]);
    expect(table("users").fields.map((f) => f.name)).toEqual([
      "id",
      "email",
      "role",
      "created_at",
    ]);
    expect(model.unparsed.count).toBe(0);
  });

  it("字段：唯一 / 枚举值 / 默认值 / 注释 / 可空 / Postgres 类型", () => {
    const [, email, role, created] = table("users").fields;
    expect(email?.flags).toContain("唯一");
    expect(role?.type).toBe("enum(admin | member)");
    expect(role?.comment).toBe("角色");
    expect(role?.flags).toContain('默认 "member"');
    expect(created?.flags).toContain("创建后不可改");
  });

  it("Fields() 里就地定义的字段模板展开成真字段", () => {
    const price = table("user_subscriptions").fields.find(
      (f) => f.name === "price",
    );
    expect(price).toMatchObject({
      type: "decimal(20,10)",
      nullable: true,
      comment: "单价",
    });
  });

  it("表说明取结构体上的注释，去掉 ent 生成器的套话", () => {
    expect(table("user_subscriptions").comment).toBe(
      "用户订阅：一个用户可以有多份",
    );
  });

  it("关联：To/From 两头合成一条，方向统一为「外键所在表 → 被指向表」", () => {
    const rels = model.relations.map((r) => [r.from, r.to, r.field, r.kind]);
    expect(rels).toContainEqual([
      "user_subscriptions",
      "users",
      "user_id",
      "many-to-one",
    ]);
    // To 一头 Unique + From 一头 Unique = 一对一。
    expect(rels).toContainEqual(["profiles", "users", "user_id", "one-to-one"]);
    // 两头都不 Unique = 多对多。
    expect(rels).toContainEqual(["groups", "users", null, "many-to-many"]);
    expect(model.relations).toHaveLength(3);
  });

  it("缺 mixin 定义时如实报，不悄悄少字段", () => {
    const m = parseEntSchemas([{ path: "/r/ent/schema/user.go", text: user }]);
    expect(m.unparsed.count).toBe(1);
    expect(m.unparsed.samples[0]).toContain("TimeMixin");
  });

  it("默认表名：蛇形 + 复数", () => {
    expect(entDefaultTable("APIKey")).toBe("api_keys");
    expect(entDefaultTable("Proxy")).toBe("proxies");
    expect(entDefaultTable("TLSFingerprintProfile")).toBe(
      "tls_fingerprint_profiles",
    );
  });
});

describe("Prisma", () => {
  const text = `
/// 角色
model Role {
  id    Int    @id @default(autoincrement())
  code  String @unique
  users User[]
  @@map("role")
}

/// 平台用户
model User {
  id     Int     @id @default(autoincrement())
  /// bcrypt 哈希
  passwordHash String @map("password_hash")
  /**
   * 首次登录强制改密
   */
  mustChange Boolean @default(false) @map("must_change") // 改密后置 false
  roleId Int     @map("role_id")
  role   Role    @relation(fields: [roleId], references: [id])
  profile Profile?
  tags   Tag[]
  @@map("user")
}

model Profile {
  id     Int  @id
  userId Int  @unique @map("user_id")
  user   User @relation(fields: [userId], references: [id])
}

model Tag {
  id    Int    @id
  users User[]
}
`;
  const model = parsePrismaSchemas([{ path: "/r/prisma/schema.prisma", text }]);

  it("表名取 @@map，字段名取 @map；三种注释写法都收", () => {
    const user = model.tables.find((t) => t.entity === "User");
    expect(user?.name).toBe("user");
    expect(user?.comment).toBe("平台用户");
    expect(user?.fields.map((f) => f.name)).toEqual([
      "id",
      "password_hash",
      "must_change",
      "role_id",
    ]);
    expect(user?.fields[1]?.comment).toBe("bcrypt 哈希");
    expect(user?.fields[2]?.comment).toBe("首次登录强制改密；改密后置 false");
    expect(model.unparsed.count).toBe(0);
  });

  it("关联：带 fields 的一头是多对一；对方不是列表就是一对一；隐式多对多记一次", () => {
    const rels = model.relations.map((r) => [r.from, r.to, r.field, r.kind]);
    expect(rels).toContainEqual(["user", "role", "role_id", "many-to-one"]);
    expect(rels).toContainEqual(["Profile", "user", "user_id", "one-to-one"]);
    expect(rels.filter((r) => r[3] === "many-to-many")).toEqual([
      ["Tag", "user", null, "many-to-many"],
    ]);
  });
});

describe("SQL 迁移脚本", () => {
  const files = [
    {
      path: "/r/migrations/001_init.sql",
      text: `
-- 注释里的分号; 不切
CREATE TABLE IF NOT EXISTS public.users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name text DEFAULT 'a,b' NOT NULL
);
CREATE TABLE orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id bigint REFERENCES users(id) ON DELETE CASCADE,
  amount numeric(20, 2),
  CONSTRAINT orders_pkey PRIMARY KEY (id)
);
CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN; END; $$ LANGUAGE plpgsql;
CREATE INDEX idx ON orders(user_id);
COMMENT ON TABLE orders IS '订单';
`,
    },
    {
      path: "/r/migrations/002_more.sql",
      text: `
ALTER TABLE ONLY orders ADD COLUMN IF NOT EXISTS coupon_id bigint;
ALTER TABLE orders ADD CONSTRAINT fk_coupon FOREIGN KEY (coupon_id) REFERENCES coupons(id);
CREATE TABLE coupons (id bigint PRIMARY KEY, code text);
ALTER TABLE orders ADD CONSTRAINT fk_coupon2 FOREIGN KEY (coupon_id) REFERENCES coupons(id);
ALTER TABLE orders RENAME COLUMN amount TO total;
ALTER TABLE orders ALTER COLUMN total SET NOT NULL;
ALTER TABLE users DROP COLUMN name;
CREATE TABLE tmp (id int);
DROP TABLE IF EXISTS tmp;
ALTER TABLE orders FROBNICATE;
`,
    },
  ];
  const model = parseSqlMigrations(files);
  const orders = model.tables.find((t) => t.name === "orders");

  it("按顺序重放：建表、加列、改名、改约束、删列、删表", () => {
    expect(model.tables.map((t) => t.name).sort()).toEqual([
      "coupons",
      "orders",
      "users",
    ]);
    expect(orders?.fields.map((f) => f.name)).toEqual([
      "id",
      "user_id",
      "total",
      "coupon_id",
    ]);
    expect(orders?.fields.find((f) => f.name === "total")?.nullable).toBe(
      false,
    );
    expect(orders?.fields[0]?.flags).toContain("主键");
    expect(orders?.comment).toBe("订单");
    expect(
      model.tables.find((t) => t.name === "users")?.fields.map((f) => f.name),
    ).toEqual(["id", "email"]);
  });

  it("列定义：类型带括号与逗号、字符串默认值里的逗号都不切错", () => {
    const amount = orders?.fields.find((f) => f.name === "total");
    expect(amount?.type).toBe("numeric(20, 2)");
  });

  it("外键：列上的 REFERENCES 与表约束 FOREIGN KEY 都认；指向不存在的表不画", () => {
    const rels = model.relations.map((r) => [r.from, r.to, r.field]);
    expect(rels).toContainEqual(["orders", "users", "user_id"]);
    expect(rels).toContainEqual(["orders", "coupons", "coupon_id"]);
    expect(rels).toHaveLength(2);
  });

  it("认不出的 ALTER 如实计数；函数体、索引这类与结构无关的不算", () => {
    expect(model.unparsed.count).toBe(1);
    expect(model.unparsed.samples[0]).toContain("FROBNICATE");
  });
});

describe("子系统划分", () => {
  it("按定义文件位置划分，去掉 backend / prisma 这类壳目录；测试与依赖目录不算", () => {
    const c = "/代码库/R";
    expect(classify("/代码库/R/apps/a/backend/ent/schema/user.go", c)).toEqual({
      root: "/代码库/R/apps/a",
      format: "ent",
      path: "/代码库/R/apps/a/backend/ent/schema/user.go",
    });
    expect(classify("/代码库/R/apps/b/prisma/schema.prisma", c)?.root).toBe(
      "/代码库/R/apps/b",
    );
    expect(
      classify("/代码库/R/apps/b/prisma/migrations/0_init/migration.sql", c)
        ?.root,
    ).toBe("/代码库/R/apps/b");
    expect(
      classify("/代码库/R/apps/a/backend/ent/schema/user_test.go", c),
    ).toBeNull();
    expect(classify("/代码库/R/node_modules/x/migrations/1.sql", c)).toBeNull();
    expect(classify("/代码库/R/_archive/migrations/1.sql", c)).toBeNull();
    expect(classify("/代码库/R/scripts/seed.sql", c)).toBeNull();
  });

  it("定义之外只在迁移脚本里建的表并进来；同名表以定义为准", () => {
    const ent = parseEntSchemas([
      {
        path: "a.go",
        text: `type User struct { ent.Schema }
func (User) Annotations() []schema.Annotation { return []schema.Annotation{ entsql.Annotation{Table: "users"} } }`,
      },
    ]);
    const sql = parseSqlMigrations([
      {
        path: "1.sql",
        text: "CREATE TABLE users (id int, legacy text); CREATE TABLE logs (id int, user_id int REFERENCES users(id));",
      },
    ]);
    const merged = mergeSqlOnly(ent, sql);
    expect(merged.tables.map((t) => t.name)).toEqual(["users", "logs"]);
    expect(merged.tables[0]?.fields.map((f) => f.name)).toEqual(["id"]);
    expect(merged.relations).toHaveLength(1);
  });
});

describe("按任务挑表", () => {
  const model = parseSqlMigrations([
    {
      path: "/r/migrations/1.sql",
      text: `
CREATE TABLE users (id int PRIMARY KEY, email text);
CREATE TABLE user_subscriptions (id int, user_id int REFERENCES users(id), plan_id int REFERENCES subscription_plans(id));
CREATE TABLE subscription_plans (id int PRIMARY KEY, price numeric);
CREATE TABLE system_config (id int, value text);
COMMENT ON COLUMN system_config.value IS '各种配置';
`,
    },
  ]);
  const sub = {
    root: "/代码库/R/apps/a",
    label: "apps/a",
    format: "sql" as const,
    alsoHas: [],
    files: 1,
    model,
  };

  it("中文业务词按词表翻成表名里的英文写法", () => {
    const hits = rankTables(
      model.tables,
      extractKeywords("写一份订阅续费的 PRD"),
    );
    expect(hits.map((h) => h.table.name).sort()).toEqual([
      "subscription_plans",
      "user_subscriptions",
    ]);
  });

  it("中文二元组碎片不去撞字段注释（「配置」到处都有）", () => {
    expect(
      rankTables(model.tables, extractKeywords("帮我看看怎么配置的")),
    ).toEqual([]);
  });

  it("摘要只展开命中的表，一跳邻居只列名字；续聊已给过的表不再给", () => {
    const kw = extractKeywords("订阅套餐的价格");
    const brief = schemaBriefFor(sub, kw, undefined);
    expect(brief?.content).toContain("## subscription_plans");
    expect(brief?.content).toContain("- users（2 个字段");
    expect(brief?.content).not.toContain("## users");
    expect(brief?.content).not.toContain("system_config");
    expect(brief?.covers).toContain(
      "/代码库/R/apps/a#数据结构/subscription_plans",
    );

    const again = schemaBriefFor(sub, kw, new Set(brief?.covers ?? []));
    expect(again).toBeNull();
  });
});

/* ── 接进定位器与接口 ─────────────────────────────────────────────── */

let dir: string;
let files: FileStore;
let index: Db;
let db: Db;

function write(path: string, body: string): void {
  const abs = join(files.root, ...path.split("/").filter(Boolean));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-schema-")));
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  files = createFileStore(join(dir, "files"), index);
});

afterEach(() => {
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed(): Promise<string> {
  write(
    "/代码库/R/apps/billing/backend/migrations/001.sql",
    `CREATE TABLE subscription_plans (id int PRIMARY KEY, price numeric);
COMMENT ON TABLE subscription_plans IS '订阅套餐';`,
  );
  write("/代码库/R/apps/billing/backend/main.go", "package main\n");
  await files.reindex();
  const catalog = createCatalog(db);
  const line = catalog.createLine({ name: "线" });
  return catalog.createProduct(line.id, { name: "P", codePath: "/代码库/R" })
    .id;
}

describe("接进事实依据", () => {
  it("对话依据段里带上命中的数据结构；续聊同一张表不重复给", async () => {
    const productId = await seed();
    const svc = createEvidenceService({ files, catalog: createCatalog(db) });
    const state: BriefState = { first: true, given: new Set() };
    const text = await svc.brief({ productId }, "写一份订阅套餐的 PRD", state);
    expect(text).toContain("/代码库/R/apps/billing#数据结构");
    expect(text).toContain("## subscription_plans");
    expect(text).toContain("说明：订阅套餐");

    const again = await svc.brief(
      { productId },
      "订阅套餐还要补充一下价格字段",
      state,
    );
    expect(again ?? "").not.toContain("## subscription_plans");
  });

  it("代码更新后重新解析（按文件数与修改时间作指纹，不用手动刷新）", async () => {
    await seed();
    const idx = createSchemaIndex(files);
    const first = await idx.subsystems("/代码库/R");
    expect(first[0]?.model.tables).toHaveLength(1);
    write(
      "/代码库/R/apps/billing/backend/migrations/002.sql",
      "CREATE TABLE orders (id int);",
    );
    await files.reindex();
    const second = await idx.subsystems("/代码库/R");
    expect(second[0]?.model.tables.map((t) => t.name)).toEqual([
      "subscription_plans",
      "orders",
    ]);
  });
});

describe("接口：产品 → 数据结构", () => {
  it("先列子系统，再按子系统取整张图；只认该产品代码目录下的子系统", async () => {
    const productId = await seed();
    const { app } = createApp({
      auth: false,
      db,
      paths: piPaths(dir),
      keys: createKeyStore(dir, {}),
      skills: createSkillStore({
        dir: join(dir, "skills"),
        targetDirs: {
          pi: join(dir, "t", "pi"),
        },
      }),
      files,
      security: false,
    });
    try {
      const list = await app.inject({
        method: "GET",
        url: `/api/products/${productId}/schema`,
      });
      expect(list.statusCode).toBe(200);
      const body = list.json<{
        subsystems: { root: string; label: string; tables: number }[];
      }>();
      expect(body.subsystems).toEqual([
        expect.objectContaining({
          root: "/代码库/R/apps/billing",
          label: "apps/billing",
          tables: 1,
        }),
      ]);

      const detail = await app.inject({
        method: "GET",
        url: `/api/products/${productId}/schema/tables?root=${encodeURIComponent("/代码库/R/apps/billing")}`,
      });
      expect(detail.statusCode).toBe(200);
      expect(
        detail.json<{ tableList: { name: string }[] }>().tableList[0]?.name,
      ).toBe("subscription_plans");

      const outside = await app.inject({
        method: "GET",
        url: `/api/products/${productId}/schema/tables?root=${encodeURIComponent("/别的目录")}`,
      });
      expect(outside.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
