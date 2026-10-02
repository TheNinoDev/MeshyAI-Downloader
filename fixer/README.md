# MeshyFixer - local model fixer (companion to the Meshy2GLB extension)

Takes a captured `.glb` (+ optional PNG maps) and produces import-ready files
for Roblox Studio. Drives Blender headless in the background - you never open
Blender itself.

## What it fixes

- **UV scramble** - bakes `KHR_texture_transform` (e.g. 16x scale, which Roblox
  ignores) into the UVs, so textures land on the right faces.
- **UV errors** - good UVs are kept as one 0-1 set; broken/missing ones are
  rebuilt into a packed atlas and the textures are rebaked to match 1:1.
- **Materials** - one Principled BSDF wired the Roblox way (colour, roughness
  from green, metalness from blue, OpenGL normal map). Empty slots reuse
  textures embedded in the GLB. Vertex colors are baked to a texture.
- **Rigs** - armatures + skin weights from the GLB are baked into FBX/GLB
  exports (bind pose, no animation). Meshes only auto-join within one rig.

## Export formats (GUI dropdown, or `--format`)

- **FBX** - Roblox-ready, everything baked in (fixed UVs, embedded textures, rig).
- **GLB** - fixed model only (+ materials/textures, embedded).
- **ZIP** - fixed `.glb` + final `.png` maps + `settings.json` (exact inputs/flags).
- **ALL** - writes all three.

## Setup (2 minutes, no Blender install needed)

1. Install Python 3.10+ from https://www.python.org/downloads/ (tick
   **"Add python.exe to PATH"**).
2. Portable Blender (pick one):
   - **A. Installed Blender** - normal install from blender.org; found automatically.
   - **B. No install** - download the Blender **.zip** (not the installer) from
     https://www.blender.org/download/, unpack it into
     `D:\meshy-donloader\fixer\blender-portable\` so that
     `blender-portable\blender.exe` exists. Also detected: a
     `blender-portable\` folder directly under `D:\meshy-donloader\`.
   Blender 3.x / 4.x / 5.x all work. Priority: `--blender-exe` >
   `BLENDER_EXE` env > PATH > installed > portable folders.
3. Double-click **`FixerGUI.bat`**, or run `python roblox_fix.py --gui`.

## Workflow with the extension

1. Capture the model on meshy.ai, save it via the popup (**Save as…**,
   **Quick**, or **GLB + PNG** / the new **ZIP** button).
2. Open the fixer GUI, pick the `.glb` (+ colour/normal/roughness maps if you
   have separate PNGs - leave empty to reuse what's inside the GLB).
3. Recommended boxes for Meshy packs: everything **off** except
   **Join meshes into one**. Format **FBX** for Roblox.
4. Import the `*_fixed.fbx` via Studio's 3D Importer (textures are embedded).

Headless example:

```text
python roblox_fix.py --input model.glb --albedo colour.png --normal normal.png --roughness rough.png --format all
```

## `.zip` packs as input

The extension's **ZIP** button produces a fixer-ready pack
(`model.glb` + semantic PNGs + `fixer.json` with the exact slot mapping).
Just select the `.zip` as the model — nothing else is needed:

```text
python roblox_fix.py --input pack.zip
```

Mapping precedence per slot: your explicit file choice > `fixer.json`
manifest > filename guess (colour/albedo, normal, rough, metal, emissive,
bare map/orm tokens) > textures embedded in the model. Foreign zips without
a manifest work too (nested folders are searched).
