// Export utilities: STL and validation report
import { exportBinarySTL } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { ValidationResult, LatticeParams } from '../types/project';
import { massGrams } from '../geometry/metrics';
import type { LatticeMetrics } from '../geometry/metrics';
import { buildThreeMf } from './threemf';
import type { ThreeMfOptions } from './threemf';

export async function download3MF(
  result: MarchingCubesResult,
  options: ThreeMfOptions,
  filename: string = 'lattice-design.3mf'
) {
  const bytes = await buildThreeMf(result, options);
  const blob = new Blob([bytes as BlobPart], { type: 'model/3mf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadSTL(result: MarchingCubesResult, filename: string = 'lattice-design.stl') {
  const buffer = exportBinarySTL(result.positions, result.normals, result.triCount);
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadValidationReport(
  validation: ValidationResult,
  params: LatticeParams,
  meshFileName: string,
  metrics: LatticeMetrics | null = null,
  material: { name: string; density: number } | null = null,
  filename: string = 'validation-report.json'
) {
  const report = {
    timestamp: new Date().toISOString(),
    meshFile: meshFileName,
    parameters: params,
    metrics: metrics && {
      envelopeVolumeMm3: metrics.envelopeVolume,
      latticeVolumeMm3: metrics.latticeVolume,
      relativeDensity: metrics.relativeDensity,
      surfaceAreaMm2: metrics.surfaceArea,
      massGrams: material ? massGrams(metrics.latticeVolume, material.density) : null,
      solidMassGrams: material ? massGrams(metrics.envelopeVolume, material.density) : null,
      material: material?.name ?? null,
      materialDensityGramsPerCm3: material?.density ?? null,
      basis: {
        volume: `occupancy sampling, ${metrics.volumeSamplesPerAxis}^3 field samples`,
        envelopeVolume: 'exact (divergence theorem on the source solid)',
        surfaceArea: 'extracted mesh at the current export resolution',
      },
    },
    validation: {
      overallPassed: validation.passed,
      outerDeviation: validation.outerDeviation,
      minThickness: validation.minThickness,
      manifold: validation.manifold,
      disconnectedPieces: validation.disconnected,
      warnings: validation.warnings,
    },
  };
  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export project data as JSON */
export function downloadProjectJSON(
  params: LatticeParams,
  meshFileName: string,
  keepOutTris: Set<number>,
  keepInTris: Set<number>,
  validation: ValidationResult | null,
) {
  const project = {
    meshAssetName: meshFileName,
    selectionMask: {
      keepOut: Array.from(keepOutTris),
      keepIn: Array.from(keepInTris),
    },
    parameters: params,
    validation: validation,
  };
  const json = JSON.stringify(project, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lattice-project.json';
  a.click();
  URL.revokeObjectURL(url);
}
