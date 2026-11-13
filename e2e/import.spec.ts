import { expect, test, type Page } from '@playwright/test'
import { binaryStlCube, importCube, openWorkspace, sidePanel, stepEyebrow } from './helpers'

const FILE_NAME = 'e2e-cube.stl'

async function expectCubeImported(page: Page) {
  await expect(page.getByLabel('Project status')).toContainText(FILE_NAME)
  await expect(stepEyebrow(page)).toContainText('Model')
  const facts = sidePanel(page).locator('dl.facts')
  await expect(facts).toContainText(FILE_NAME)
  // 20 mm cube: 12 triangles, 8 shared vertices, closed. Millimetres are kept as-is.
  await expect(facts).toContainText(/Triangles\s*12(?!\d)/)
  await expect(facts).toContainText(/Vertices\s*8(?!\d)/)
  await expect(facts).toContainText(/Watertight\s*Yes/)
  await expect(facts).toContainText(/Manifold\s*Yes/)
  await expect(facts).toContainText(/20(\.0+)?\s*×\s*20(\.0+)?\s*×\s*20(\.0+)?/)
}

test('imports a binary STL through the file input', async ({ page }) => {
  await openWorkspace(page)
  // The hidden STL picker behind "Import STL"; set its files directly.
  await importCube(page, FILE_NAME)
  await expectCubeImported(page)
})

test('imports a binary STL dropped onto the page', async ({ page }) => {
  await openWorkspace(page)
  const bytes = [...binaryStlCube()]
  await page.evaluate(({ bytes, name }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'model/stl' }))
    const target = document.querySelector('main') ?? document.body
    for (const type of ['dragenter', 'dragover']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
  }, { bytes, name: FILE_NAME })
  // The drop overlay is shown while files hover over the page.
  await expect(page.getByText('Drop an STL to import it')).toBeVisible()

  await page.evaluate(({ bytes, name }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'model/stl' }))
    const target = document.querySelector('main') ?? document.body
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, { bytes, name: FILE_NAME })

  await expect(page.getByText('Drop an STL to import it')).toBeHidden()
  await expectCubeImported(page)
})
