import { expect, test } from '@playwright/test'
import { generateLowResolution, goToStep, loadSampleSphere, openWorkspace, sidePanel } from './helpers'

test('sample sphere generates, validates and exports a non-empty STL', async ({ page }) => {
  await openWorkspace(page)
  await loadSampleSphere(page)
  await generateLowResolution(page)

  const exportStl = sidePanel(page).getByRole('button', { name: /^Export (previous )?STL( anyway)?$/ })
  const downloadPromise = page.waitForEvent('download')
  await exportStl.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.stl$/)

  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
  const stl = Buffer.concat(chunks)
  // Binary STL: 80-byte header, uint32 triangle count, 50 bytes per triangle.
  expect(stl.length).toBeGreaterThan(84)
  const triangles = stl.readUInt32LE(80)
  expect(triangles).toBeGreaterThan(0)
  expect(stl.length).toBe(84 + triangles * 50)
})

test('loading a sample over a result asks first, and "Keep current model" keeps it', async ({ page }) => {
  await openWorkspace(page)
  await loadSampleSphere(page)
  await generateLowResolution(page)

  await goToStep(page, 'Model')
  await sidePanel(page).getByRole('group', { name: 'Sample parts' }).getByRole('button', { name: /Cube/ }).click()

  const prompt = page.getByRole('alertdialog', { name: /Replace Sphere R=25mm with/ })
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText('the generated lattice')
  const keep = prompt.getByRole('button', { name: 'Keep current model' })
  await expect(keep).toBeFocused()
  await keep.click()

  await expect(prompt).toBeHidden()
  await expect(page.getByLabel('Project status')).toContainText('Sphere R=25mm')
  // The result survived: Results is still reachable.
  await goToStep(page, 'Results')
})
