import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { productionMechanicManifest } from "@/domain/mechanic-manifest";
import { getGenerationMechanicCatalog } from "@/server/mechanics/catalog";
import { runtime } from "./fixtures";

describe("public registry boundary", () => {
  it("has no transitive runtime path from the client registry or manifest to private server evaluators", () => {
    const sourceRoot = resolve(process.cwd(), "src"), visited = new Set<string>();
    function visit(path: string): void {
      if (visited.has(path)) return;
      visited.add(path);
      expect(path.replaceAll("\\", "/")).not.toContain("/server/");
      const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const imports: string[] = [];
      for (const node of file.statements) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const clause = node.importClause;
          if (clause?.isTypeOnly || clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name &&
              clause.namedBindings.elements.every((binding) => binding.isTypeOnly)) continue;
          imports.push(node.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          imports.push(node.moduleSpecifier.text);
        }
      }
      function dynamic(node: ts.Node): void {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
        ts.forEachChild(node, dynamic);
      }
      dynamic(file);
      for (const imported of imports) {
        expect(imported).not.toBe("server-only");
        if (!imported.startsWith(".") && !imported.startsWith("@/")) continue;
        const base = imported.startsWith("@/") ? resolve(sourceRoot, imported.slice(2)) : resolve(dirname(path), imported);
        const next = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")].find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
        if (next) visit(next);
      }
    }
    visit(resolve(sourceRoot, "features/learning/registry.ts"));
    visit(resolve(sourceRoot, "domain/mechanic-manifest.ts"));
    expect(visited.size).toBeGreaterThan(20);
  });
  it("makes public metadata immutable and keeps dependency failures visible without removing families", () => {
    const entry = productionMechanicManifest.find((item) => item.id === "information_gap")!;
    expect(() => entry.requirements.pop()).toThrow();
    expect(() => { entry.accessibility.keyboardEquivalent = false; }).toThrow();
    const unavailable = structuredClone(runtime); unavailable.activity.durable = false; unavailable.model = { modelId: "moonshotai/kimi-k2.6", available: false };
    const catalog = getGenerationMechanicCatalog(unavailable);
    expect(catalog.entries).toHaveLength(31);
    expect(catalog.entries.find((item) => item.id === "information_gap")?.reasons).toEqual(expect.arrayContaining(["durable_activity_unavailable", "model_unavailable"]));
    expect(JSON.stringify(catalog)).not.toMatch(/privateSchema|evaluatorData|expectedAnswer|validationReceiptId|reviewedClaim/);
  });
});
