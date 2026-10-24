export type Degree = 1 | 3 | 7;
export type Regularization = 0 | 0.1 | 1;

export interface DataPoint {
  x: number;
  y: number;
}

export interface FitResult {
  /** Coefficients are ordered from the intercept to the highest power. */
  coefficients: number[];
  trainRmse: number;
  validationRmse: number;
  curve: DataPoint[];
}

const trainingInputs = [-1, -0.7, -0.4, -0.1, 0.2, 0.5, 0.8, 1];
const trainingNoise = [0.16, -0.12, 0.14, -0.15, 0.12, -0.14, 0.12, -0.16];
const validationInputs = [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9];

/** A fixed, synthetic teaching dataset. Validation points are used for selection. */
export const DATASET = Object.freeze({
  name: "model-capacity-v1",
  train: Object.freeze(trainingInputs.map((x, index) => Object.freeze({
    x,
    y: Math.sin(Math.PI * x) + trainingNoise[index]!,
  }))),
  validation: Object.freeze(validationInputs.map((x) => Object.freeze({
    x,
    y: Math.sin(Math.PI * x),
  }))),
});

export function evaluatePolynomial(coefficients: readonly number[], x: number): number {
  if (coefficients.length === 0 || !Number.isFinite(x) || !coefficients.every(Number.isFinite)) {
    throw new Error("The polynomial needs finite coefficients and an input value.");
  }
  // Horner's method avoids separately evaluating every power of x.
  let result = 0;
  for (let index = coefficients.length - 1; index >= 0; index -= 1) {
    result = result * x + coefficients[index]!;
  }
  if (!Number.isFinite(result)) {
    throw new Error("The fitted curve could not be calculated. Try another configuration.");
  }
  return result;
}

function powers(x: number, count: number): number[] {
  const row = [1];
  for (let index = 1; index < count; index += 1) row.push(row[index - 1]! * x);
  return row;
}

/** Householder QR solves the augmented least-squares system without forming AᵀA. */
function solveLeastSquares(matrix: number[][], values: number[]): number[] {
  const columns = matrix[0]!.length;
  const rows = matrix.length;

  for (let column = 0; column < columns; column += 1) {
    const reflector = matrix.slice(column).map((row) => row[column]!);
    const norm = Math.hypot(...reflector);
    if (norm < 1e-12) {
      throw new Error("This configuration could not be fitted. Your settings are unchanged.");
    }
    // Choosing the opposite sign avoids subtracting nearly equal values.
    reflector[0] = reflector[0]! + (reflector[0]! >= 0 ? norm : -norm);
    const reflectorNorm = Math.hypot(...reflector);
    for (let index = 0; index < reflector.length; index += 1) {
      reflector[index] = reflector[index]! / reflectorNorm;
    }

    for (let target = column; target < columns; target += 1) {
      let dot = 0;
      for (let row = column; row < rows; row += 1) {
        dot += reflector[row - column]! * matrix[row]![target]!;
      }
      for (let row = column; row < rows; row += 1) {
        matrix[row]![target] = matrix[row]![target]! - 2 * reflector[row - column]! * dot;
      }
    }
    let dot = 0;
    for (let row = column; row < rows; row += 1) dot += reflector[row - column]! * values[row]!;
    for (let row = column; row < rows; row += 1) {
      values[row] = values[row]! - 2 * reflector[row - column]! * dot;
    }
  }

  const solution = new Array<number>(columns).fill(0);
  for (let row = columns - 1; row >= 0; row -= 1) {
    let remainder = values[row]!;
    for (let column = row + 1; column < columns; column += 1) {
      remainder -= matrix[row]![column]! * solution[column]!;
    }
    solution[row] = remainder / matrix[row]![row]!;
  }
  if (!solution.every(Number.isFinite)) {
    throw new Error("This configuration could not be fitted. Your settings are unchanged.");
  }
  return solution;
}

function rootMeanSquaredError(coefficients: readonly number[], points: readonly DataPoint[]): number {
  const squaredErrors = points.map(({ x, y }) => (evaluatePolynomial(coefficients, x) - y) ** 2);
  return Math.sqrt(squaredErrors.reduce((total, value) => total + value, 0) / points.length);
}

export function fitPolynomial(degree: Degree, lambda: Regularization): FitResult {
  if (![1, 3, 7].includes(degree) || ![0, 0.1, 1].includes(lambda)) {
    throw new Error("Choose a degree of 1, 3, or 7 and regularization of 0, 0.1, or 1.");
  }

  const coefficientCount = degree + 1;
  const matrix = DATASET.train.map(({ x }) => powers(x, coefficientCount));
  const values = DATASET.train.map(({ y }) => y);
  // Appending sqrt(lambda)·I penalizes each nonconstant coefficient. The
  // intercept has no penalty row, so the objective is sum(error²) + λ·sum(aₖ²), k≥1.
  if (lambda > 0) {
    for (let coefficient = 1; coefficient < coefficientCount; coefficient += 1) {
      const penaltyRow = new Array<number>(coefficientCount).fill(0);
      penaltyRow[coefficient] = Math.sqrt(lambda);
      matrix.push(penaltyRow);
      values.push(0);
    }
  }

  const coefficients = solveLeastSquares(matrix, values);
  const curve = Array.from({ length: 201 }, (_, index) => {
    const x = -1 + index / 100;
    return { x, y: evaluatePolynomial(coefficients, x) };
  });
  return {
    coefficients,
    trainRmse: rootMeanSquaredError(coefficients, DATASET.train),
    validationRmse: rootMeanSquaredError(coefficients, DATASET.validation),
    curve,
  };
}
