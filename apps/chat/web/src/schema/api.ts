/**
 * 产品 → 数据结构的接口。形状与 server/evidence/schema/routes.ts 一一对应。
 */

import { createRequest } from "../http";

const request = createRequest("/api");

export type SchemaFormat = "ent" | "prisma" | "sql";

export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
  flags: string[];
  comment: string | null;
}

export interface SchemaTable {
  name: string;
  entity: string;
  comment: string | null;
  fields: SchemaField[];
  source: string;
}

export type RelationKind = "many-to-one" | "one-to-one" | "many-to-many";

export interface SchemaRelation {
  from: string;
  to: string;
  field: string | null;
  kind: RelationKind;
  label: string | null;
  source: string;
}

export interface SubsystemSummary {
  root: string;
  label: string;
  format: SchemaFormat;
  alsoHas: SchemaFormat[];
  files: number;
  tables: number;
  relations: number;
  unparsed: { count: number; samples: string[] };
}

export interface SubsystemDetail extends SubsystemSummary {
  tableList: SchemaTable[];
  relationList: SchemaRelation[];
}

export const listSubsystems = (productId: string) =>
  request<{ codePath: string | null; subsystems: SubsystemSummary[] }>(
    `/products/${productId}/schema`,
  );

export const getSubsystem = (productId: string, root: string) =>
  request<SubsystemDetail>(
    `/products/${productId}/schema/tables?root=${encodeURIComponent(root)}`,
  );
