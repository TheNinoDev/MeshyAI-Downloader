# Meshy2GLB - Chrome Extension

Capture decrypted GLB models on meshy.ai and save them from the pinned-extension popup, choosing exactly where each file goes.

Ported from the `meshy2glb` Tampermonkey userscript (`script.js` capture logic: Worker / fetch / createObjectURL hooks) into a Manifest V3 extension with a proper popup UI.

## Features

- Watches meshy.ai for decrypted GLB buffers (WASM-worker output, CDN fetches, viewer blobs)
- Pinned-extension popup lists every captured model (name, size, source, time)
- **Save As...** - opens a file picker so you choose the folder + filename
- **Quick** - straight into the Downloads folder, no dialog
- **GLB + PNG** - model plus every embedded texture as extra files
- **ZIP** - one `.zip` with `model.glb`, semantic PNGs (`*_albedo`,
  `*_normal`, `*_roughness_metalness`, …) and a `fixer.json` manifest, so the
  local fixer knows exactly which file goes in which slot (built locally, no upload)
- Badge counter on the toolbar icon, Refresh + Clear
- No auto-download spam, no on-page button

## Install (Developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder (`D:\meshy-donloader`)
4. Pin **Meshy2GLB** in the toolbar (puzzle icon -> pin)

## Usage

1. Go to `meshy.ai` and open a model in your workspace
2. Trigger a decrypt: press **Export / Download / Preview** (or load the 3D preview) - the extension captures the GLB in the background
3. Click the pinned **Meshy2GLB** icon - your models appear in the popup
4. Hit **Save As...**, pick the folder in the dialog, done
5. If the list is empty: press **Refresh**; if the page was open before install, refresh the meshy.ai tab once

## How saving works

- **Save As...** uses the File System Access API (`showSaveFilePicker`) directly in the popup, so the folder chooser is guaranteed. Fallback: Chrome downloads API with `saveAs: true`.
- **Quick** uses `chrome.downloads` with `saveAs: false` (respects your Chrome "Ask where to save" setting if enabled).

## Files

- `manifest.json` - MV3 manifest (meshy.ai host, popup, icons)
- `injected.js` - MAIN-world capture engine (ported userscript hooks)
- `content.js` - isolated-world bridge (injects + relays messages)
- `background.js` - per-tab metadata store + toolbar badge
- `popup.html` / `popup.css` / `popup.js` - popup UI + save flows
- `zip.js` - vendored no-dependency ZIP writer (MV3 CSP-safe, used by the ZIP button)
- `fixer/` - local model fixer, see below
- `icons/` - toolbar icons

## Local fixer -> Roblox-ready FBX (`fixer/`)

The browser cannot run Blender, so FBX export with fixed UVs, baked maps and
rigs lives in the `fixer/` companion tool (double-click `fixer/FixerGUI.bat`,
Blender runs hidden in the background):

- **Export formats**: FBX (Roblox, everything baked in), GLB (model only),
  ZIP (fixed glb + final PNGs + `settings.json` with the exact settings used),
  ALL (all three).
- **Rigs** from the GLB are baked into FBX/GLB (bind pose + skin weights).
- **No Blender install needed**: unpack the portable Blender `.zip` into
  `fixer/blender-portable/` (auto-detected, next to `roblox_fix.py`).
- Recommended boxes for Meshy packs: everything off except Join; format FBX.

Flow: capture on meshy.ai -> **ZIP** (or GLB + PNG) from the popup ->
select the `.zip` in the fixer GUI (model + maps fill themselves) ->
import `*_fixed.fbx` in Studio's 3D Importer.
After pulling an update: reload the extension once at `chrome://extensions`
(puzzle icon -> refresh) so the new popup code loads.

## Troubleshooting

- "Cannot reach the Meshy tab" - refresh the meshy.ai tab (content script only injects on fresh loads after install), then press Refresh in the popup
- "Model no longer in memory" - the page was reloaded; re-export the model to capture it again
- Save picker never appears - your Chromium must support File System Access (Chrome/Edge 86+); otherwise the extension falls back to Chrome Save-As dialog

## Note

Only download models you own or have the rights to. This is a local capture tool - nothing is uploaded anywhere.

## Roblox plugin (MeshyFix.lua)

Fixes the selected mesh(es) in Roblox Studio: applies your imported PNG
textures (classic `TextureID` or PBR `SurfaceAppearance`) and one-click mesh
fixes (`DoubleSided`, `CollisionFidelity`, `RenderFidelity`). Undo via Ctrl+Z.

### Install

A) In Studio: add a Script (e.g. under ServerScriptService), paste the
contents of `MeshyFix.lua`, right-click it -> **Save as Local Plugin**.
B) Or copy `MeshyFix.lua` to `%LOCALAPPDATA%\Roblox\Plugins` and restart Studio.

Open it via the **MeshyFix** button in the PLUGINS tab.

### Usage

1. Bulk-import `model.glb` + `textureN.png` via Asset Manager.
2. Select the imported MeshPart(s) (or the whole Model).
3. Paste the texture asset ID(s) from the import into the plugin panel:
one ID applies to all, several IDs are assigned in selection order.
4. **Apply as TextureID** (simple) or **Apply as SurfaceAppearance** (PBR).
5. If faces look inside-out: **DoubleSided ON**.
