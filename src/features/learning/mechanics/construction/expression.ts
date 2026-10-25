import { expressionLocations } from "@/domain/mechanic-families/v2/construction";
import type { Expr } from "@/domain/mechanic-families/v2/shared";

export const operationLabels: Record<Expr["op"], string> = {
  constant: "Number", variable: "Variable", add: "Add", subtract: "Subtract",
  multiply: "Multiply", divide: "Divide", abs: "Absolute value",
};

export function expressionText(expression: Expr): string {
  if (expression.op === "constant") return String(expression.value);
  if (expression.op === "variable") return expression.name;
  if (expression.op === "abs") return `abs(${expressionText(expression.value)})`;
  const symbol = { add: "+", subtract: "−", multiply: "×", divide: "÷" }[expression.op];
  return `(${expressionText(expression.left)} ${symbol} ${expressionText(expression.right)})`;
}

export function partLabel(path: string): string {
  if (path === "") return "Whole expression";
  return path.slice(1).split("/").map((part) => part === "left" ? "Left" : part === "right" ? "Right" : "Inside").join(" / ");
}

export function replaceExpressionPart(expression: Expr, path: string, replacement: Expr): Expr {
  if (path === "") return replacement;
  const [segment, ...rest] = path.slice(1).split("/");
  const nested = rest.length > 0 ? `/${rest.join("/")}` : "";
  if (segment === "value" && expression.op === "abs") return { ...expression, value: replaceExpressionPart(expression.value, nested, replacement) };
  if (segment === "left" && "left" in expression) return { ...expression, left: replaceExpressionPart(expression.left, nested, replacement) };
  if (segment === "right" && "right" in expression) return { ...expression, right: replaceExpressionPart(expression.right, nested, replacement) };
  throw new Error("The selected expression part no longer exists");
}

export function changeOperation(expression: Expr, operation: Expr["op"], variableName?: string): Expr {
  if (operation === expression.op) return expression;
  if (operation === "constant") return { op: "constant", value: 0 };
  if (operation === "variable") return variableName ? { op: "variable", name: variableName } : { op: "constant", value: 0 };
  if (operation === "abs") return { op: "abs", value: expression };
  return { op: operation, left: "left" in expression ? expression.left : expression, right: "right" in expression ? expression.right : { op: "constant", value: 0 } };
}

export function selectedExpressionPart(expression: Expr, path: string): { path: string; expression: Expr } {
  return expressionLocations(expression).find((entry) => entry.path === path) ?? { path: "", expression };
}
