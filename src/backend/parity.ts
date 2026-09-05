// Parity comparison for marching-cubes backends. Every tolerance below is
// documented in docs/performance/parity-gates.md; do not loosen one to make a
// failing backend pass without recording the justification there.
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import { computeSignedVolume, countNormalWindingAgreement } from '../geometry/mesh-analysis';
import { buildEdgeTopology, countEdgeDefects, findConnectedComponents } from '../geometry/mesh-topology';
import { checkMinThickness, runValidation } from '../geometry/validation';
import type { Vec3 } from '../geometry/vec3';
import { buildFixtureSdf } from './fixtures';
import type { BackendFixture, GenerationBackendId } from './types';

export interface ParityTolerances {
  /** Whole-volume sealing vs per-tile extraction shifts a few boundary triangles. */
  triCountRelative: number;
  /** Bounds may differ by at most this many grid cells per axis. */
  boundsCells: number;
  /** Enclosed volume agreement; interpolating vertices at tile faces shifts it slightly. */
  volumeRelative: number;
  /** Fraction of stored normals that must agree with triangle winding. */
  minNormalAgreement: number;
  /** Min-thickness measurement agreement between backends. */
  thicknessRelative: number;
  /** Absolute slack for the thickness check, as a fraction of one grid cell. */
  thicknessCellSlack: number;
  /** Outer-deviation measurements may differ by at most this many grid cells. */
  deviationCells: number;
}

export const PARITY_TOLERANCES: ParityTolerances = {
  triCountRelative: 0.01,
  boundsCells: 1,
  volumeRelative: 0.02,
  minNormalAgreement: 0.99,
  thicknessRelative: 0.15,
  thicknessCellSlack: 0.5,
  deviationCells: 1,
};

export interface ParityCheckResult {
  name: string;
  passed: boolean;
  measured: string;
  limit: string;
}

export interface BackendParityReport {
  fixture: string;
  reference: GenerationBackendId;
  candidate: GenerationBackendId;
  checks: ParityCheckResult[];
  passed: boolean;
}

function computeBounds(positions: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }
  return { min, max };
}

function formatCounts(values: number[]): string {
  return values.join(' vs ');
}

export function compareBackendResults(
  fixture: BackendFixture,
  reference: MarchingCubesResult,
  candidate: MarchingCubesResult,
  referenceId: GenerationBackendId,
  candidateId: GenerationBackendId,
  tolerances: ParityTolerances = PARITY_TOLERANCES,
): BackendParityReport {
  const cellMm = (fixture.bounds.max[0] - fixture.bounds.min[0]) / fixture.resolution;
  const checks: ParityCheckResult[] = [];
  const check = (name: string, passed: boolean, measured: string, limit: string) => {
    checks.push({ name, passed, measured, limit });
  };

  // Triangle count: exact when the reference is empty, relative otherwise.
  const triLimit = Math.max(1, Math.round(reference.triCount * tolerances.triCountRelative));
  check(
    'triangle count',
    reference.triCount === 0
      ? candidate.triCount === 0
      : Math.abs(candidate.triCount - reference.triCount) <= triLimit,
    formatCounts([reference.triCount, candidate.triCount]),
    reference.triCount === 0 ? 'both empty' : `delta <= ${triLimit}`,
  );

  if (reference.triCount > 0 && candidate.triCount > 0) {
    // Bounds agreement.
    const refBounds = computeBounds(reference.positions);
    const candBounds = computeBounds(candidate.positions);
    let maxBoundsDelta = 0;
    for (let axis = 0; axis < 3; axis++) {
      maxBoundsDelta = Math.max(
        maxBoundsDelta,
        Math.abs(refBounds.min[axis] - candBounds.min[axis]),
        Math.abs(refBounds.max[axis] - candBounds.max[axis]),
      );
    }
    check(
      'bounds',
      maxBoundsDelta <= tolerances.boundsCells * cellMm + 1e-4,
      `${maxBoundsDelta.toFixed(4)}mm`,
      `<= ${(tolerances.boundsCells * cellMm).toFixed(4)}mm (${tolerances.boundsCells} cell)`,
    );

    // Watertightness and topology defects. The candidate must close every
    // edge: a seam crack or a duplicated tile face shows up here.
    const refDefects = countEdgeDefects(buildEdgeTopology(reference.positions, reference.triCount));
    const candDefects = countEdgeDefects(buildEdgeTopology(candidate.positions, candidate.triCount));
    check(
      'watertight seams and topology',
      refDefects.boundaryEdges === 0 && refDefects.nonManifoldEdges === 0
        && candDefects.boundaryEdges === 0 && candDefects.nonManifoldEdges === 0,
      `boundary ${formatCounts([refDefects.boundaryEdges, candDefects.boundaryEdges])}, non-manifold ${formatCounts([refDefects.nonManifoldEdges, candDefects.nonManifoldEdges])}`,
      'zero boundary and non-manifold edges in both results',
    );

    const refFragments = findConnectedComponents(buildEdgeTopology(reference.positions, reference.triCount)).length;
    const candFragments = findConnectedComponents(buildEdgeTopology(candidate.positions, candidate.triCount)).length;
    check(
      'connected fragments',
      candFragments === refFragments,
      formatCounts([refFragments, candFragments]),
      'identical fragment counts',
    );

    // Normal orientation and enclosed volume.
    const refVolume = computeSignedVolume(reference);
    const candVolume = computeSignedVolume(candidate);
    const volumeDelta = Math.abs(candVolume - refVolume) / Math.max(Math.abs(refVolume), 1e-9);
    check(
      'volume and orientation',
      refVolume > 0 && candVolume > 0 && volumeDelta <= tolerances.volumeRelative,
      `signed volume ${refVolume.toFixed(1)} vs ${candVolume.toFixed(1)}mm3 (${(volumeDelta * 100).toFixed(2)}%)`,
      `both outward, delta <= ${tolerances.volumeRelative * 100}%`,
    );

    const refNormals = countNormalWindingAgreement(reference);
    const candNormals = countNormalWindingAgreement(candidate);
    const agreement = (counts: { agree: number; disagree: number }) => {
      const compared = counts.agree + counts.disagree;
      return compared === 0 ? 1 : counts.agree / compared;
    };
    const refAgreement = agreement(refNormals);
    const candAgreement = agreement(candNormals);
    check(
      'normal orientation',
      refAgreement >= tolerances.minNormalAgreement && candAgreement >= tolerances.minNormalAgreement,
      `${(refAgreement * 100).toFixed(2)}% vs ${(candAgreement * 100).toFixed(2)}%`,
      `>= ${tolerances.minNormalAgreement * 100}% winding agreement`,
    );

    // Wall thickness measured against the shared fixture field.
    const sdf = buildFixtureSdf(fixture);
    const refThickness = checkMinThickness(sdf, reference, fixture.params.minFeatureSize);
    const candThickness = checkMinThickness(sdf, candidate, fixture.params.minFeatureSize);
    if (refThickness.sampled > 0 && candThickness.sampled > 0) {
      const thicknessDelta = Math.abs(candThickness.minMeasured - refThickness.minMeasured);
      const thicknessLimit = Math.max(
        tolerances.thicknessRelative * refThickness.minMeasured,
        tolerances.thicknessCellSlack * cellMm,
      );
      check(
        'wall thickness',
        thicknessDelta <= thicknessLimit,
        `${refThickness.minMeasured.toFixed(3)} vs ${candThickness.minMeasured.toFixed(3)}mm`,
        `delta <= ${thicknessLimit.toFixed(3)}mm`,
      );
    } else {
      check(
        'wall thickness',
        refThickness.sampled === candThickness.sampled,
        `sampled ${formatCounts([refThickness.sampled, candThickness.sampled])}`,
        'both measurable or both unmeasurable',
      );
    }
  }

  // Validation verdicts must match on the same field and parameters, whether
  // the fixture itself passes validation or not.
  const sdf = buildFixtureSdf(fixture);
  const sphereRadius = fixture.shape === 'sphere' ? fixture.sphereRadius : null;
  const refValidation = runValidation(reference, sdf, fixture.params, null, sphereRadius);
  const candValidation = runValidation(candidate, sdf, fixture.params, null, sphereRadius);
  check(
    'validation verdicts',
    refValidation.passed === candValidation.passed
      && refValidation.manifold.passed === candValidation.manifold.passed
      && refValidation.disconnected.passed === candValidation.disconnected.passed
      && refValidation.minThickness.passed === candValidation.minThickness.passed
      && refValidation.outerDeviation.passed === candValidation.outerDeviation.passed,
    `passed ${formatCounts([Number(refValidation.passed), Number(candValidation.passed)])}`,
    'identical verdicts on every validation check',
  );
  const deviationDelta = Math.abs(refValidation.outerDeviation.maxDeviation - candValidation.outerDeviation.maxDeviation);
  check(
    'outer deviation',
    deviationDelta <= tolerances.deviationCells * cellMm + 1e-4,
    `${refValidation.outerDeviation.maxDeviation.toFixed(4)} vs ${candValidation.outerDeviation.maxDeviation.toFixed(4)}mm`,
    `delta <= ${(tolerances.deviationCells * cellMm).toFixed(4)}mm`,
  );

  return {
    fixture: fixture.name,
    reference: referenceId,
    candidate: candidateId,
    checks,
    passed: checks.every((entry) => entry.passed),
  };
}

export function formatParityReport(report: BackendParityReport): string {
  const lines = [
    `${report.fixture}: ${report.candidate} vs ${report.reference} — ${report.passed ? 'PASS' : 'FAIL'}`,
  ];
  for (const check of report.checks) {
    lines.push(`  ${check.passed ? 'ok  ' : 'FAIL'} ${check.name}: ${check.measured} (${check.limit})`);
  }
  return lines.join('\n');
}
