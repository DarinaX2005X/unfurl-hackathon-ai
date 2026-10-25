import "server-only";
import type { CatalogQuery } from "../../domain/catalog";
import type { Actor } from "../auth/actor";
import { withSystemTransaction, type DbTransaction } from "../db";
import * as repository from "./repository";

export interface CatalogTransactions { read<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> }

export function createCatalogService(options: { transactions?: CatalogTransactions } = {}) {
  const transactions: CatalogTransactions = options.transactions ?? {
    read: <T>(work: (tx: DbTransaction) => Promise<T>) => withSystemTransaction("public_projection", work),
  };
  return {
    listPublic: (query: CatalogQuery) => transactions.read((tx) => repository.listPublic(tx, query)),
    getBySlug: (actor: Actor | null, slug: string) => transactions.read((tx) => repository.getBySlug(tx, actor, slug)),
    getCourse: (actor: Actor | null, courseId: string, versionId?: string) => transactions.read((tx) => repository.getCourse(tx, actor, courseId, versionId)),
  };
}

export const catalogService = createCatalogService();
