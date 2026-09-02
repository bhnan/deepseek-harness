import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, REPO_ROOT, saveFailureShot } from './support.ts'

const MOBILE_VIEWPORT = { width: 390, height: 844 }
const WORKSPACE_NAME = 'workspace'
const FILE_NAME = 'mobile-notes.md'
const FILE_CONTENT = '# Mobile notes\n'
const IMAGE_NAME = 'mobile-pixel.png'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const FAILURE_ARTIFACT = 'web-e2e-mobile-file-picker'
const TRACE_PATH = join(REPO_ROOT, '.artifacts', `${FAILURE_ARTIFACT}.zip`)

describe('web e2e: mobile workspace file picker', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }
  let consoleMessages: Array<{ type: string; text: string }> = []
  let tracingActive = false

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: MOBILE_VIEWPORT,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US',
    })
    tripwire = watchConsole(page)
    consoleMessages = []
    page.on('console', (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() })
    })
    await page.context().tracing.start({ screenshots: true, snapshots: true })
    tracingActive = true
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, WORKSPACE_NAME)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    if (tracingActive && page !== undefined) {
      await page.context().tracing.stop().catch((error: unknown) => failures.push(error))
      tracingActive = false
    }
    if (browser !== undefined) {
      await browser.close().catch((error: unknown) => failures.push(error))
      browser = undefined
    }
    if (scaffold !== undefined) {
      await scaffold.close().catch((error: unknown) => failures.push(error))
      scaffold = undefined
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'mobile file picker teardown failed')
  })

  it('uploads a workspace file and previews a photo through the mobile picker', async () => {
    const activePage = page
    const activeScaffold = scaffold
    if (activePage === undefined || activeScaffold === undefined) {
      throw new Error('mobile file picker setup did not complete')
    }

    onTestFailed(async () => {
      await saveFailureShot(activePage, FAILURE_ARTIFACT)
      if (!tracingActive) return
      try {
        await mkdir(join(REPO_ROOT, '.artifacts'), { recursive: true })
        await activePage.context().tracing.stop({ path: TRACE_PATH })
      } catch {
        // Best-effort trace evidence must not mask the failed browser assertion.
      }
      tracingActive = false
    })

    const attach = activePage.getByRole('button', { name: 'Attach', exact: true })
    await attach.waitFor({ timeout: 10_000 })
    await attach.click()
    const dialog = activePage.getByRole('dialog', { name: 'Attach a file', exact: true })
    await dialog.waitFor({ timeout: 10_000 })
    const chooseFile = dialog.getByRole('button', { name: 'Choose file', exact: true })
    expect(await chooseFile.count()).toBe(1)

    const [fileChooser] = await Promise.all([
      activePage.waitForEvent('filechooser'),
      chooseFile.click(),
    ])
    const genericInput = fileChooser.element()
    expect(await genericInput.getAttribute('data-file-picker-kind')).toBe('file')
    expect(await genericInput.getAttribute('accept')).toBeNull()
    await fileChooser.setFiles({
      name: FILE_NAME,
      mimeType: 'text/markdown',
      buffer: Buffer.from(FILE_CONTENT),
    })

    const composer = activePage.locator('textarea:enabled[placeholder="Describe what you want to build"]').first()
    await expect.poll(() => composer.inputValue(), { timeout: 15_000 }).toBe(`@uploads/${FILE_NAME} `)
    expect(await readFile(join(activeScaffold.workspaceCwd, WORKSPACE_NAME, 'uploads', FILE_NAME), 'utf8'))
      .toBe(FILE_CONTENT)
    await expect.poll(
      () => dialog.locator('input[data-file-picker-kind="file"]').isDisabled(),
      { timeout: 10_000 },
    ).toBe(false)
    expect(await activePage.getByRole('group', { name: 'Pending images', exact: true }).count()).toBe(0)

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)
    await attach.click()
    await dialog.waitFor({ timeout: 10_000 })
    const [photoChooser] = await Promise.all([
      activePage.waitForEvent('filechooser'),
      dialog.getByRole('button', { name: 'Choose photos', exact: true }).click(),
    ])
    const photoInput = photoChooser.element()
    expect(await photoInput.getAttribute('data-file-picker-kind')).toBe('photos')
    expect(await photoInput.getAttribute('accept')).toContain('image/*')
    await photoChooser.setFiles({
      name: IMAGE_NAME,
      mimeType: 'image/png',
      buffer: PNG,
    })

    const imageRail = activePage.getByRole('group', { name: 'Pending images', exact: true })
    await expect.poll(() => imageRail.count(), { timeout: 15_000 }).toBe(1)
    const thumbnail = imageRail.getByRole('img', { name: IMAGE_NAME, exact: true })
    await expect.poll(() => thumbnail.count(), { timeout: 15_000 }).toBe(1)
    expect(await thumbnail.isVisible()).toBe(true)

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)
    await thumbnail.click()
    const preview = activePage.getByRole('dialog', { name: 'Original image preview', exact: true })
    await preview.waitFor({ timeout: 10_000 })
    expect(await preview.getByRole('img', { name: IMAGE_NAME, exact: true }).isVisible()).toBe(true)
    await preview.getByRole('button', { name: 'Close original image preview', exact: true }).click()
    await expect.poll(() => preview.count(), { timeout: 10_000 }).toBe(0)

    await activePage.waitForTimeout(0)
    const browserIssues = consoleMessages.filter(({ type }) => type === 'error' || type === 'warning')
    expect(browserIssues, `unexpected browser console output: ${JSON.stringify(browserIssues)}`).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
