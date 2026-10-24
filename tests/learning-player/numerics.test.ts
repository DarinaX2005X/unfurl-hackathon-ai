import { describe, expect, it } from "vitest";
import {
  DATASET, evaluatePolynomial, fitPolynomial,
  type Degree, type Regularization,
} from "../../src/features/learning/sample/numerics";

describe("model-capacity-v1 numerical fit", () => {
  it.each([
    [1, 0, 0.5681228750, 0.4976179728],
    [3, 0, 0.1106225068, 0.0532156483],
    [7, 0, 0, 0.3719332272],
    [7, 0.1, 0.1851313263, 0.1999833033],
  ] as const)("degree %s / λ %s matches the numerical reference", (degree, lambda, train, validation) => {
    const result = fitPolynomial(degree, lambda);
    expect(Math.abs(result.trainRmse - train)).toBeLessThan(1e-6);
    expect(Math.abs(result.validationRmse - validation)).toBeLessThan(1e-6);
  });

  it("fits the noise at degree 7 without establishing validation accuracy", () => {
    const result = fitPolynomial(7, 0);
    for (const { x, y } of DATASET.train) {
      expect(evaluatePolynomial(result.coefficients, x)).toBeCloseTo(y, 10);
    }
    expect(result.validationRmse).toBeGreaterThan(0.21);
    expect(fitPolynomial(3, 0).validationRmse).toBeLessThan(0.21);
    expect(fitPolynomial(3, 0.1).validationRmse).toBeLessThan(0.21);
    expect(fitPolynomial(7, 0.1).validationRmse).toBeLessThan(0.21);
  });

  it("regularization reduces coefficient magnitude and validation error at degree 7", () => {
    const baseline = fitPolynomial(7, 0);
    const regularized = fitPolynomial(7, 0.1);
    const penalty = (coefficients: number[]) => coefficients.slice(1).reduce((sum, value) => sum + value ** 2, 0);
    expect(penalty(regularized.coefficients)).toBeLessThan(penalty(baseline.coefficients));
    expect(regularized.trainRmse).toBeGreaterThan(baseline.trainRmse);
    expect(regularized.validationRmse).toBeLessThan(baseline.validationRmse);
  });

  it("satisfies ridge optimality while leaving the intercept unpenalized", () => {
    const lambda = 1;
    const result = fitPolynomial(7, lambda);
    const residuals = DATASET.train.map(({ x, y }) => ({ x, residual: evaluatePolynomial(result.coefficients, x) - y }));
    for (let power = 0; power < result.coefficients.length; power += 1) {
      const errorGradient = residuals.reduce((sum, { x, residual }) => sum + residual * x ** power, 0);
      const penaltyGradient = power === 0 ? 0 : lambda * result.coefficients[power]!;
      expect(Math.abs(errorGradient + penaltyGradient)).toBeLessThan(1e-10);
    }
  });

  it.each(([1, 3, 7] as const).flatMap((degree) => ([0, 0.1, 1] as const).map((lambda) => [degree, lambda] as const)))(
    "produces a finite continuous curve over the fixed domain for degree %s / λ %s",
    (degree, lambda) => {
      const result = fitPolynomial(degree, lambda);
      expect(result.coefficients).toHaveLength(degree + 1);
      expect(result.coefficients.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(result.trainRmse)).toBe(true);
      expect(Number.isFinite(result.validationRmse)).toBe(true);
      expect(result.curve).toHaveLength(201);
      expect(result.curve[0]!.x).toBe(-1);
      expect(result.curve.at(-1)!.x).toBe(1);
      result.curve.forEach(({ x, y }, index) => {
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBe(evaluatePolynomial(result.coefficients, x));
        if (index > 0) expect(x).toBeGreaterThan(result.curve[index - 1]!.x);
      });
    },
  );

  it("rejects invalid configuration and nonfinite polynomial inputs without returning NaN", () => {
    for (const degree of [0, 2, 8, NaN, Infinity]) {
      expect(() => fitPolynomial(degree as Degree, 0)).toThrow(/Choose a degree/);
    }
    for (const lambda of [-1, 0.5, NaN, Infinity]) {
      expect(() => fitPolynomial(3, lambda as Regularization)).toThrow(/Choose a degree/);
    }
    expect(() => evaluatePolynomial([], 0)).toThrow(/finite coefficients/);
    expect(() => evaluatePolynomial([1, NaN], 0)).toThrow(/finite coefficients/);
    expect(() => evaluatePolynomial([1], Infinity)).toThrow(/finite coefficients/);
    expect(() => evaluatePolynomial([1, Number.MAX_VALUE], 2)).toThrow(/could not be calculated/);
  });

  it("does not mutate the synthetic dataset or previous results on repeated fitting", () => {
    const source = JSON.stringify(DATASET);
    const first = fitPolynomial(7, 0);
    const expected = structuredClone(first);
    fitPolynomial(3, 0.1);
    expect(DATASET.name).toBe("model-capacity-v1");
    expect(DATASET.train).toHaveLength(8);
    expect(DATASET.validation).toHaveLength(7);
    expect(JSON.stringify(DATASET)).toBe(source);
    expect(first).toEqual(expected);
    expect(fitPolynomial(7, 0)).toEqual(first);
  });
});
