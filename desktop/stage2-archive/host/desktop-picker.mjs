// Desktop directory picker: Electron's own native folder dialog.
// The official -native backend spawns its Win32 dialog worker with
// process.execPath (electron.exe in this embedder) and crashes inside the
// worker's koffi COM bindings (FATAL: Error::New napi_get_last_error_info).
// Electron ships a native folder chooser itself, so the desktop assembly
// provides the same ctx.directoryPicker seam ('native' capability) with a
// direct dialog.showOpenDialog call — no child process, no addon.
export const name = 'desktop-directory-picker'

/**
 * Provide the ctx.directoryPicker service directly (assembly-time, before any
 * config-tree entry mounts: the apiproxy entry injects it). Electron's own
 * native folder dialog replaces the official -native backend whose Win32
 * worker spawns with process.execPath (electron.exe here) and crashes inside
 * its koffi COM bindings (FATAL: Error::New napi_get_last_error_info).
 */
export function provideDesktopDirectoryPicker(ctx) {
  ctx.provide('directoryPicker', {
    name,
    capability: () => ({
      kind: 'native',
      pick: async (signal) => {
        if (signal?.aborted) throw new Error('directory picker aborted')
        const { dialog, BrowserWindow } = await import('electron')
        const parent = BrowserWindow.getAllWindows()[0] ?? undefined
        const result = await dialog.showOpenDialog(parent, {
          title: 'Select Workspace Directory',
          properties: ['openDirectory', 'createDirectory'],
        })
        if (signal?.aborted) throw new Error('directory picker aborted')
        if (result.canceled) return null
        return result.filePaths[0] ?? null
      },
    }),
  })
}

export function apply(ctx) {
  provideDesktopDirectoryPicker(ctx)
}

export default { name, apply }
