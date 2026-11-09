/**
 * 数据结构依据：从代码里读出「有哪些表、每张表有哪些字段、表与表怎么关联」。
 *
 * 只读代码，不连数据库：
 * 不要账号、碰不到业务数据，代码库更新后重读即可。
 *
 * 认三种写法，都是**纯文本解析**（不跑 Go / Prisma 工具链）：
 * - ent（Go）：`ent/schema/*.go` 的 `Fields()` / `Edges()` / `Mixin()`；
 * - Prisma：`*.prisma` 的 `model`；
 * - SQL 迁移脚本：按文件名顺序重放 CREATE / ALTER / DROP。
 *
 * 关联**只取代码里声明的**（ent 的 Edges、Prisma 的 `@relation`、SQL 的 `REFERENCES`），
 * 不按字段名猜——与方法论「不用推断补位」一致。认不出的写法不跳过，计数报出来。
 */

export type SchemaFormat = "ent" | "prisma" | "sql";

export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
  /** 主键 / 唯一 / 默认值等，给人看的短标签。 */
  flags: string[];
  comment: string | null;
}

export interface SchemaTable {
  /** 表在库里的名字（ent 的 Annotation、Prisma 的 @@map；没有就按约定推）。 */
  name: string;
  /** 代码里的实体名（ent / Prisma 的 model 名）；SQL 里与 name 相同。 */
  entity: string;
  comment: string | null;
  fields: SchemaField[];
  /** 定义它的源文件（文件库路径）。 */
  source: string;
}

export interface SchemaRelation {
  from: string;
  to: string;
  /** from 上的外键字段；ent 的 O2M / M2M 没有字段时为 null。 */
  field: string | null;
  /** 从 from 看：many-to-one / one-to-one / many-to-many。 */
  kind: "many-to-one" | "one-to-one" | "many-to-many";
  label: string | null;
  source: string;
}

export interface SchemaModel {
  format: SchemaFormat;
  tables: SchemaTable[];
  relations: SchemaRelation[];
  /** 认不出的语句 / 块，计数并给出前几处位置。 */
  unparsed: { count: number; samples: string[] };
}

export interface SourceText {
  path: string;
  text: string;
}

const MAX_SAMPLES = 5;

function unparsedBag(): {
  add: (where: string) => void;
  done: () => SchemaModel["unparsed"];
} {
  let count = 0;
  const samples: string[] = [];
  return {
    add(where) {
      count += 1;
      if (samples.length < MAX_SAMPLES) samples.push(where);
    },
    done: () => ({ count, samples }),
  };
}

/** 去掉 SQL 的 `--` 行注释与块注释，保留字符串字面量里的内容。 */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'") {
      const end = sql.indexOf("'", i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += c ?? "";
      i += 1;
    }
  }
  return out;
}

/** 按顶层分号切语句；`$$ … $$` 函数体与字符串里的分号不切。 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let dollar: string | null = null;
  while (i < sql.length) {
    const c = sql[i] ?? "";
    if (dollar !== null) {
      if (sql.startsWith(dollar, i)) {
        buf += dollar;
        i += dollar.length;
        dollar = null;
      } else {
        buf += c;
        i += 1;
      }
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m !== null) {
        dollar = m[0];
        buf += dollar;
        i += dollar.length;
        continue;
      }
    }
    if (c === "'") {
      const end = sql.indexOf("'", i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ";") {
      if (buf.trim() !== "") out.push(buf.trim());
      buf = "";
    } else buf += c;
    i += 1;
  }
  if (buf.trim() !== "") out.push(buf.trim());
  return out;
}

/** 按顶层逗号切（括号里的逗号不切），用于列定义与参数列表。 */
function splitTopLevel(text: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  let quote: string | null = null;
  for (const c of text) {
    if (quote !== null) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    if (c === sep && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else buf += c;
  }
  if (buf.trim() !== "") out.push(buf.trim());
  return out;
}

/** 从 `(` 位置起找到配对的 `)`，返回括号内文本与结束位置。 */
function balanced(
  text: string,
  open: number,
  pair: [string, string] = ["(", ")"],
): { inner: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "`" || (pair[0] === "(" && c === "'")) {
      quote = c;
      continue;
    }
    if (c === pair[0]) depth += 1;
    else if (c === pair[1]) {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** 去掉 schema 前缀与引号：`sechub."users"` → `users`。 */
function bareName(raw: string): string {
  const last = raw.trim().split(".").pop() ?? raw;
  return last.replace(/^["`[]|["`\]]$/g, "");
}

// ─────────────────────────── SQL ───────────────────────────

const SQL_CONSTRAINT_START =
  /^(constraint\s+\S+\s+)?(primary\s+key|foreign\s+key|unique|check|exclude)\b/i;

interface SqlColumnParse {
  field: SchemaField;
  ref: { table: string } | null;
}

function parseSqlColumn(def: string): SqlColumnParse | null {
  const m = /^("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s+(.+)$/s.exec(def.trim());
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const name = bareName(m[1]);
  const rest = m[2].replace(/\s+/g, " ").trim();
  // 类型到第一个约束关键字为止。
  const typeEnd = rest.search(
    /\s(not\s+null|null|default|primary\s+key|unique|references|check|constraint|generated|collate)\b/i,
  );
  const type = (typeEnd === -1 ? rest : rest.slice(0, typeEnd)).trim();
  const tail = typeEnd === -1 ? "" : rest.slice(typeEnd);
  const flags: string[] = [];
  const primary = /primary\s+key/i.test(tail);
  if (primary) flags.push("主键");
  if (/\bunique\b/i.test(tail)) flags.push("唯一");
  const dflt =
    /\bdefault\s+((?:'[^']*'|\([^)]*\)|[^\s,]+)(?:\s*::\s*[\w ]+)?)/i.exec(
      tail,
    );
  if (dflt?.[1] !== undefined) flags.push(`默认 ${dflt[1].trim()}`);
  const ref = /\breferences\s+([\w."`]+)/i.exec(tail);
  return {
    field: {
      name,
      type,
      nullable: !primary && !/not\s+null/i.test(tail),
      flags,
      comment: null,
    },
    ref: ref?.[1] === undefined ? null : { table: bareName(ref[1]) },
  };
}

/**
 * 重放 SQL 迁移脚本，得到最终的表结构。
 *
 * 调用方按执行顺序传入（通常就是文件名顺序）。只认影响结构的语句：
 * CREATE TABLE / ALTER TABLE（加删改列、改名、加外键与主键）/ DROP TABLE / COMMENT ON。
 * 其余（索引、数据、函数、权限）与结构无关，不算「没认出来」。
 */
export function parseSqlMigrations(files: readonly SourceText[]): SchemaModel {
  const tables = new Map<string, SchemaTable>();
  const fks = new Map<string, SchemaRelation>();
  const bad = unparsedBag();
  const fkKey = (from: string, field: string): string => `${from}.${field}`;
  const addFk = (
    from: string,
    field: string,
    to: string,
    source: string,
  ): void => {
    fks.set(fkKey(from, field), {
      from,
      to,
      field,
      kind: "many-to-one",
      label: null,
      source,
    });
  };

  for (const file of files) {
    for (const stmt of splitStatements(stripSqlComments(file.text))) {
      const flat = stmt.replace(/\s+/g, " ");
      const where = `${file.path}：${flat.slice(0, 60)}`;

      const create =
        /^create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."`]+)\s*\(/i.exec(
          stmt,
        );
      if (create?.[1] !== undefined) {
        const name = bareName(create[1]);
        const body = balanced(stmt, create[0].length - 1);
        if (body === null) {
          bad.add(where);
          continue;
        }
        const table: SchemaTable = {
          name,
          entity: name,
          comment: null,
          fields: [],
          source: file.path,
        };
        for (const def of splitTopLevel(body.inner)) {
          if (def === "") continue;
          if (SQL_CONSTRAINT_START.test(def)) {
            applyTableConstraint(def, name, table, file.path);
            continue;
          }
          if (/^like\s/i.test(def)) {
            bad.add(where);
            continue;
          }
          const col = parseSqlColumn(def);
          if (col === null) {
            bad.add(`${file.path}：${def.slice(0, 60)}`);
            continue;
          }
          table.fields.push(col.field);
          if (col.ref !== null)
            addFk(name, col.field.name, col.ref.table, file.path);
        }
        tables.set(name, table);
        continue;
      }

      const alter =
        /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."`]+)\s+(.+)$/is.exec(
          stmt,
        );
      if (alter?.[1] !== undefined && alter[2] !== undefined) {
        const name = bareName(alter[1]);
        const table = tables.get(name);
        for (const action of splitTopLevel(alter[2])) {
          if (!applyAlter(action, name, table, file.path)) {
            // 表不在已知表里（如对视图 / 别的库的表操作）不算语法没认出来。
            if (table !== undefined)
              bad.add(`${file.path}：${action.slice(0, 60)}`);
          }
        }
        continue;
      }

      const drop =
        /^drop\s+table\s+(?:if\s+exists\s+)?(.+?)(?:\s+cascade|\s+restrict)?$/is.exec(
          flat,
        );
      if (drop?.[1] !== undefined) {
        for (const raw of drop[1].split(",")) {
          const name = bareName(raw);
          tables.delete(name);
          for (const [k, r] of fks)
            if (r.from === name || r.to === name) fks.delete(k);
        }
        continue;
      }

      const comment =
        /^comment\s+on\s+(table|column)\s+([\w."`]+)\s+is\s+'((?:[^']|'')*)'/is.exec(
          stmt,
        );
      if (comment?.[1] !== undefined && comment[2] !== undefined) {
        const text = (comment[3] ?? "").replace(/''/g, "'");
        const parts = comment[2].split(".").map((p) => bareName(p));
        if (comment[1].toLowerCase() === "table") {
          const t = tables.get(parts[parts.length - 1] ?? "");
          if (t !== undefined) t.comment = text;
        } else {
          const col = parts[parts.length - 1] ?? "";
          const t = tables.get(parts[parts.length - 2] ?? "");
          const f = t?.fields.find((x) => x.name === col);
          if (f !== undefined) f.comment = text;
        }
        continue;
      }
      // 其余语句与表结构无关。
    }
  }

  // 外键列本身是唯一的 → 一对一。
  const relations = [...fks.values()].filter(
    (r) => tables.has(r.from) && tables.has(r.to),
  );
  for (const r of relations) {
    const f = tables.get(r.from)?.fields.find((x) => x.name === r.field);
    if (f?.flags.includes("唯一") === true) r.kind = "one-to-one";
  }
  return {
    format: "sql",
    tables: [...tables.values()],
    relations,
    unparsed: bad.done(),
  };

  function applyTableConstraint(
    def: string,
    name: string,
    table: SchemaTable,
    source: string,
  ): void {
    const flat = def.replace(/\s+/g, " ");
    const fk = /foreign\s+key\s*\(([^)]+)\)\s*references\s+([\w."`]+)/i.exec(
      flat,
    );
    if (fk?.[1] !== undefined && fk[2] !== undefined) {
      const cols = fk[1].split(",").map((c) => bareName(c));
      // 复合外键：挂在第一列上，标签写全。
      const first = cols[0];
      if (first !== undefined) addFk(name, first, bareName(fk[2]), source);
      return;
    }
    const pk = /primary\s+key\s*\(([^)]+)\)/i.exec(flat);
    if (pk?.[1] !== undefined) {
      for (const c of pk[1].split(",").map((x) => bareName(x))) {
        const f = table.fields.find((x) => x.name === c);
        if (f !== undefined && !f.flags.includes("主键")) {
          f.flags.unshift("主键");
          f.nullable = false;
        }
      }
      return;
    }
    const uq = /^(?:constraint\s+\S+\s+)?unique\s*\(([^)]+)\)/i.exec(flat);
    if (uq?.[1] !== undefined) {
      const cols = uq[1].split(",").map((x) => bareName(x));
      const only = cols.length === 1 ? cols[0] : undefined;
      const f = table.fields.find((x) => x.name === only);
      if (f !== undefined && !f.flags.includes("唯一")) f.flags.push("唯一");
    }
  }

  /** 返回 false 表示这个动作没认出来。 */
  function applyAlter(
    action: string,
    name: string,
    table: SchemaTable | undefined,
    source: string,
  ): boolean {
    const flat = action.replace(/\s+/g, " ").trim();
    if (table === undefined) return false;

    const add = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(.+)$/is.exec(
      flat,
    );
    if (
      add?.[1] !== undefined &&
      !/^add\s+(constraint|primary|foreign|unique|check)\b/i.test(flat)
    ) {
      const col = parseSqlColumn(add[1]);
      if (col === null) return false;
      const at = table.fields.findIndex((f) => f.name === col.field.name);
      if (at === -1) table.fields.push(col.field);
      else table.fields[at] = col.field;
      if (col.ref !== null) addFk(name, col.field.name, col.ref.table, source);
      return true;
    }
    const addConstraint = /^add\s+(.+)$/i.exec(flat);
    if (addConstraint?.[1] !== undefined) {
      applyTableConstraint(addConstraint[1], name, table, source);
      return true;
    }
    const dropCol = /^drop\s+(?:column\s+)?(?:if\s+exists\s+)?([\w"`]+)/i.exec(
      flat,
    );
    if (dropCol?.[1] !== undefined && !/^drop\s+constraint\b/i.test(flat)) {
      const col = bareName(dropCol[1]);
      table.fields = table.fields.filter((f) => f.name !== col);
      fks.delete(fkKey(name, col));
      return true;
    }
    if (/^drop\s+constraint\b/i.test(flat)) return true;
    const renameCol =
      /^rename\s+(?:column\s+)?([\w"`]+)\s+to\s+([\w"`]+)/i.exec(flat);
    if (
      renameCol?.[1] !== undefined &&
      renameCol[2] !== undefined &&
      !/^rename\s+to\b/i.test(flat)
    ) {
      const from = bareName(renameCol[1]);
      const to = bareName(renameCol[2]);
      const f = table.fields.find((x) => x.name === from);
      if (f !== undefined) f.name = to;
      const fk = fks.get(fkKey(name, from));
      if (fk !== undefined) {
        fks.delete(fkKey(name, from));
        fks.set(fkKey(name, to), { ...fk, field: to });
      }
      return true;
    }
    const renameTable = /^rename\s+to\s+([\w."`]+)/i.exec(flat);
    if (renameTable?.[1] !== undefined) {
      const to = bareName(renameTable[1]);
      tables.delete(name);
      table.name = to;
      table.entity = to;
      tables.set(to, table);
      for (const [k, r] of [...fks]) {
        if (r.from === name || r.to === name) {
          fks.delete(k);
          const moved = {
            ...r,
            from: r.from === name ? to : r.from,
            to: r.to === name ? to : r.to,
          };
          fks.set(fkKey(moved.from, moved.field ?? ""), moved);
        }
      }
      return true;
    }
    const alterCol = /^alter\s+(?:column\s+)?([\w"`]+)\s+(.+)$/i.exec(flat);
    if (alterCol?.[1] !== undefined && alterCol[2] !== undefined) {
      const f = table.fields.find(
        (x) => x.name === bareName(alterCol[1] ?? ""),
      );
      const what = alterCol[2];
      if (f !== undefined) {
        if (/^set\s+not\s+null/i.test(what)) f.nullable = false;
        else if (/^drop\s+not\s+null/i.test(what)) f.nullable = true;
        else {
          const type =
            /^(?:set\s+data\s+)?type\s+(.+?)(?:\s+using\s.*)?$/i.exec(what);
          if (type?.[1] !== undefined) f.type = type[1].trim();
          const dflt = /^set\s+default\s+(.+)$/i.exec(what);
          if (dflt?.[1] !== undefined) {
            f.flags = f.flags.filter((x) => !x.startsWith("默认 "));
            f.flags.push(`默认 ${dflt[1].trim()}`);
          }
          if (/^drop\s+default/i.test(what))
            f.flags = f.flags.filter((x) => !x.startsWith("默认 "));
        }
      }
      return true;
    }
    // 存储参数、属主、触发器、行级安全等，与表结构无关。
    if (
      /^(owner\s+to|set\s|reset\s|enable\s|disable\s|replica\s|cluster\s|inherit\s|no\s+inherit|force\s|no\s+force|attach\s|detach\s|validate\s+constraint)/i.test(
        flat,
      )
    )
      return true;
    return false;
  }
}

// ─────────────────────────── ent（Go） ───────────────────────────

/** Go 里 `func (X) Name() []ent.Y {` 后面那段函数体。 */
function goMethodBody(
  text: string,
  receiver: string,
  method: string,
): string | null {
  const re = new RegExp(
    `func\\s*\\(\\s*(?:\\w+\\s+)?\\*?${receiver}\\s*\\)\\s*${method}\\s*\\(\\s*\\)[^{]*\\{`,
  );
  const m = re.exec(text);
  if (m === null) return null;
  const body = balanced(text, m.index + m[0].length - 1, ["{", "}"]);
  return body?.inner ?? null;
}

/** 把 `return []ent.Field{ a, b }` 里的顶层元素拆出来。 */
function goReturnList(body: string): string[] {
  const m = /return\s+\[\][\w.]+\s*\{/.exec(body);
  if (m === null) return [];
  const list = balanced(body, m.index + m[0].length - 1, ["{", "}"]);
  if (list === null) return [];
  // 去掉行注释再切（注释里的逗号会把一个字段切成两半）；Go 的链式调用把点写在
  // 行尾（`edge.From(...).⏎ Ref(...)`），合回一行，后面的 `.Ref(` 才认得出。
  const clean = list.inner
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\.[ \t]*\r?\n\s*/g, ".");
  return splitTopLevel(clean).filter((x) => x !== "");
}

const ENT_TYPE: Record<string, string> = {
  String: "string",
  Text: "text",
  Int: "int",
  Int8: "int8",
  Int16: "int16",
  Int32: "int32",
  Int64: "int64",
  Uint: "uint",
  Uint8: "uint8",
  Uint16: "uint16",
  Uint32: "uint32",
  Uint64: "uint64",
  Float: "float",
  Float32: "float32",
  Bool: "bool",
  Time: "time",
  UUID: "uuid",
  Bytes: "bytes",
  JSON: "json",
  Enum: "enum",
  Strings: "string[]",
  Ints: "int[]",
  Floats: "float[]",
  Other: "other",
};

function goString(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("`") && s.endsWith("`")) return s.slice(1, -1);
  return null;
}

/** 链式调用里某个方法的第一个参数原文，如 `.Comment("x")` → `"x"`。 */
function chainArg(expr: string, method: string): string | undefined {
  const re = new RegExp(`\\.${method}\\s*\\(`);
  const m = re.exec(expr);
  if (m === null) return undefined;
  const args = balanced(expr, m.index + m[0].length - 1);
  if (args === null) return undefined;
  return splitTopLevel(args.inner)[0];
}

function parseEntField(expr: string): SchemaField | null {
  const m = /^field\.(\w+)\s*\(/.exec(expr.trim());
  if (m?.[1] === undefined) return null;
  const head = balanced(expr.trim(), m[0].length - 1);
  if (head === null) return null;
  const name = goString(splitTopLevel(head.inner)[0]);
  if (name === null) return null;
  const flags: string[] = [];
  let type = ENT_TYPE[m[1]] ?? m[1].toLowerCase();
  const pg = /dialect\.Postgres\s*:\s*"([^"]+)"/.exec(expr);
  if (pg?.[1] !== undefined) type = pg[1];
  if (m[1] === "Enum") {
    const all = /\.Values\s*\(([^)]*)\)/.exec(expr)?.[1];
    if (all !== undefined)
      type = `enum(${splitTopLevel(all)
        .map((v) => goString(v) ?? v)
        .join(" | ")})`;
  }
  if (/\.Unique\s*\(\s*\)/.test(expr)) flags.push("唯一");
  if (/\.Immutable\s*\(\s*\)/.test(expr)) flags.push("创建后不可改");
  if (/\.Sensitive\s*\(\s*\)/.test(expr)) flags.push("敏感");
  const dflt = chainArg(expr, "Default");
  if (dflt !== undefined) flags.push(`默认 ${dflt}`);
  const comment = goString(chainArg(expr, "Comment"));
  return {
    name,
    type,
    nullable: /\.(Optional|Nillable)\s*\(\s*\)/.test(expr),
    flags,
    comment,
  };
}

interface GoHelper {
  params: string[];
  body: string;
}

/**
 * `Fields()` 里就地定义的字段模板：`priceField := func(name, comment string) ent.Field { return field.Float(name)… }`。
 * 真实仓库里一张价格快照表 48 个字段全是这么写的，不认它就整张表只剩 id。
 */
function goFieldHelpers(body: string): Map<string, GoHelper> {
  const out = new Map<string, GoHelper>();
  for (const m of body.matchAll(
    /(\w+)\s*:=\s*func\s*\(([^)]*)\)\s*ent\.Field\s*\{/g,
  )) {
    const name = m[1];
    const params = m[2];
    if (name === undefined || params === undefined) continue;
    const fn = balanced(body, m.index + m[0].length - 1, ["{", "}"]);
    const ret =
      fn === null ? null : /return\s+([\s\S]+)$/.exec(fn.inner.trim());
    if (ret?.[1] === undefined) continue;
    // `a, b string` / `a string, b int` → [a, b]
    const names = params
      .split(",")
      .map((p) => p.trim().split(/\s+/)[0] ?? "")
      .filter((p) => p !== "");
    out.set(name, {
      params: names,
      body: ret[1].replace(/\/\/[^\n]*/g, "").replace(/\.[ \t]*\r?\n\s*/g, "."),
    });
  }
  return out;
}

/** `priceField("x", "注释").Optional()` → 把模板里的形参换成实参，再接上后续链式调用。 */
function expandHelper(
  expr: string,
  helpers: ReadonlyMap<string, GoHelper>,
): string {
  const m = /^(\w+)\s*\(/.exec(expr.trim());
  const helper = m?.[1] === undefined ? undefined : helpers.get(m[1]);
  if (m === null || helper === undefined) return expr;
  const trimmed = expr.trim();
  const call = balanced(trimmed, m[0].length - 1);
  if (call === null) return expr;
  const args = splitTopLevel(call.inner);
  let body = helper.body;
  helper.params.forEach((p, i) => {
    const arg = args[i];
    if (arg !== undefined)
      body = body.replace(
        new RegExp(`(?<![\\w."])${p}(?![\\w"])`, "g"),
        () => arg,
      );
  });
  return body + trimmed.slice(call.end + 1);
}

/** UserSubscription → user_subscriptions（ent 的默认表名规则：蛇形 + 复数）。 */
export function entDefaultTable(entity: string): string {
  const snake = entity
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  if (/(s|x|z|ch|sh)$/.test(snake)) return `${snake}es`;
  if (/[^aeiou]y$/.test(snake)) return `${snake.slice(0, -1)}ies`;
  return `${snake}s`;
}

/** 紧挨在 `type X struct` 上面的注释块，去掉 ent 生成器的套话。 */
function goDocComment(text: string, at: number): string | null {
  const before = text.slice(0, at).split("\n");
  const lines: string[] = [];
  for (let i = before.length - 2; i >= 0; i -= 1) {
    const line = (before[i] ?? "").trim();
    if (!line.startsWith("//")) break;
    lines.unshift(line.replace(/^\/\/\s?/, ""));
  }
  const kept = lines.filter(
    (l) => !/holds the schema definition for the \w+ entity/i.test(l),
  );
  const joined = kept.join("\n").trim();
  return joined === "" ? null : joined;
}

interface EntEdge {
  owner: string;
  name: string;
  dir: "to" | "from";
  target: string;
  ref: string | null;
  field: string | null;
  unique: boolean;
  source: string;
}

/**
 * 解析 ent 的 schema 目录。
 *
 * mixin（如 TimeMixin）里的字段会并到用它的实体上；mixin 文件一并传进来即可
 * （它们通常在 `ent/schema/mixins/`），识别方式是嵌了 `mixin.Schema`。
 */
export function parseEntSchemas(files: readonly SourceText[]): SchemaModel {
  const bad = unparsedBag();
  const mixins = new Map<string, SchemaField[]>();
  interface Pending {
    entity: string;
    table: SchemaTable;
    mixins: string[];
  }
  const pending: Pending[] = [];
  const edges: EntEdge[] = [];

  for (const file of files) {
    const text = file.text;
    for (const m of text.matchAll(
      /type\s+(\w+)\s+struct\s*\{\s*([\w.]+)\s*\}/g,
    )) {
      const entity = m[1];
      const embed = m[2];
      if (entity === undefined || embed === undefined) continue;
      const fieldsBody = goMethodBody(text, entity, "Fields");
      const fields: SchemaField[] = [];
      const helpers =
        fieldsBody === null ? new Map() : goFieldHelpers(fieldsBody);
      for (const raw of fieldsBody === null ? [] : goReturnList(fieldsBody)) {
        const expr = expandHelper(raw, helpers);
        const f = parseEntField(expr);
        if (f === null)
          bad.add(`${file.path}：${entity} 字段 ${expr.slice(0, 50)}`);
        else fields.push(f);
      }
      if (embed === "mixin.Schema") {
        mixins.set(entity, fields);
        continue;
      }
      if (embed !== "ent.Schema") continue;

      const annotations = goMethodBody(text, entity, "Annotations") ?? "";
      const tableName =
        /entsql\.Annotation\s*\{[^}]*Table\s*:\s*"([^"]+)"/.exec(
          annotations,
        )?.[1] ?? entDefaultTable(entity);
      const mixinBody = goMethodBody(text, entity, "Mixin");
      const used =
        mixinBody === null
          ? []
          : goReturnList(mixinBody).map((x) =>
              (x.replace(/\{.*$/s, "").split(".").pop() ?? x).trim(),
            );
      const id: SchemaField = {
        name: "id",
        type: "int",
        nullable: false,
        flags: ["主键"],
        comment: null,
      };
      // 自定义 id 字段（如 field.String("id")）覆盖默认的自增 id。
      const custom = fields.findIndex((f) => f.name === "id");
      if (custom !== -1) {
        const f = fields.splice(custom, 1)[0];
        if (f !== undefined) {
          id.type = f.type;
          id.comment = f.comment;
        }
      }
      pending.push({
        entity,
        mixins: used,
        table: {
          name: tableName,
          entity,
          comment: goDocComment(text, m.index),
          fields: [id, ...fields],
          source: file.path,
        },
      });

      const edgesBody = goMethodBody(text, entity, "Edges");
      for (const expr of edgesBody === null ? [] : goReturnList(edgesBody)) {
        const e =
          /^edge\.(To|From)\s*\(\s*"([^"]+)"\s*,\s*(\w+)\.Type\s*\)/.exec(
            expr.trim(),
          );
        if (e?.[1] === undefined || e[2] === undefined || e[3] === undefined) {
          bad.add(`${file.path}：${entity} 关联 ${expr.slice(0, 50)}`);
          continue;
        }
        edges.push({
          owner: entity,
          name: e[2],
          dir: e[1] === "To" ? "to" : "from",
          target: e[3],
          ref: goString(chainArg(expr, "Ref")),
          field: goString(chainArg(expr, "Field")),
          unique: /\.Unique\s*\(\s*\)/.test(expr),
          source: file.path,
        });
      }
    }
  }

  const byEntity = new Map<string, SchemaTable>();
  for (const p of pending) {
    const extra: SchemaField[] = [];
    for (const name of p.mixins) {
      const fields = mixins.get(name);
      if (fields === undefined) {
        // SoftDeleteMixin 这类常见 mixin 不在传进来的文件里时，如实报。
        bad.add(`${p.table.source}：找不到 mixin ${name}`);
        continue;
      }
      extra.push(...fields);
    }
    const [id, ...rest] = p.table.fields;
    p.table.fields = [
      ...(id === undefined ? [] : [id]),
      ...rest,
      ...extra.filter((f) => !rest.some((r) => r.name === f.name)),
    ];
    byEntity.set(p.entity, p.table);
  }

  // 每对关联在 ent 里写两遍（To 一头、From 一头）。以 From 一头为准（它带外键字段），
  // 再补上只有 To、没有对应 From 的（多对多或单向）。
  const relations: SchemaRelation[] = [];
  const covered = new Set<string>();
  for (const e of edges) {
    if (e.dir !== "from") continue;
    const from = byEntity.get(e.owner);
    const to = byEntity.get(e.target);
    if (from === undefined || to === undefined) continue;
    const back = edges.find(
      (x) => x.dir === "to" && x.owner === e.target && x.name === e.ref,
    );
    if (back !== undefined) covered.add(`${back.owner}.${back.name}`);
    const kind: SchemaRelation["kind"] = !e.unique
      ? "many-to-many"
      : back?.unique === true
        ? "one-to-one"
        : "many-to-one";
    relations.push({
      from: from.name,
      to: to.name,
      field: e.field,
      kind,
      label: e.name,
      source: e.source,
    });
  }
  for (const e of edges) {
    if (e.dir !== "to" || covered.has(`${e.owner}.${e.name}`)) continue;
    const owner = byEntity.get(e.owner);
    const target = byEntity.get(e.target);
    if (owner === undefined || target === undefined) continue;
    // 单向 To：Unique 表示「我指向一个」（多对一），否则「我有多个」——
    // 外键在对方表上，方向倒过来记，与其余关系统一成「外键所在的表 → 被指向的表」。
    if (e.unique)
      relations.push({
        from: owner.name,
        to: target.name,
        field: e.field,
        kind: "many-to-one",
        label: e.name,
        source: e.source,
      });
    else
      relations.push({
        from: target.name,
        to: owner.name,
        field: null,
        kind: "many-to-one",
        label: e.name,
        source: e.source,
      });
  }
  return {
    format: "ent",
    tables: [...byEntity.values()],
    relations,
    unparsed: bad.done(),
  };
}

// ─────────────────────────── Prisma ───────────────────────────

const PRISMA_SCALAR = new Set([
  "String",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "Boolean",
  "DateTime",
  "Json",
  "Bytes",
]);

export function parsePrismaSchemas(files: readonly SourceText[]): SchemaModel {
  const bad = unparsedBag();
  interface Raw {
    model: string;
    table: SchemaTable;
    /** 字段名 → Prisma 字段名到库列名的映射。 */
    columns: Map<string, string>;
    rels: {
      name: string;
      target: string;
      fields: string[];
      list: boolean;
      relName: string | null;
    }[];
  }
  const models: Raw[] = [];
  const enums = new Set<string>();

  for (const file of files) {
    for (const m of file.text.matchAll(/^\s*enum\s+(\w+)\s*\{/gm))
      if (m[1] !== undefined) enums.add(m[1]);
  }

  for (const file of files) {
    const text = file.text;
    for (const m of text.matchAll(/^([ \t]*)model\s+(\w+)\s*\{/gm)) {
      const model = m[2];
      if (model === undefined) continue;
      const body = balanced(text, m.index + m[0].length - 1, ["{", "}"]);
      if (body === null) {
        bad.add(`${file.path}：model ${model}`);
        continue;
      }
      const docLines: string[] = [];
      const before = text.slice(0, m.index).split("\n");
      for (let i = before.length - 1; i >= 0; i -= 1) {
        const line = (before[i] ?? "").trim();
        if (line === "" && i === before.length - 1) continue;
        if (!line.startsWith("///")) break;
        docLines.unshift(line.replace(/^\/\/\/\s?/, ""));
      }
      const raw: Raw = {
        model,
        table: {
          name: model,
          entity: model,
          comment: docLines.length === 0 ? null : docLines.join("\n"),
          fields: [],
          source: file.path,
        },
        columns: new Map(),
        rels: [],
      };
      let doc: string[] = [];
      // 块注释（`/** … */`）当作下一个字段的说明，与 `///` 同等对待。
      const inner = body.inner.replace(/\/\*+([\s\S]*?)\*\//g, (_, c: string) =>
        c
          .split("\n")
          .map((l) => l.replace(/^\s*\*\s?/, "").trim())
          .filter((l) => l !== "")
          .map((l) => `/// ${l}`)
          .join("\n"),
      );
      for (const lineRaw of inner.split("\n")) {
        const line = lineRaw.trim();
        if (line === "") continue;
        if (line.startsWith("///")) {
          doc.push(line.replace(/^\/\/\/\s?/, ""));
          continue;
        }
        if (line.startsWith("//")) continue;
        if (line.startsWith("@@")) {
          const map = /^@@map\(\s*"([^"]+)"/.exec(line);
          if (map?.[1] !== undefined) raw.table.name = map[1];
          const id = /^@@id\(\s*(?:fields:\s*)?\[([^\]]+)\]/.exec(line);
          if (id?.[1] !== undefined)
            for (const c of id[1].split(",").map((s) => s.trim()))
              raw.table.fields.find((f) => f.name === c)?.flags.unshift("主键");
          continue;
        }
        const f = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
        if (f?.[1] === undefined || f[2] === undefined) {
          bad.add(`${file.path}：${model} ${line.slice(0, 50)}`);
          doc = [];
          continue;
        }
        const [, name, type, list, optional] = f;
        const attrs = f[5] ?? "";
        const trailing = /\/\/\s*(.+)$/.exec(attrs)?.[1]?.trim();
        const comment = [
          ...doc,
          ...(trailing === undefined ? [] : [trailing]),
        ].join("；");
        doc = [];
        const isScalar = PRISMA_SCALAR.has(type) || enums.has(type);
        if (!isScalar) {
          const rel = /@relation\(([^)]*)\)/.exec(attrs)?.[1] ?? "";
          const fields =
            /fields:\s*\[([^\]]*)\]/
              .exec(rel)?.[1]
              ?.split(",")
              .map((s) => s.trim()) ?? [];
          const relName =
            /^\s*"([^"]+)"/.exec(rel)?.[1] ??
            /name:\s*"([^"]+)"/.exec(rel)?.[1] ??
            null;
          raw.rels.push({
            name,
            target: type,
            fields: fields.filter((x) => x !== ""),
            list: list !== undefined,
            relName,
          });
          continue;
        }
        const flags: string[] = [];
        if (/@id\b/.test(attrs)) flags.push("主键");
        if (/@unique\b/.test(attrs)) flags.push("唯一");
        if (/@updatedAt\b/.test(attrs)) flags.push("自动更新时间");
        const dflt = /@default\(/.exec(attrs);
        if (dflt !== null) {
          const inner = balanced(attrs, dflt.index + dflt[0].length - 1);
          if (inner !== null) flags.push(`默认 ${inner.inner}`);
        }
        const column = /@map\(\s*"([^"]+)"/.exec(attrs)?.[1] ?? name;
        raw.columns.set(name, column);
        const dbType = /@db\.(\w+(?:\([^)]*\))?)/.exec(attrs)?.[1];
        raw.table.fields.push({
          name: column,
          type: `${dbType ?? type}${list === undefined ? "" : "[]"}`,
          nullable: optional !== undefined,
          flags,
          comment: comment === "" ? null : comment,
        });
      }
      models.push(raw);
    }
  }

  const byModel = new Map(models.map((m) => [m.model, m]));
  const relations: SchemaRelation[] = [];
  for (const m of models) {
    for (const r of m.rels) {
      const target = byModel.get(r.target);
      if (target === undefined) continue;
      if (r.fields.length > 0) {
        // 带 fields 的一头持有外键：多对一；对方那头若不是列表就是一对一。
        const back = target.rels.find(
          (x) =>
            x.target === m.model &&
            x.relName === r.relName &&
            x.fields.length === 0,
        );
        const fk = r.fields[0] ?? "";
        relations.push({
          from: m.table.name,
          to: target.table.name,
          field: m.columns.get(fk) ?? fk,
          kind: back !== undefined && !back.list ? "one-to-one" : "many-to-one",
          label: r.name,
          source: m.table.source,
        });
      } else if (r.list) {
        // 隐式多对多：两头都是列表且都没有 fields。只记一次（按模型名排序取前者）。
        const back = target.rels.find(
          (x) => x.target === m.model && x.relName === r.relName,
        );
        if (
          back?.list === true &&
          back.fields.length === 0 &&
          m.model <= target.model
        )
          relations.push({
            from: m.table.name,
            to: target.table.name,
            field: null,
            kind: "many-to-many",
            label: r.name,
            source: m.table.source,
          });
      }
    }
  }
  return {
    format: "prisma",
    tables: models.map((m) => m.table),
    relations,
    unparsed: bad.done(),
  };
}
