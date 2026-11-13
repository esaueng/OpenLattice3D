import { expect, type Locator, type Page } from '@playwright/test'

/** Final Results verdict titles (src/components/steps/ResultsStep.tsx `resultVerdict`). */
export const FINAL_VERDICT = /^(All checks passed|Passed with warnings|\d+ of \d+ checks failed)$/

/** Open the app and wait for the workspace to finish restoring preferences. */
export async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Fill a part with a printable lattice' })).toBeVisible()
}

export function workflowNav(page: Page): Locator {
  // The step bar renders twice (top bar and the narrow-screen strip); use the visible one.
  return page.getByRole('navigation', { name: 'Lattice workflow' }).locator('visible=true').first()
}

export async function goToStep(page: Page, label: string): Promise<void> {
  await workflowNav(page).getByRole('button', { name: new RegExp(`^${label}\\b`) }).click()
  await expect(stepEyebrow(page)).toContainText(label)
}

export function stepEyebrow(page: Page): Locator {
  return page.locator('.step-panel-eyebrow')
}

export function sidePanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Lattice workflow panel' })
}

/** "Try a sample" on the start card: the 50 mm sphere. */
export async function loadSampleSphere(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Try a sample/ }).click()
  await expect(page.getByLabel('Project status')).toContainText('Sphere R=25mm')
}

/** Generate at the lowest resolution and wait for the Results verdict. */
export async function generateLowResolution(page: Page): Promise<void> {
  await goToStep(page, 'Generate')
  await sidePanel(page).getByLabel('Resolution').selectOption('1')
  await sidePanel(page).getByRole('button', { name: /^(Generate|Regenerate) lattice/ }).click()
  await expect(stepEyebrow(page)).toContainText('Results', { timeout: 60_000 })
  await expect(resultVerdict(page)).toHaveText(FINAL_VERDICT, { timeout: 60_000 })
}

export function resultVerdict(page: Page): Locator {
  return sidePanel(page).locator('.result-verdict').getByRole('heading', { level: 2 })
}

/**
 * A closed, outward-wound 20 mm cube as a binary STL: 80-byte header,
 * uint32 triangle count, then per triangle a normal, three vertices and a
 * uint16 attribute word (50 bytes).
 */
export function binaryStlCube(size = 20): Buffer {
  const s = size
  const v = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ]
  const faces: [number, number, number][] = [
    [0, 2, 1], [0, 3, 2], // -Z
    [4, 5, 6], [4, 6, 7], // +Z
    [0, 1, 5], [0, 5, 4], // -Y
    [3, 7, 6], [3, 6, 2], // +Y
    [0, 4, 7], [0, 7, 3], // -X
    [1, 2, 6], [1, 6, 5], // +X
  ]
  const buffer = Buffer.alloc(84 + faces.length * 50)
  buffer.write('openlattice3d e2e cube', 0, 'ascii')
  buffer.writeUInt32LE(faces.length, 80)
  faces.forEach((face, index) => {
    const offset = 84 + index * 50
    const [a, b, c] = face.map((i) => v[i])
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const length = Math.hypot(n[0], n[1], n[2]) || 1
    const values = [...n.map((x) => x / length), ...a, ...b, ...c]
    values.forEach((value, k) => buffer.writeFloatLE(value, offset + k * 4))
    buffer.writeUInt16LE(0, offset + 48)
  })
  return buffer
}

export const WORKFLOW_STEPS = ['Model', 'Regions', 'Lattice', 'Shell', 'Generate', 'Results'] as const
export type WorkflowStage = 'Start' | (typeof WORKFLOW_STEPS)[number]

/** Import the generated cube through the hidden model picker (enables the Regions step). */
export async function importCube(page: Page, name = 'e2e-cube.stl'): Promise<void> {
  await page.locator('input[type="file"][accept*=".stl"]').first().setInputFiles({
    name,
    mimeType: 'model/stl',
    buffer: binaryStlCube(),
  })
  await expect(page.getByLabel('Project status')).toContainText(name)
}

/**
 * Visit the empty start screen and every workflow step of an imported part,
 * generating at the lowest resolution before Results.
 */
export async function forEachWorkflowStage(page: Page, visit: (stage: WorkflowStage) => Promise<void>): Promise<void> {
  await openWorkspace(page)
  await visit('Start')
  await importCube(page)
  for (const step of WORKFLOW_STEPS) {
    if (step === 'Results') {
      await generateLowResolution(page)
    } else {
      await goToStep(page, step)
    }
    await visit(step)
  }
}
