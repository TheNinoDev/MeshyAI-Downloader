#!/usr/bin/env python3
"""
roblox_fix.py — pick a model + PBR textures, get a Roblox-safe FBX. No Blender UI.

Just double-click / run it and a window opens:
    python "D:\\Fight a Beat\\roblox_fix.py"
    python roblox_fix.py --gui

Or fully headless (GLB works fine — embedded GLB textures are reused for any
map slot you leave empty):
    python roblox_fix.py --input model.glb --albedo colour.png --normal normal.png --roughness rough.png --output fixed.fbx
    python roblox_fix.py --input model.glb --format zip   # fixed.glb + pngs + settings
    python roblox_fix.py --input model.glb --format all   # fbx + glb + zip

Export formats (--format fbx|glb|zip|all, default fbx):
- fbx: Roblox-ready, everything baked in (fixed UVs, embedded textures, rig kept).
- glb: fixed model only (+ its materials/textures, embedded).
- zip: fixed .glb + final .png maps + settings.json (exact inputs/flags used).

What it fixes (per Roblox docs):
- UVs: good UVs are kept as a single 0-1 set; missing/broken/out-of-bounds UVs
  are rebuilt into a packed non-overlapping atlas (SourceUV keeps the originals
  for rebaking, then is removed — export carries exactly one UV set).
- Texture transforms: KHR_texture_transform (what Roblox ignores = the classic
  UV scramble, e.g. 16x scale) is read from the importer's Mapping nodes and
  baked into the UVs (uv*S+O mod 1), so the export samples the right texels.
- Geometry: merge doubles, recalc normals, remove loose, triangulate on export.
- Material: single Principled BSDF wired as Roblox expects:
    Colour/Albedo -> Base Color | Roughness -> Roughness | Metalness -> Metallic
    Normal -> NormalMap -> Normal (OpenGL tangent space)
- Vertex colors: picked by variance (ignores flat-white filler layers) and baked
    to a colour texture when no external colour map is given.
- Textures: sRGB for colour, Non-Color for data maps, auto-downscale >1024 to 1024.
- Rigs: armatures/skin weights from the GLB are baked into FBX/GLB (bind pose,
  no animation); meshes are only auto-joined within the same rig.
- Export: Path Mode COPY + Embed Textures, FBX Scale Units, no leaf bones, no bake anim.

Blender is used headless (blender.exe -b, never opens a window) purely as an
engine: bmesh for UV/geometry surgery, Cycles for texture baking, its image
coders (png/jpg/tga/webp/…) and its FBX + glTF importers/exporters. No Blender
Python knowledge needed — the script drives it for you.

Blender install: auto-detected (Program Files, PATH, BLENDER_EXE/--blender-exe).
Portable, no install needed: download the Blender .zip from blender.org/download,
unpack it into a 'blender-portable' folder next to this script (or inside
D:\\meshy-donloader) — it is found automatically.
Works on Blender 3.x / 4.x / 5.x.
"""

import os
import sys
import argparse
import shutil
import subprocess
import glob as _glob

# ---------------------------------------------------------------------------
# Try to detect "inside Blender" (bpy importable). If yes -> run fixer.
# If no -> run launcher (file dialogs + headless Blender call).
# ---------------------------------------------------------------------------
try:
    import bpy  # noqa: F401
    INSIDE_BLENDER = True
except ImportError:
    INSIDE_BLENDER = False


BLENDER_CANDIDATES = [
    os.environ.get("BLENDER_EXE", ""),
    shutil.which("blender") or "",
    r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.0\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 3.6\blender.exe",
]

MODEL_FILTER = [("3D model (+ zip pack)", "*.fbx *.obj *.glb *.gltf *.dae *.stl *.ply *.x3d *.abc *.zip")]
IMG_FILTER = [("Image", "*.png *.jpg *.jpeg *.tga *.bmp *.tif *.tiff *.webp")]


def find_blender():
    for c in BLENDER_CANDIDATES:
        if c and os.path.isfile(c):
            return c
    # last resort: glob any blender.exe under Program Files
    for base in [r"C:\Program Files\Blender Foundation", os.path.expandvars(r"%LOCALAPPDATA%\Blender Foundation")]:
        hits = _glob.glob(os.path.join(base, "*", "blender.exe"))
        if hits:
            return sorted(hits)[-1]
    found = _find_portable()
    if found:
        return found
    return ""


def _find_portable():
    """Portable Blender (no install needed): a 'blender-portable' folder with the
    unzipped official build next to this script, in the working dir, or in
    D:\\meshy-donloader. Download the .zip from blender.org/download, unpack it."""
    try:
        here = os.path.dirname(os.path.abspath(__file__))
    except Exception:
        here = os.getcwd()
    for root in (here, os.getcwd(), r"D:\meshy-donloader"):
        try:
            direct = os.path.join(root, "blender-portable", "blender.exe")
            if os.path.isfile(direct):
                return direct
            for pat in ("blender-portable/*/blender.exe",
                        "blender-portable/*/*/blender.exe",
                        "blender.exe"):
                hits = _glob.glob(os.path.join(root, pat))
                if hits:
                    return sorted(hits)[-1]
        except Exception:
            continue
    return ""


# ===========================================================================
# PART 1 — LAUNCHER (normal Python, no Blender UI opens)
# ===========================================================================
_MODEL_EXTS = (".glb", ".gltf", ".fbx", ".obj", ".dae", ".stl", ".ply", ".x3d", ".abc")
_IMG_EXTS = (".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff", ".webp")


def _map_slots_by_name(basename):
    """Guess texture slots from a filename (case-insensitive). Returns [slots].
    Covers colour/albedo, normal, roughness, metalness, emissive — plus bare
    tokens like map/orm/arm/mr/pbr (the common combined-map convention)."""
    n = (basename or "").lower()
    slots = []
    if any(k in n for k in ("emissive", "emis", "glow")):
        slots.append("emissive")
    if any(k in n for k in ("rough", "rgh")):
        slots.append("roughness")
    if any(k in n for k in ("metal", "met")):
        slots.append("metalness")
    if any(k in n for k in ("normal", "norm", "nrm")):
        slots.append("normal")
    if any(k in n for k in ("color", "colour", "albedo", "basecolor", "base_color", "diffuse")):
        slots.append("albedo")
    if not slots:
        import re as _re
        toks = set(_re.split(r"[^a-z0-9]+", n))
        if toks & {"map", "orm", "arm", "mr", "pbr"}:
            slots.extend(["roughness", "metalness"])
    return slots


def expand_zip_input(a):
    """If a.input is a .zip pack (extension layout: model.glb + PNGs +
    fixer.json, or any foreign zip): extract to temp and auto-pick model + maps.
    Explicit map fields always win. Sets a.input/a.<slot>/a._zip_temp.
    Raises RuntimeError if no model is inside."""
    import zipfile as _zf
    import tempfile as _tf
    import json as _js
    if not a.input or not a.input.lower().endswith(".zip"):
        return None
    if not os.path.isfile(a.input):
        return None
    tmp = _tf.mkdtemp(prefix="roblox_fix_zip_")
    with _zf.ZipFile(a.input) as z:
        for m in z.namelist():
            if not m or m.endswith("/"):
                continue
            rel = os.path.normpath(m).replace("\\", "/")
            if rel.startswith(("..", "/")) or "/../" in rel or os.path.isabs(rel):
                continue  # zip-slip guard
            dest = os.path.join(tmp, *rel.split("/"))
            try:
                os.makedirs(os.path.dirname(dest) or tmp, exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(z.read(m))
            except Exception:
                continue
    models, images, manifests = [], [], []
    for _root, _ds, _fs in os.walk(tmp):
        for _fn in _fs:
            _p = os.path.join(_root, _fn)
            _e = os.path.splitext(_fn)[1].lower()
            if _e in _MODEL_EXTS:
                models.append(_p)
            elif _e in _IMG_EXTS:
                images.append(_p)
            elif _fn.lower() in ("fixer.json", "settings.json", "manifest.json"):
                manifests.append(_p)
    if not models:
        raise RuntimeError("no model file (.glb/.fbx/...) found inside the zip")
    mani_maps, mani_model = {}, None
    if manifests:
        try:
            with open(manifests[0], "r", encoding="utf-8") as f:
                _doc = _js.load(f)
            _mdir = os.path.dirname(manifests[0])
            _mm = (_doc.get("maps") or {}) if isinstance(_doc, dict) else {}
            for _slot in ("albedo", "normal", "roughness", "metalness", "emissive"):
                _rel = _mm.get(_slot)
                if _rel:
                    for _base in (_mdir, tmp):
                        _cand = os.path.normpath(os.path.join(_base, _rel))
                        if os.path.isfile(_cand):
                            mani_maps[_slot] = _cand
                            break
            _mname = _doc.get("model") if isinstance(_doc, dict) else None
            if _mname:
                for _base in (_mdir, tmp):
                    _cand = os.path.normpath(os.path.join(_base, _mname))
                    if os.path.isfile(_cand) and _cand in models:
                        mani_model = _cand
                        break
            print(f"  ZIP: read manifest '{os.path.basename(manifests[0])}'", flush=True)
        except Exception as e:
            print(f"  ZIP: manifest unreadable ({e})", flush=True)
    model = mani_model
    if model is None:
        _glb = [p for p in models if p.lower().endswith(".glb")]
        model = _glb[0] if _glb else sorted(models)[0]
    a.input = model
    print(f"  ZIP: model -> {os.path.basename(model)}", flush=True)
    for _slot in ("albedo", "normal", "roughness", "metalness", "emissive"):
        if getattr(a, _slot, ""):
            continue  # explicit choice wins
        if _slot in mani_maps:
            setattr(a, _slot, mani_maps[_slot])
            print(f"  ZIP: {_slot} -> {os.path.basename(mani_maps[_slot])} (manifest)", flush=True)
            continue
            for _img in sorted(images):
                if _slot in _map_slots_by_name(os.path.basename(_img)):
                    setattr(a, _slot, _img)
                    print(f"  ZIP: {_slot} -> {os.path.basename(_img)} (name guess)", flush=True)
                    break
    a._zip_temp = tmp
    return tmp


def build_cmd(a):
    """Validate args + locate Blender. Returns headless Blender cmd list. Raises RuntimeError."""
    for p, label in [(a.input, "model"), (a.albedo, "colour"), (a.normal, "normal"),
                     (a.roughness, "roughness"), (a.metalness, "metalness"), (a.emissive, "emissive")]:
        if p and not os.path.isfile(p):
            raise RuntimeError(f"{label} file not found: {p}")
    if not a.input or not os.path.isfile(a.input):
        raise RuntimeError("pick an input model first")
    if not a.output:
        # default: <modelname>_fixed.fbx next to the input
        a.output = os.path.splitext(a.input)[0] + "_fixed.fbx"
    expand_zip_input(a)  # .zip pack -> model + maps (explicit fields win)
    blender = (getattr(a, "blender_exe", "") or "") or find_blender()
    if not blender or not os.path.isfile(blender):
        raise RuntimeError("blender.exe not found — install Blender 3.x+, or unpack the portable "
                           ".zip from blender.org/download into a 'blender-portable' folder next "
                           "to this script (no install needed)")
    inner = ["--input", os.path.abspath(a.input), "--output", os.path.abspath(a.output)]
    if a.albedo: inner += ["--albedo", os.path.abspath(a.albedo)]
    if a.normal: inner += ["--normal", os.path.abspath(a.normal)]
    if a.roughness: inner += ["--roughness", os.path.abspath(a.roughness)]
    if a.metalness: inner += ["--metalness", os.path.abspath(a.metalness)]
    if a.emissive: inner += ["--emissive", os.path.abspath(a.emissive)]
    if a.flip_normal_y: inner += ["--flip-normal-y"]
    if a.no_resize: inner += ["--no-resize"]
    if a.keep_separate: inner += ["--keep-separate"]
    if getattr(a, "force_rebuild", False): inner += ["--force-rebuild"]
    if getattr(a, "no_transform", False): inner += ["--no-transform"]
    _fmt = (getattr(a, "format", "") or "fbx").lower()
    if _fmt not in ("fbx", "glb", "zip", "all"):
        _fmt = "fbx"
    a.format = _fmt
    inner += ["--format", _fmt]
    return [blender, "-b", "--python", os.path.abspath(__file__), "--"] + inner


def gui_main():
    """Simple window: browse model + maps, tick options, FIX + EXPORT with live log."""
    import threading
    import queue as _queue
    import tkinter as tk
    from tkinter import filedialog, messagebox

    root = tk.Tk()
    root.title("Roblox FBX Fixer — GLB/PBR to Roblox-safe FBX")
    root.geometry("680x720")
    root.minsize(560, 480)

    # scrollable content so every row is reachable on small screens
    canvas = tk.Canvas(root, highlightthickness=0)
    scrollbar = tk.Scrollbar(root, orient="vertical", command=canvas.yview)
    canvas.configure(yscrollcommand=scrollbar.set)
    scrollbar.pack(side="right", fill="y")
    canvas.pack(side="left", fill="both", expand=True)

    vars_ = {}
    main = tk.Frame(canvas, padx=12, pady=10)
    _win = canvas.create_window((0, 0), window=main, anchor="nw")
    main.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
    canvas.bind("<Configure>", lambda e: canvas.itemconfig(_win, width=e.width))
    canvas.bind_all("<MouseWheel>", lambda e: canvas.yview_scroll(int(-1 * (e.delta / 120)), "units"))

    tk.Label(main, text="1) Model + texture maps  (leave a map empty to reuse the one inside the GLB —\nor pick a .zip pack and model + maps fill themselves)",
             font=("Segoe UI", 10, "bold"), anchor="w", justify="left").pack(fill="x", pady=(0, 6))

    def add_row(label, key, ftypes, is_save=False):
        tk.Label(main, text=label, anchor="w").pack(fill="x")
        fr = tk.Frame(main); fr.pack(fill="x", pady=(0, 6))
        v = tk.StringVar(); vars_[key] = v
        tk.Entry(fr, textvariable=v).pack(side="left", fill="x", expand=True)
        def browse():
            if is_save:
                try:
                    _fmt = fmt_v.get().lower()
                except Exception:
                    _fmt = "fbx"
                _exts = {"fbx": (".fbx", [("FBX", "*.fbx")]),
                         "glb": (".glb", [("glTF", "*.glb")]),
                         "zip": (".zip", [("ZIP", "*.zip")]),
                         "all": (".fbx", [("FBX", "*.fbx")])}
                _dext, _ft = _exts.get(_fmt, _exts["fbx"])
                inp = vars_["input"].get().strip()
                initdir = os.path.dirname(os.path.abspath(inp)) if inp else os.path.expanduser("~")
                base = os.path.splitext(os.path.basename(inp))[0] if inp else "model"
                p = filedialog.asksaveasfilename(title=label, defaultextension=_dext,
                                                 initialfile=base + "_fixed" + _dext, initialdir=initdir,
                                                 filetypes=_ft)
            else:
                p = filedialog.askopenfilename(title=label, filetypes=ftypes)
            if p: v.set(p)
        tk.Button(fr, text="Browse…", command=browse).pack(side="left", padx=(6, 0))
        tk.Button(fr, text="X", width=3, command=lambda: v.set("")).pack(side="left", padx=(4, 0))
        return v

    add_row("Model (.glb / .fbx / .obj / .gltf / .dae …)", "input", MODEL_FILTER)
    add_row("Colour map / albedo (e.g. colourmap.png)", "albedo", IMG_FILTER)
    add_row("Normal map", "normal", IMG_FILTER)
    add_row("Roughness map", "roughness", IMG_FILTER)
    add_row("Metalness map (optional)", "metalness", IMG_FILTER)
    add_row("Emissive mask (optional)", "emissive", IMG_FILTER)
    tk.Label(main, text="Export format", anchor="w").pack(fill="x")
    _ffr = tk.Frame(main); _ffr.pack(fill="x", pady=(0, 6))
    fmt_v = tk.StringVar(value="FBX")
    tk.OptionMenu(_ffr, fmt_v, "FBX", "GLB", "ZIP", "ALL").pack(side="left")
    tk.Label(_ffr, text="FBX = Roblox · GLB = model · ZIP = glb + pngs + settings",
             anchor="w").pack(side="left", padx=(8, 0))
    add_row("Save output as (extension follows the format)", "output", [("FBX", "*.fbx")], is_save=True)

    def on_input_picked(*_):
        inp = vars_["input"].get().strip()
        if inp and not vars_["output"].get().strip():
            try:
                _e = {"fbx": ".fbx", "glb": ".glb", "zip": ".zip"}.get(fmt_v.get().lower(), ".fbx")
            except Exception:
                _e = ".fbx"
            vars_["output"].set(os.path.splitext(inp)[0] + "_fixed" + _e)
    vars_["input"].trace_add("write", on_input_picked)

    tk.Label(main, text="2) Options", font=("Segoe UI", 10, "bold"), anchor="w").pack(fill="x", pady=(4, 2))
    opt_fr = tk.Frame(main); opt_fr.pack(fill="x")
    flip_v = tk.BooleanVar(value=False); join_v = tk.BooleanVar(value=True); size_v = tk.BooleanVar(value=False)
    rebuild_v = tk.BooleanVar(value=False); notrans_v = tk.BooleanVar(value=False)
    tk.Checkbutton(opt_fr, text="Flip normal green channel (my normal is DirectX)", variable=flip_v).pack(anchor="w")
    tk.Checkbutton(opt_fr, text="Join meshes into one (recommended for Roblox)", variable=join_v).pack(anchor="w")
    tk.Checkbutton(opt_fr, text="Keep textures bigger than 1024px (else auto-downscale)", variable=size_v).pack(anchor="w")
    tk.Checkbutton(opt_fr, text="Rebuild UVs + rebake textures (fixes scrambled mapping)", variable=rebuild_v).pack(anchor="w")
    tk.Checkbutton(opt_fr, text="Ignore embedded texture transforms (raw UVs)", variable=notrans_v).pack(anchor="w")

    tk.Label(main, text="3) Log", font=("Segoe UI", 10, "bold"), anchor="w").pack(fill="x", pady=(4, 0))
    log = tk.Text(main, height=10, wrap="word", state="disabled")
    log.pack(fill="both", expand=True, pady=(2, 6))
    run_btn = tk.Button(main, text="FIX + EXPORT FBX", font=("Segoe UI", 11, "bold"), height=2)
    run_btn.pack(fill="x")

    q = _queue.Queue()

    def log_line(s):
        log.config(state="normal"); log.insert("end", s + "\n"); log.see("end"); log.config(state="disabled")

    def worker(cmd, out, cleanup=""):
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, errors="replace", bufsize=1)
            for line in proc.stdout:
                q.put(("log", line.rstrip()))
            rc = proc.wait()
            q.put(("done", rc))
        except Exception as e:
            q.put(("log", f"ERROR: {e}")); q.put(("done", 1))
        finally:
            if cleanup:
                try:
                    shutil.rmtree(cleanup, ignore_errors=True)
                except Exception:
                    pass

    def poll():
        try:
            while True:
                kind, payload = q.get_nowait()
                if kind == "log":
                    log_line(payload)
                else:
                    run_btn.config(state="normal")
                    if payload == 0 and os.path.isfile(vars_["output"].get().strip()):
                        log_line(f'\nDONE: {vars_["output"].get().strip()}')
                        messagebox.showinfo("Done", "Fixed FBX written.\nImport it via Studio's 3D Importer.")
                    else:
                        log_line("\nFAILED — see log above.")
                        messagebox.showerror("Failed", "Export failed — see log for details.")
        except _queue.Empty:
            pass
        root.after(120, poll)

    def start():
        import argparse as _ap
        a = _ap.Namespace(
            input=vars_["input"].get().strip(), albedo=vars_["albedo"].get().strip(),
            normal=vars_["normal"].get().strip(), roughness=vars_["roughness"].get().strip(),
            metalness=vars_["metalness"].get().strip(), emissive=vars_["emissive"].get().strip(),
            output=vars_["output"].get().strip(), flip_normal_y=flip_v.get(),
            no_resize=size_v.get(), keep_separate=not join_v.get(), blender_exe="",
            force_rebuild=rebuild_v.get(), no_transform=notrans_v.get(),
            format=fmt_v.get().lower(),
        )
        try:
            cmd = build_cmd(a)
        except RuntimeError as e:
            messagebox.showerror("Missing info", str(e)); return
        log.config(state="normal"); log.delete("1.0", "end"); log.config(state="disabled")
        log_line("Running Blender headless (no window opens)…")
        run_btn.config(state="disabled")
        threading.Thread(target=worker, args=(cmd, a.output, getattr(a, "_zip_temp", "") or ""), daemon=True).start()

    run_btn.config(command=start)
    root.after(120, poll)
    root.mainloop()


def launcher_main():
    ap = argparse.ArgumentParser(description="Roblox FBX fixer — window GUI or headless CLI (Blender runs hidden)")
    ap.add_argument("--input", default="", help="input model: glb/fbx/obj/gltf/dae/stl/ply — or a .zip pack (model+maps auto-picked, explicit map flags win; empty slots reuse embedded textures)")
    ap.add_argument("--albedo", default="", help="colour/albedo/basecolour texture (optional if the GLB has one)")
    ap.add_argument("--normal", default="", help="normal map, OpenGL (optional if the GLB has one; use --flip-normal-y for DirectX)")
    ap.add_argument("--roughness", default="", help="roughness map, grayscale (optional if the GLB has one)")
    ap.add_argument("--metalness", default="", help="metalness map, grayscale")
    ap.add_argument("--emissive", default="", help="emissive mask, grayscale")
    ap.add_argument("--output", default="", help="output .fbx path")
    ap.add_argument("--flip-normal-y", action="store_true", help="convert DirectX normal to OpenGL (flips green channel)")
    ap.add_argument("--no-resize", action="store_true", help="keep textures >1024 (Roblox recommends <=1024 for PBR)")
    ap.add_argument("--blender-exe", default="", help="override path to blender.exe")
    ap.add_argument("--keep-separate", action="store_true", help="do NOT join meshes (default joins into one)")
    ap.add_argument("--force-rebuild", action="store_true", help="rebuild UVs into a packed atlas + rebake textures (fixes scrambled mapping)")
    ap.add_argument("--no-transform", action="store_true", help="ignore embedded texture transforms (keep raw UVs)")
    ap.add_argument("--format", default="fbx", help="export format: fbx (Roblox, everything baked in), glb (model only), zip (fixed glb + pngs + settings), all")
    ap.add_argument("--gui", action="store_true", help="open the window GUI")
    a = ap.parse_args()

    # no arguments at all (e.g. double-clicked) -> open the GUI
    if a.gui or len(sys.argv) == 1:
        try:
            import tkinter  # noqa: F401
        except ImportError:
            print("ERROR: tkinter (Python's built-in GUI) is missing.")
            print("Reinstall Python with 'tcl/tk and IDLE' enabled, or use CLI flags (see --help).")
            sys.exit(1)
        gui_main()
        return

    try:
        cmd = build_cmd(a)
    except RuntimeError as e:
        print(f"ERROR: {e}"); sys.exit(1)
    print("Running headless fix (no window opens)...")
    print(" ".join(f'"{c}"' if " " in c else c for c in cmd))
    try:
        r = subprocess.run(cmd)
    finally:
        _tmp = getattr(a, "_zip_temp", "")
        if _tmp:
            try:
                shutil.rmtree(_tmp, ignore_errors=True)
            except Exception:
                pass
    if r.returncode == 0 and os.path.isfile(a.output):
        print(f"\nDONE: {a.output}")
        print("Import into Roblox Studio via 3D Importer — textures are embedded, UVs are 0-1 clean.")
    else:
        print(f"\nFAILED (exit {r.returncode}). See Blender output above."); sys.exit(1)


# ===========================================================================
# PART 2 — INSIDE BLENDER (headless, no UI needed)
# ===========================================================================
def _inside_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="")
    ap.add_argument("--albedo", default="")
    ap.add_argument("--normal", default="")
    ap.add_argument("--roughness", default="")
    ap.add_argument("--metalness", default="")
    ap.add_argument("--emissive", default="")
    ap.add_argument("--output", default="")
    ap.add_argument("--flip-normal-y", action="store_true")
    ap.add_argument("--no-resize", action="store_true")
    ap.add_argument("--keep-separate", action="store_true")
    ap.add_argument("--force-rebuild", action="store_true")
    ap.add_argument("--no-transform", action="store_true")
    ap.add_argument("--format", default="fbx")
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    return ap.parse_args(argv)


def _clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for x in list(coll):
            try: coll.remove(x)
            except Exception: pass


def _import_model(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        try: bpy.ops.wm.obj_import(filepath=path)          # Blender 4+
        except AttributeError: bpy.ops.import_scene.obj(filepath=path)  # 3.x
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".dae":
        bpy.ops.wm.collada_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif ext == ".x3d":
        bpy.ops.import_scene.x3d(filepath=path)
    elif ext == ".abc":
        bpy.ops.wm.alembic_import(filepath=path)
    else:
        raise RuntimeError(f"Unsupported input type: {ext} (tip: .zip packs are auto-expanded by the launcher/GUI, never reach Blender directly)")
    return [o for o in bpy.context.selected_objects if o.type == "MESH"]


def _fill_atlas_uvs(bm, layer):
    """Pack per-chart planar projections into 0-1 UV space (no overlaps, so baked
    textures map 1:1 and Roblox displays them correctly). Charts = regions of faces
    whose normals differ by <= ~66 deg (same spirit as Smart UV Project).
    Pure bmesh — headless safe. Writes loop UVs on `layer`."""
    import math
    faces = list(bm.faces)
    LIM = 1.15
    unassigned = set(faces)
    charts = []
    while unassigned:
        seed = unassigned.pop()
        chart = [seed]
        stack = [seed]
        while stack:
            f = stack.pop()
            try:
                fn = f.normal
            except Exception:
                continue
            for e in f.edges:
                try:
                    neighbours = list(e.link_faces)
                except Exception:
                    continue
                for nf in neighbours:
                    if nf is f or nf not in unassigned:
                        continue
                    try:
                        ok = fn.angle(nf.normal) <= LIM
                    except Exception:
                        ok = True
                    if ok:
                        unassigned.discard(nf)
                        chart.append(nf)
                        stack.append(nf)
        charts.append(chart)
    # project each chart planar along its area-weighted average normal
    items = []  # [pts[(loop,u,v)], min_u, min_v, range_u, range_v]
    for chart in charts:
        anx = any_ = anz = 0.0
        for f in chart:
            try:
                a = f.calc_area()
            except Exception:
                a = 1.0
            anx += f.normal.x * a
            any_ += f.normal.y * a
            anz += f.normal.z * a
        dom = max(range(3), key=lambda i: abs((anx, any_, anz)[i]))
        pts = []
        for f in chart:
            for loop in f.loops:
                co = loop.vert.co
                if dom == 0:
                    u, v = co.y, co.z
                elif dom == 1:
                    u, v = co.x, co.z
                else:
                    u, v = co.x, co.y
                pts.append((loop, u, v))
        us = [p[1] for p in pts]
        vs = [p[2] for p in pts]
        mnx, mxx, mny, mxy = min(us), max(us), min(vs), max(vs)
        items.append([pts, mnx, mny, (mxx - mnx) or 1e-6, (mxy - mny) or 1e-6])
    # shelf-pack (retry smaller fills on overflow), grid fallback never fails
    M = 0.004
    placed = None
    for fill in (0.72, 0.5, 0.32, 0.18):
        total = sum(it[3] * it[4] for it in items) or 1.0
        s = math.sqrt(fill / total)
        rects = []
        for pts, mnx, mny, rx, ry in items:
            w, h, se = rx * s, ry * s, s
            if w > 1 - 2 * M:
                k = (1 - 2 * M) / w
                w, h, se = w * k, h * k, s * k
            rects.append([pts, mnx, mny, se, w, h])
        rects.sort(key=lambda r: -r[5])
        x, y, row_h = M, M, 0.0
        cur = []
        ok = True
        for idx, r in enumerate(rects):
            _pts, _mnx, _mny, _se, w, h = r
            if x + w > 1 - M + 1e-9 and x > M + 1e-9:
                x = M
                y += row_h + M
                row_h = 0.0
            if y + h > 1 - M + 1e-9:
                ok = False
                break
            cur.append((idx, x, y))
            x += w + M
            row_h = max(row_h, h)
        if ok:
            placed = (rects, cur)
            break
    if placed is None:
        # guaranteed-fit grid fallback (uniform cells, aspect preserved)
        n = len(items)
        cols = max(1, math.ceil(math.sqrt(n)))
        cell = (1 - M) / cols
        rects = []
        for pts, mnx, mny, rx, ry in items:
            se = min((cell - M) / rx, (cell - M) / ry)
            rects.append([pts, mnx, mny, se, rx * se, ry * se])
        cur = [(i, M + (i % cols) * cell, M + (i // cols) * cell) for i in range(n)]
        placed = (rects, cur)
    rects, cur = placed
    for idx, ox, oy in cur:
        pts, mnx, mny, se, _w, _h = rects[idx]
        for loop, u, v in pts:
            loop[layer].uv = (ox + (u - mnx) * se, oy + (v - mny) * se)
    print(f"  UV atlas: {len(charts)} charts packed into 0-1 (no overlaps)")


def _fix_geometry_and_uvs(obj, force_rebuild=False, xform=None):
    """Pure bmesh fix — no UI context needed, works headless.
    xform: optional texture transform {scale, offset, rotz, layer} baked into the
    UVs (uv*S+O mod 1) so exports carry the mapping Roblox needs.
    Returns 'kept' (good UVs reused as-is) or 'rebuilt' (packed atlas in UVMap,
    originals preserved as SourceUV for texture rebaking)."""
    import bmesh
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)

    # 1) geometry cleanup
    try: bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001)
    except Exception: pass
    for f in bm.faces:
        try: f.normal_update()
        except Exception: pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # drop loose verts
    loose = [v for v in bm.verts if not v.link_faces]
    if loose: bmesh.ops.delete(bm, geom=loose, context="VERTS")

    # 2) UVs: single layer, force into 0-1.
    # NOTE: snapshot plain data first, then rebuild one fresh layer. Never hold
    # live BMLayerItem refs across remove()/new() — they can go stale and silently
    # read/write the wrong layer's data.
    import math as _math
    loops_flat = [loop for f in bm.faces for loop in f.loops]

    def _planar():
        out = []
        for f in bm.faces:
            n = f.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for loop in f.loops:
                co = loop.vert.co
                if ax == 0: out.append((co.y, co.z))
                elif ax == 1: out.append((co.x, co.z))
                else: out.append((co.x, co.y))
        return out

    try:
        _au = bm.loops.layers.uv.active
        active_name = _au.name if _au is not None else None
    except Exception:
        active_name = None

    snaps = {}  # name -> list of uv per loop in loops_flat order
    # NOTE: fetch each layer ref fresh — bmesh layer refs can go stale.
    for _i in range(len(bm.loops.layers.uv)):
        try:
            lyr = list(bm.loops.layers.uv)[_i]
            snaps[lyr.name] = [tuple(loop[lyr].uv) for loop in loops_flat]
        except Exception:
            continue

    def _bbox(uvs):
        if not uvs:
            return None
        if any(not (_math.isfinite(u[0]) and _math.isfinite(u[1])) for u in uvs):
            return None
        xs = [u[0] for u in uvs]; ys = [u[1] for u in uvs]
        return (min(xs), max(xs), min(ys), max(ys))

    # pick the layer with the largest UV area (skips broken all-zero / collapsed layers)
    keeper, best_area, keeper_bb = None, -1.0, None
    for name, uvs in snaps.items():
        bb = _bbox(uvs)
        area = 0.0 if bb is None else (bb[1] - bb[0]) * (bb[3] - bb[2])
        if bb is not None and area > best_area:
            keeper, best_area, keeper_bb = name, area, bb

    # importers leave the real texture UV as the active layer, while lightmap/AO
    # layers can cover a larger area — prefer the active layer when it looks sane
    if active_name in snaps:
        bb = _bbox(snaps[active_name])
        area = 0.0 if bb is None else (bb[1] - bb[0]) * (bb[3] - bb[2])
        if bb is not None and area > 1e-8 and area >= 0.5 * max(best_area, 0.0):
            if keeper != active_name:
                print(f"  UV: preferring active layer '{active_name}' over '{keeper}'")
            keeper, best_area, keeper_bb = active_name, area, bb

    # bake an embedded texture transform into the UVs before anything else
    if xform is not None:
        _tc = xform.get("layer")
        if _tc and _tc in snaps:
            _bb = _bbox(snaps[_tc])
            _ar = 0.0 if _bb is None else (_bb[1] - _bb[0]) * (_bb[3] - _bb[2])
            if _bb is not None and _ar > 1e-8:
                if keeper != _tc:
                    print(f"  UV: texture reads layer '{_tc}' — using it")
                keeper, best_area, keeper_bb = _tc, _ar, _bb
        if keeper in snaps:
            _sx, _sy = xform["scale"]
            _ox, _oy = xform["offset"]
            _rz = xform.get("rotz", 0.0) or 0.0
            _c, _s = _math.cos(_rz), _math.sin(_rz)
            _raw = []
            for (_u, _v) in snaps[keeper]:
                if _math.isfinite(_u) and _math.isfinite(_v):
                    _x, _y = _u * _sx, _v * _sy
                    if abs(_rz) > 1e-9:
                        _x, _y = _c * _x - _s * _y, _s * _x + _c * _y
                    _raw.append((_x + _ox, _y + _oy))
                else:
                    _raw.append((0.5, 0.5))
            _bb_raw = _bbox(_raw)
            _su = (_bb_raw[1] - _bb_raw[0]) if _bb_raw else 0.0
            _sv = (_bb_raw[3] - _bb_raw[2]) if _bb_raw else 0.0
            if _bb_raw is not None and _su <= 1.05 and _sv <= 1.05:
                # normal case (single tile + slop): wrap ONLY out-of-range
                # values. Wrapping everything would collapse tile-edge
                # interpolation (all corners land on 0) and flatten the texture.
                _out = [((_x if 0.0 <= _x <= 1.0 else _x % 1.0),
                         (_y if 0.0 <= _y <= 1.0 else _y % 1.0)) for (_x, _y) in _raw]
                print(f"  Applied texture transform to '{keeper}' (uv*S+O, single tile)")
            else:
                # genuine multi-tile span: keep unwrapped so SourceUV sampling
                # stays exact; the rebuild step below atlases + rebakes it.
                _out = _raw
                print(f"  Applied texture transform to '{keeper}' (multi-tile span "
                      f"{_su:.2f}x{_sv:.2f} — will rebuild + rebake)")
            snaps[keeper] = _out
            keeper_bb = _bbox(_out)
            best_area = 0.0 if keeper_bb is None else (
                keeper_bb[1] - keeper_bb[0]) * (keeper_bb[3] - keeper_bb[2])

    if keeper is not None and best_area > 1e-8:
        src_uvs = snaps[keeper]
        src_bb = keeper_bb
        print(f"  UV source layer: '{keeper}' ({len(snaps)} found)")
    else:
        src_uvs = _planar()
        src_bb = _bbox(src_uvs)
        print("  UVs missing/degenerate — planar source for rebake")

    in_bounds = (src_bb is not None and src_bb[0] >= -1e-4 and src_bb[2] >= -1e-4
                 and src_bb[1] <= 1 + 1e-4 and src_bb[3] <= 1 + 1e-4)

    # delete ALL layers. Layer refs go stale across remove() calls in Blender 5.x
    # (wrong layer removed, or a hard crash), so re-fetch the tail fresh every
    # iteration — removing the last layer never shifts the remaining indices.
    # Loop refs die too — re-collect after each structural change.
    while len(bm.loops.layers.uv) > 0:
        try:
            bm.loops.layers.uv.remove(list(bm.loops.layers.uv)[-1])
        except Exception:
            break

    if in_bounds and not force_rebuild:
        uv_layer = bm.loops.layers.uv.new("UVMap")
        loops_flat = [loop for f in bm.faces for loop in f.loops]
        for loop, uv in zip(loops_flat, src_uvs):
            loop[uv_layer].uv = uv
        print(f"  UV kept on '{obj.name}': single set, already inside 0-1")
        if xform is None and src_bb is not None:
            _rx, _ry = src_bb[1] - src_bb[0], src_bb[3] - src_bb[2]
            if _rx < 0.2 and _ry < 0.2:
                print(f"  NOTE: '{obj.name}' UVs fill only a tiny {_rx:.3f}x{_ry:.3f} box with no "
                      f"declared transform — scrambled colors in Roblox mean the source hides "
                      f"its mapping (e.g. KHR_texture_transform this run could not see).")
        status = "kept"
    else:
        why = "forced by option" if force_rebuild else "unusable — rebuilding"
        print(f"  UV {why} on '{obj.name}': packed atlas + texture rebake")
        src_layer = bm.loops.layers.uv.new("SourceUV")
        loops_flat = [loop for f in bm.faces for loop in f.loops]
        for loop, uv in zip(loops_flat, src_uvs):
            loop[src_layer].uv = uv
        uv_layer = bm.loops.layers.uv.new("UVMap")
        loops_flat = [loop for f in bm.faces for loop in f.loops]
        _fill_atlas_uvs(bm, uv_layer)
        status = "rebuilt"

    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    try:
        mesh.uv_layers.active = mesh.uv_layers["UVMap"]
    except Exception: pass
    try:
        mesh.uv_layers.active_render = mesh.uv_layers["UVMap"]
    except Exception: pass
    return status


_CHAN_FULL = {"R": "Red", "G": "Green", "B": "Blue", "A": "Alpha"}
_CHAN_IDX = {"R": 0, "G": 1, "B": 2, "A": 3}

def _chan_out(node, letter):
    """Channel output socket, version-proof (Blender 5: Red/Green/Blue, older: R/G/B)."""
    full = _CHAN_FULL.get(letter, letter)
    for key in (full, letter):
        try:
            if key in node.outputs:
                return node.outputs[key]
        except Exception:
            pass
    return node.outputs[_CHAN_IDX.get(letter, 0)]

def _chan_in(node, letter):
    """Channel input socket, version-proof."""
    full = _CHAN_FULL.get(letter, letter)
    for key in (full, letter):
        try:
            if key in node.inputs:
                return node.inputs[key]
        except Exception:
            pass
    return node.inputs[_CHAN_IDX.get(letter, 0)]


def _prep_img(img, non_color, no_resize, label):
    """Colorspace + budget-resize + pack for an already-loaded image (file or embedded)."""
    try:
        img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    except Exception: pass
    try: img.alpha_mode = "STRAIGHT"
    except Exception: pass
    if not no_resize and (img.size[0] > 1024 or img.size[1] > 1024):
        w, h = img.size
        s = 1024 / max(w, h)
        try:
            img.scale(int(w * s), int(h * s))
            print(f"  {label}: downscaled {w}x{h} -> {img.size[0]}x{img.size[1]} (Roblox PBR budget)")
        except Exception as e:
            print(f"  {label}: resize skipped ({e})")
    try: img.pack()
    except Exception: pass
    return img


def _load_img(path, non_color, no_resize, label):
    return _prep_img(bpy.data.images.load(path, check_existing=False), non_color, no_resize, label)


def _read_mapping(mp):
    """Read a Mapping node (importer-created from KHR_texture_transform) as plain data."""
    d = {"loc": (0.0, 0.0), "scale": (1.0, 1.0), "rot": (0.0, 0.0, 0.0), "layer": None}
    try:
        d["loc"] = (float(mp.inputs["Location"].default_value[0]),
                     float(mp.inputs["Location"].default_value[1]))
    except Exception:
        pass
    try:
        d["scale"] = (float(mp.inputs["Scale"].default_value[0]),
                       float(mp.inputs["Scale"].default_value[1]))
    except Exception:
        pass
    try:
        d["rot"] = tuple(float(v) for v in mp.inputs["Rotation"].default_value)
    except Exception:
        pass
    return d


def _find_embedded_maps():
    """Scan imported materials (e.g. from a GLB) for image textures to reuse for empty slots.
    Returns (found, mappings): found like {'albedo': image, ...}, mappings like
    {'albedo': {loc, scale, rot, layer}} for Mapping nodes (KHR_texture_transform)
    sitting upstream of that slot's texture."""
    found = {}
    mappings = {}
    for mat in bpy.data.materials:
        try:
            if not mat.use_nodes or not mat.node_tree:
                continue
            nodes, links = mat.node_tree.nodes, mat.node_tree.links
        except Exception:
            continue
        principled = next((n for n in nodes if getattr(n, "type", "") == "BSDF_PRINCIPLED"), None)
        if principled is None:
            continue
        try:
            link_list = list(links)
        except Exception:
            continue

        def trace_image(node, depth=0):
            """Walk back through converter nodes (Separate Color for GLB ORM packing,
            Math, Mix, etc.) to the source image texture. Returns (image, mapping
            node or None) — a Mapping node directly upstream of the texture is the
            importer's KHR_texture_transform."""
            if node is None or depth > 4:
                return (None, None)
            try:
                if getattr(node, "type", "") == "TEX_IMAGE" and node.image:
                    mp = None
                    for lk in link_list:
                        try:
                            if lk.to_node == node and lk.to_socket.name == "Vector" \
                                    and getattr(lk.from_node, "type", "") == "MAPPING":
                                mp = lk.from_node
                                break
                        except Exception:
                            continue
                    return (node.image, mp)
                for lk in link_list:
                    if lk.to_node == node:
                        img, mp = trace_image(lk.from_node, depth + 1)
                        if img is not None:
                            return (img, mp)
            except Exception:
                pass
            return (None, None)

        def pick(*names):
            for lk in link_list:
                try:
                    if lk.to_node == principled and lk.to_socket.name in names:
                        img, mp = trace_image(lk.from_node)
                        if img is not None:
                            return (img, mp)
                except Exception:
                    continue
            return (None, None)
        for _slot, _names in (("albedo", ("Base Color", "BaseColor")),
                              ("roughness", ("Roughness",)),
                              ("metalness", ("Metallic", "Metalness")),
                              ("emissive", ("Emission Color", "Emission")),
                              ("normal", ("Normal",))):
            img, mp = pick(*_names)
            if img is not None:
                found.setdefault(_slot, img)
                if mp is not None:
                    d = _read_mapping(mp)
                    # which UV layer does this chain read? UVMap node names it,
                    # TexCoord uses the active one.
                    try:
                        for lk in link_list:
                            if lk.to_node == mp and lk.to_socket.name == "Vector":
                                if getattr(lk.from_node, "type", "") == "UVMAP":
                                    try:
                                        d["layer"] = lk.from_node.uv_map
                                    except Exception:
                                        pass
                                break
                    except Exception:
                        pass
                    mappings.setdefault(_slot, d)
    return (found, mappings)


def _color_stats(attr, max_samples=2000):
    """Mean + luminance variance of a color attribute. Returns (mean_rgb, var)."""
    try:
        n = len(attr.data)
        if not n:
            return ((0, 0, 0), 0.0)
        step = max(1, n // max_samples)
        lum = [sum(attr.data[i].color[:3]) / 3.0 for i in range(0, n, step)]
        mean_l = sum(lum) / len(lum)
        var = sum((v - mean_l) ** 2 for v in lum) / len(lum)
        r = sum(attr.data[i].color[0] for i in range(0, n, step)) / len(lum)
        g = sum(attr.data[i].color[1] for i in range(0, n, step)) / len(lum)
        b = sum(attr.data[i].color[2] for i in range(0, n, step)) / len(lum)
        return ((r, g, b), var)
    except Exception:
        return ((0, 0, 0), 0.0)


def _pick_color_attr(mesh):
    """Pick the most informative color attribute (vertex colors).

    Importers often leave a flat-white filler layer next to the real data —
    choose by variance so the actual paint wins. None if no attributes."""
    try:
        attrs = mesh.color_attributes
        if not attrs:
            return None
        best, best_var = None, -1.0
        for attr in attrs:
            _, var = _color_stats(attr)
            if var > best_var:
                best, best_var = attr, var
        return best
    except Exception:
        return None


def _bake_vertex_colors(obj, albedo_img, size, save_path, via_uv=None):
    """Bake COLOR attribute x base texture to a PNG file (DIFFUSE COLOR pass).
    via_uv: sample the base texture through this UV layer ('SourceUV' in the
    rebuild path); None samples the active UVs (keep path).
    Returns the baked image, or None on failure (never raises)."""
    mesh = obj.data
    attr = _pick_color_attr(mesh)
    mean, var = _color_stats(attr) if attr is not None else ((1.0, 1.0, 1.0), 0.0)
    flat_white = attr is not None and all(abs(c - 1.0) < 0.02 for c in mean[:3]) and var < 1e-8
    use_vc = attr is not None and not flat_white
    if not use_vc and albedo_img is None:
        if attr is not None:
            print(f"  Vertex colors of '{obj.name}' are flat white — nothing to bake.")
        return None
    scene = bpy.context.scene
    prev_engine = scene.render.engine
    tmp = None
    try:
        try:
            mesh.uv_layers.active = mesh.uv_layers["UVMap"]
        except Exception:
            pass
        scene.render.engine = "CYCLES"
        try:
            scene.cycles.device = "CPU"
            scene.cycles.samples = 1
        except Exception:
            pass
        tmp = bpy.data.materials.new("TmpBakeVC")
        tmp.use_nodes = True
        nn, ll = tmp.node_tree.nodes, tmp.node_tree.links
        nn.clear()
        out = nn.new("ShaderNodeOutputMaterial")
        pr = nn.new("ShaderNodeBsdfPrincipled")
        ll.new(pr.outputs[0], out.inputs[0])
        base_sock = pr.inputs["Base Color"] if "Base Color" in pr.inputs else pr.inputs[0]
        if use_vc:
            try:
                at = nn.new("ShaderNodeAttribute")
                at.attribute_name = attr.name
                attr_out = at.outputs["Color"]
            except Exception:
                vc = nn.new("ShaderNodeVertexColor")
                try:
                    vc.layer_name = attr.name
                except Exception:
                    pass
                attr_out = vc.outputs["Color"]
        else:
            attr_out = None
        col_out = None
        if albedo_img is not None:
            tn = nn.new("ShaderNodeTexImage")
            tn.image = albedo_img
            if via_uv:
                try:
                    _uvn = nn.new("ShaderNodeUVMap")
                    _uvn.uv_map = via_uv
                    vin = tn.inputs["Vector"] if "Vector" in tn.inputs else tn.inputs[0]
                    ll.new(_uvn.outputs["UV"], vin)
                except Exception:
                    pass
            col_out = tn.outputs["Color"]
        if use_vc:
            if col_out is not None:
                try:
                    mx = nn.new("ShaderNodeMix")
                    mx.data_type = "RGBA"
                    mx.blend_type = "MULTIPLY"
                    mx.inputs["Factor"].default_value = 1.0
                    ll.new(attr_out, mx.inputs["A"])
                    ll.new(col_out, mx.inputs["B"])
                    col_out = mx.outputs["Result"]
                except Exception:
                    col_out = attr_out
            else:
                col_out = attr_out
        if col_out is not None:
            ll.new(col_out, base_sock)
        bake_img = bpy.data.images.new("BakedVertexColor", size, size)
        bn = nn.new("ShaderNodeTexImage")
        bn.image = bake_img
        bn.select = True
        nn.active = bn
        mesh.materials.clear()
        mesh.materials.append(tmp)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=8)
        # NOTE: do NOT touch colorspace_settings here — generated images already
        # default to sRGB, and re-assigning it frees the baked pixel buffer (black image).
        bake_img.filepath_raw = save_path
        bake_img.file_format = "PNG"
        bake_img.save()
        try:
            bake_img.pack()
        except Exception:
            pass
        print(f"  Baked albedo of '{obj.name}' to {save_path}")
        return bake_img
    except Exception as e:
        print(f"  WARNING: vertex-color bake failed for '{obj.name}' ({e}), continuing without it")
        return None
    finally:
        try:
            scene.render.engine = prev_engine
        except Exception:
            pass
        if tmp is not None:
            try:
                if tmp.name in bpy.data.materials:
                    bpy.data.materials.remove(tmp)
            except Exception:
                pass


def _bake_pass(obj, size, save_path, label, wire, bake_type="EMIT"):
    """Generic headless bake onto the active UVMap layer.
    wire(nn, links, head, target_node) builds the graph (head = Emission or
    Principled node). Returns the baked image, or None (never raises)."""
    scene = bpy.context.scene
    prev_engine = scene.render.engine
    tmp = None
    try:
        try:
            obj.data.uv_layers.active = obj.data.uv_layers["UVMap"]
        except Exception:
            pass
        scene.render.engine = "CYCLES"
        try:
            scene.cycles.device = "CPU"
            scene.cycles.samples = 1
        except Exception:
            pass
        tmp = bpy.data.materials.new("TmpBake")
        tmp.use_nodes = True
        nn, ll = tmp.node_tree.nodes, tmp.node_tree.links
        nn.clear()
        out = nn.new("ShaderNodeOutputMaterial")
        safe = "".join(c if c.isalnum() else "" for c in label)[:16] or "Map"
        tgt = bpy.data.images.new("Bake" + safe, size, size)
        tn = nn.new("ShaderNodeTexImage")
        tn.image = tgt
        tn.select = True
        nn.active = tn
        if bake_type == "EMIT":
            head = nn.new("ShaderNodeEmission")
            ll.new(head.outputs[0], out.inputs[0])
            wire(nn, ll, head, tn)
            bake_kwargs = dict(type="EMIT", margin=8)
        else:
            head = nn.new("ShaderNodeBsdfPrincipled")
            ll.new(head.outputs[0], out.inputs[0])
            wire(nn, ll, head, tn)
            bake_kwargs = dict(type="DIFFUSE", pass_filter={"COLOR"}, margin=8)
        mesh = obj.data
        mesh.materials.clear()
        mesh.materials.append(tmp)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(**bake_kwargs)
        # NOTE: generated images default to sRGB — never re-assign colorspace,
        # it frees the baked pixel buffer (black image) on Blender 5.x.
        tgt.filepath_raw = save_path
        tgt.file_format = "PNG"
        tgt.save()
        try:
            tgt.pack()
        except Exception:
            pass
        print(f"  Baked {label} of '{obj.name}' to {save_path}")
        return tgt
    except Exception as e:
        print(f"  WARNING: {label} bake failed for '{obj.name}' ({e})")
        return None
    finally:
        try:
            scene.render.engine = prev_engine
        except Exception:
            pass
        if tmp is not None:
            try:
                if tmp.name in bpy.data.materials:
                    bpy.data.materials.remove(tmp)
            except Exception:
                pass


def _rebake_data_map(obj, src_img, size, save_path, channel, label):
    """Rebake one channel of a source map (sampled via SourceUV) onto the atlas.
    channel 'G' = roughness, 'B' = metalness (glTF ORM packing); dedicated
    grayscale maps have equal channels so the extract is exact for them too."""
    def wire(nn, ll, em, _tn, _img=src_img, _ch=channel):
        t = nn.new("ShaderNodeTexImage")
        t.image = _img
        try:
            u = nn.new("ShaderNodeUVMap")
            u.uv_map = "SourceUV"
            vin = t.inputs["Vector"] if "Vector" in t.inputs else t.inputs[0]
            ll.new(u.outputs["UV"], vin)
        except Exception:
            pass
        try:
            sep = nn.new("ShaderNodeSeparateColor")
        except Exception:
            sep = nn.new("ShaderNodeSeparateRGB")
        sin = sep.inputs["Color"] if "Color" in sep.inputs else (
            sep.inputs["Image"] if "Image" in sep.inputs else sep.inputs[0])
        ll.new(t.outputs["Color"], sin)
        ch = _chan_out(sep, _ch)
        try:
            comb = nn.new("ShaderNodeCombineColor")
        except Exception:
            try:
                comb = nn.new("ShaderNodeCombineRGB")
            except Exception:
                comb = None
        ein = em.inputs["Color"] if "Color" in em.inputs else em.inputs[0]
        if comb is not None:
            for s in ("R", "G", "B"):
                ll.new(ch, _chan_in(comb, s))
            cout = comb.outputs["Image"] if "Image" in comb.outputs else (
                comb.outputs["Color"] if "Color" in comb.outputs else comb.outputs[0])
            ll.new(cout, ein)
        else:
            ll.new(t.outputs["Color"], ein)
    return _bake_pass(obj, size, save_path, label, wire, "EMIT")


def _rebake_rgb_map(obj, src_img, size, save_path, label):
    """Rebake a full-RGB map (emissive) through SourceUV onto the atlas."""
    def wire(nn, ll, em, _tn, _img=src_img):
        t = nn.new("ShaderNodeTexImage")
        t.image = _img
        try:
            u = nn.new("ShaderNodeUVMap")
            u.uv_map = "SourceUV"
            vin = t.inputs["Vector"] if "Vector" in t.inputs else t.inputs[0]
            ll.new(u.outputs["UV"], vin)
        except Exception:
            pass
        ein = em.inputs["Color"] if "Color" in em.inputs else em.inputs[0]
        ll.new(t.outputs["Color"], ein)
    return _bake_pass(obj, size, save_path, label, wire, "EMIT")


def _make_roblox_material(a, alb_src, rgh_src, met_src, nrm_src, emi_src, tag="", origins=None):
    mat = bpy.data.materials.new("RobloxMat" + tag)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    out.location = (400, 0); bsdf.location = (0, 0)
    nt.links.new(bsdf.outputs[0], out.inputs[0])

    origins = origins or {}

    def tex_node(src, non_color, label, loc, slot):
        """src is a file path, an already-loaded image (embedded fallback), or a
        ready-made bake (used as-is — never touch its colorspace)."""
        if src is None or (isinstance(src, str) and not src.strip()):
            return None
        origin = origins.get(slot, "embedded")
        if isinstance(src, str):
            img = _load_img(src, non_color, a.no_resize, label)
            try: img.name = f"Roblox_{label}{os.path.splitext(os.path.basename(src))[1]}"
            except Exception: pass
        elif origin in ("baked", "rebaked"):
            img = src
            print(f"  {label}: using {origin} texture '{src.name}'")
        else:
            img = _prep_img(src, non_color, a.no_resize, label)
            print(f"  {label}: using '{src.name}' embedded in input file (no {slot} file given)")
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = img
        n.label = label
        n.location = loc
        return n

    albedo = tex_node(alb_src, False, "Albedo", (-600, 300), "albedo")
    rough = tex_node(rgh_src, True, "Roughness", (-600, 0), "roughness")
    metal = tex_node(met_src, True, "Metalness", (-600, -250), "metalness")
    normal = tex_node(nrm_src, True, "Normal", (-900, -500), "normal")
    emissive = tex_node(emi_src, False, "Emissive", (-600, -500), "emissive")

    def sock(names):
        for n in names:
            if n in bsdf.inputs: return bsdf.inputs[n]
        return None
    if albedo:
        s = sock(["Base Color", "BaseColor"])
        if s: nt.links.new(albedo.outputs["Color"], s)
    def _chan_link(texnode, socket, channel):
        # Roughness = green channel, metalness = blue (glTF ORM packing).
        # Dedicated grayscale maps have equal channels, so this is exact for
        # them too — and fixes ORM files wired straight into value sockets.
        try:
            sep = nt.nodes.new("ShaderNodeSeparateColor")
        except Exception:
            try:
                sep = nt.nodes.new("ShaderNodeSeparateRGB")
            except Exception:
                sep = None
        if sep is None:
            nt.links.new(texnode.outputs["Color"], socket)
            return
        try:
            sin = sep.inputs["Color"] if "Color" in sep.inputs else sep.inputs[0]
            nt.links.new(texnode.outputs["Color"], sin)
            nt.links.new(_chan_out(sep, channel), socket)
        except Exception:
            try:
                nt.links.new(texnode.outputs["Color"], socket)
            except Exception:
                pass
    if rough:
        s = sock(["Roughness"])
        if s: _chan_link(rough, s, "G")
    if metal:
        s = sock(["Metallic", "Metalness"])
        if s: _chan_link(metal, s, "B")
    if normal:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.location = (-400, -500)
        try: nm.space = "TANGENT"; nm.uv_map = "UVMap"
        except Exception: pass
        if a.flip_normal_y:
            # DX -> GL: invert green channel (node names differ between Blender 3/4 and 5+)
            def _new(types):
                for t in types:
                    try: return nt.nodes.new(t)
                    except Exception: continue
                return None
            sep = _new(["ShaderNodeSeparateColor", "ShaderNodeSeparateRGB"])
            comb = _new(["ShaderNodeCombineColor", "ShaderNodeCombineRGB"])
            inv = nt.nodes.new("ShaderNodeInvert")
            if sep is None or comb is None:
                print("  WARNING: --flip-normal-y not supported on this Blender version, using normal as-is")
                nt.links.new(normal.outputs["Color"], nm.inputs["Color"])
            else:
                sep.location = (-650, -500); inv.location = (-500, -550); comb.location = (-350, -550)
                src_out = normal.outputs["Color"]
                def _in(node, names):
                    for n in names:
                        if n in node.inputs: return node.inputs[n]
                    return node.inputs[0]
                nt.links.new(src_out, _in(sep, ["Image", "Color"]))
                nt.links.new(_chan_out(sep, "R"), _chan_in(comb, "R"))
                nt.links.new(_chan_out(sep, "G"), _in(inv, ["Color"]))
                _cout_inv = inv.outputs["Color"] if "Color" in inv.outputs else inv.outputs[0]
                nt.links.new(_cout_inv, _chan_in(comb, "G"))
                nt.links.new(_chan_out(sep, "B"), _chan_in(comb, "B"))
                _cout = comb.outputs["Image"] if "Image" in comb.outputs else (
                    comb.outputs["Color"] if "Color" in comb.outputs else comb.outputs[0])
                nt.links.new(_cout, _in(nm, ["Color"]))
        else:
            nt.links.new(normal.outputs["Color"], nm.inputs["Color"])
        s = sock(["Normal"])
        if s: nt.links.new(nm.outputs["Normal"], s)
    if emissive:
        s = sock(["Emission Color", "Emission"])
        if s:
            try: nt.links.new(emissive.outputs["Color"], s)
            except Exception: pass

    return mat


def _setup_material(objs, a, embedded=None, baked=None, drop_normal=frozenset()):
    """Assign RobloxMat to every mesh. baked maps (obj_name, slot) -> image
    (vertex-color / rebaked textures); meshes sharing identical sources share
    one material, others get their own copy. drop_normal holds obj names whose
    normal map must NOT be wired (rebuilt UVs can't carry the original normals)."""
    embedded = embedded or {}
    baked = baked or {}
    order = ["albedo", "roughness", "metalness", "normal", "emissive"]
    clis = {"albedo": a.albedo, "roughness": a.roughness, "metalness": a.metalness,
            "normal": a.normal, "emissive": a.emissive}

    def src_of(o, slot):
        if slot == "normal" and o.name in drop_normal:
            return None, "embedded"
        b = baked.get((o.name, slot))
        if b is not None:
            return b, "rebaked"
        return clis[slot] or embedded.get(slot), "embedded"

    def _key(v):
        if v is None:
            return None
        if isinstance(v, str):
            return ("p", v)
        return ("i", id(v))

    groups = {}
    for o in objs:
        groups.setdefault(tuple(_key(src_of(o, s)[0]) for s in order), []).append(o)
    for idx, members in enumerate(groups.values()):
        o0 = members[0]
        srcs, orgs = {}, {}
        for s in order:
            v, og = src_of(o0, s)
            srcs[s], orgs[s] = v, og
        tag = "" if all(orgs[s] == "embedded" or srcs[s] is None or isinstance(srcs[s], str)
                        for s in order) else f"_bake{idx or ''}"
        m = _make_roblox_material(
            a, srcs["albedo"], srcs["roughness"], srcs["metalness"],
            srcs["normal"], srcs["emissive"], tag=tag, origins=orgs,
        )
        for o in members:
            o.data.materials.clear()
            o.data.materials.append(m)
    print(f"Material(s) assigned to {len(objs)} mesh(es) (Principled BSDF, Roblox wiring).")
    return True


def inside_main():
    a = _inside_args()
    if not a.input or not os.path.isfile(a.input):
        print("ERROR: --input missing/not found"); sys.exit(1)
    if not a.output:
        a.output = os.path.splitext(a.input)[0] + "_fixed.fbx"
    print(f"Input : {a.input}")
    print(f"Output: {a.output}")

    _clear_scene()
    imported = _import_model(a.input)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        print("ERROR: no meshes found after import"); sys.exit(1)
    print(f"Imported {len(meshes)} mesh object(s).")

    # pick up textures already inside the file (typical for GLB) for any empty slot
    embedded, mappings = _find_embedded_maps()
    if embedded:
        print("Textures found inside input file: " + ", ".join(sorted(embedded)))

    # KHR_texture_transform is what Roblox ignores (the classic UV scramble):
    # the importer left it as Mapping nodes, so bake it into the UVs
    # (uv*S+O mod 1) — the same convention proven by in-Studio UV fixes.
    xform = None
    if not a.no_transform:
        base_slot, base_map = None, None
        if mappings.get("albedo") is not None:
            base_slot, base_map = "albedo", mappings["albedo"]
        else:
            for _s in ("roughness", "metalness", "normal", "emissive"):
                if mappings.get(_s) is not None:
                    base_slot, base_map = _s, mappings[_s]
                    print(f"  No colour-map transform; driving UVs from '{_s}' transform.")
                    break
        if base_map is not None:
            _sx, _sy = base_map["scale"]
            _ox, _oy = base_map["loc"]
            if abs(_sx - 1.0) > 1e-6 or abs(_sy - 1.0) > 1e-6 \
                    or abs(_ox) > 1e-9 or abs(_oy) > 1e-9:
                _rot = base_map.get("rot") or (0.0, 0.0, 0.0)
                if abs(_rot[0]) > 1e-4 or abs(_rot[1]) > 1e-4:
                    print("  WARNING: texture transform has X/Y rotation — only Z is applied.")
                print(f"  Texture transform from '{base_slot}' map: "
                      f"SU={_sx:.4f} SV={_sy:.4f} OU={_ox:.4f} OV={_oy:.4f}")
                xform = {"scale": (_sx, _sy), "offset": (_ox, _oy),
                         "rotz": _rot[2] if len(_rot) > 2 else 0.0,
                         "layer": base_map.get("layer")}
                for _s, _d in mappings.items():
                    if _s == base_slot:
                        continue
                    if abs(_d["scale"][0] - _sx) > 1e-6 or abs(_d["scale"][1] - _sy) > 1e-6 \
                            or abs(_d["loc"][0] - _ox) > 1e-9 or abs(_d["loc"][1] - _oy) > 1e-9:
                        print(f"  NOTE: '{_s}' map declares a different transform — "
                              f"single UV set uses the '{base_slot}' mapping.")
    else:
        print("  Texture transforms ignored (--no-transform).")

    def _armature_of(o):
        try:
            for m in o.modifiers:
                if m.type == "ARMATURE" and m.object is not None:
                    return m.object
        except Exception:
            pass
        return None

    # optional join — but never across different rigs (that would destroy
    # skinning). Meshes sharing one armature (or none) join as before.
    if not a.keep_separate and len(meshes) > 1:
        _groups = {}
        for o in meshes:
            _arm = _armature_of(o)
            _groups.setdefault(_arm.name if _arm is not None else "", []).append(o)
        _joined = []
        for _key, _mem in _groups.items():
            if len(_mem) < 2:
                _joined.extend(_mem)
                continue
            bpy.ops.object.select_all(action="DESELECT")
            for o in _mem:
                o.select_set(True)
            _act = next((o for o in _mem if _armature_of(o) is not None), _mem[0])
            bpy.context.view_layer.objects.active = _act
            try:
                bpy.ops.object.join()
                _new = bpy.context.view_layer.objects.active
                if _key:
                    try:
                        _has = any(m.type == "ARMATURE" for m in _new.modifiers)
                    except Exception:
                        _has = True
                    if not _has:
                        try:
                            _mod = _new.modifiers.new("Armature", "ARMATURE")
                            _mod.object = bpy.data.objects.get(_key)
                        except Exception:
                            pass
                print(f"Joined {len(_mem)} mesh(es) into '{_new.name}' (rig: {_key or 'none'})")
                _joined.append(_new)
            except Exception as e:
                print(f"Join skipped ({e}), continuing with separate meshes.")
                _joined.extend(_mem)
        meshes = _joined

    # rigs get baked into the export (bind pose + skinning weights, no animation).
    rigs = []
    for o in meshes:
        _arm = _armature_of(o)
        if _arm is not None and _arm.name not in [r.name for r in rigs]:
            rigs.append(_arm)
    for o in bpy.context.scene.objects:
        try:
            if o.type == "ARMATURE" and o.name not in [r.name for r in rigs]:
                rigs.append(o)
        except Exception:
            continue
    if rigs:
        print("Rig(s) kept for export (bind pose): " + ", ".join(r.name for r in rigs))

    statuses = {}
    for o in meshes:
        print(f"Fixing '{o.name}'...")
        statuses[o.name] = _fix_geometry_and_uvs(o, force_rebuild=a.force_rebuild, xform=xform)

    # bake textures so they match the final UVs 1:1.
    # - kept UVs: vertex colors are multiplied into the colour map (glTF-style);
    #   everything else is wired directly.
    # - rebuilt atlas: albedo (VC x source), roughness (G), metalness (B) and
    #   emissive (RGB) are rebaked through SourceUV; normal maps can't be
    #   re-parameterized and are dropped with a warning.
    baked = {}  # (obj_name, slot) -> image
    try:
        os.makedirs(os.path.dirname(os.path.abspath(a.output)) or ".", exist_ok=True)
    except Exception:
        pass
    out_base = os.path.splitext(os.path.abspath(a.output))[0]

    def _out_map(o, suffix):
        if len(meshes) == 1:
            return out_base + "_" + suffix + ".png"
        safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in o.name)[:24]
        return out_base + "_" + safe + "_" + suffix + ".png"

    def _load_src(path, non_color, label):
        if not path:
            return None
        try:
            return _load_img(path, non_color, a.no_resize, label)
        except Exception as e:
            print(f"  WARNING: could not load {label} '{path}' ({e})")
            return None

    ext_alb = _load_src(a.albedo, False, "Albedo")
    ext_rgh = _load_src(a.roughness, True, "Roughness")
    ext_met = _load_src(a.metalness, True, "Metalness")
    ext_nrm = _load_src(a.normal, True, "Normal")
    ext_emi = _load_src(a.emissive, False, "Emissive")
    drop_normal = set()

    for o in meshes:
        rebuilt = statuses.get(o.name) == "rebuilt"
        attr = _pick_color_attr(o.data)
        mean, var = _color_stats(attr) if attr is not None else ((1.0, 1.0, 1.0), 0.0)
        has_vc = attr is not None and not (
            all(abs(c - 1.0) < 0.02 for c in mean[:3]) and var < 1e-8)
        alb_src = ext_alb or embedded.get("albedo")
        if has_vc or (rebuilt and alb_src is not None):
            if has_vc:
                print(f"Baking colour of '{o.name}' (vertex colors x "
                      f"{'file' if a.albedo else ('embedded texture' if alb_src is not None else 'nothing')})…")
            img = _bake_vertex_colors(o, alb_src, 1024, _out_map(o, "albedo"),
                                      via_uv="SourceUV" if rebuilt else None)
            if img is not None:
                baked[(o.name, "albedo")] = img
        elif rebuilt and alb_src is None:
            print(f"  No colour source for '{o.name}' (no file, no embedded texture, no vertex colors).")
        if rebuilt:
            rgh_src = ext_rgh or embedded.get("roughness")
            if rgh_src is not None:
                img = _rebake_data_map(o, rgh_src, 1024, _out_map(o, "roughness"), "G", "Roughness")
                if img is not None:
                    baked[(o.name, "roughness")] = img
            met_src = ext_met or embedded.get("metalness")
            if met_src is not None:
                img = _rebake_data_map(o, met_src, 1024, _out_map(o, "metalness"), "B", "Metalness")
                if img is not None:
                    baked[(o.name, "metalness")] = img
            emi_src = ext_emi or embedded.get("emissive")
            if emi_src is not None:
                img = _rebake_rgb_map(o, emi_src, 1024, _out_map(o, "emissive"), "Emissive")
                if img is not None:
                    baked[(o.name, "emissive")] = img
            if (a.normal or embedded.get("normal")) is not None:
                print(f"  NOTE: normal map dropped for '{o.name}' (rebuilt UVs can't carry original normals; geometry normals are kept).")
                drop_normal.add(o.name)

    # drop the helper SourceUV layer — export carries exactly one UV set
    for o in meshes:
        try:
            names = [l.name for l in o.data.uv_layers]
            if "SourceUV" in names:
                o.data.uv_layers.remove(o.data.uv_layers["SourceUV"])
        except Exception:
            pass

    # validate UVs
    ok = True
    for o in meshes:
        mesh = o.data
        names = [l.name for l in mesh.uv_layers]
        if names != ["UVMap"]:
            print(f"  ERROR: '{o.name}' UV layers {names} (must be exactly ['UVMap'])"); ok = False
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        print(f"  '{o.name}': {len(mesh.vertices)} verts, {len(mesh.polygons)} polys (~{tris} tris), UV: {names}")
    if not ok:
        print("ERROR: UV validation failed"); sys.exit(1)

    _setup_material(meshes, a, embedded, baked, drop_normal)

    def _select_export():
        # meshes + rigs + their parents (keeps skinning/transforms consistent)
        bpy.ops.object.select_all(action="DESELECT")
        _extra = []
        for o in meshes + rigs:
            try:
                _p = o.parent
            except Exception:
                _p = None
            while _p is not None:
                _extra.append(_p)
                try:
                    _p = _p.parent
                except Exception:
                    break
        for o in meshes + rigs + _extra:
            try:
                o.select_set(True)
            except Exception:
                pass
        if meshes:
            bpy.context.view_layer.objects.active = meshes[0]

    fmt = (getattr(a, "format", "") or "fbx").lower()
    if fmt not in ("fbx", "glb", "zip", "all"):
        fmt = "fbx"
    _base = os.path.splitext(os.path.abspath(a.output))[0]
    _paths = {"fbx": _base + ".fbx", "glb": _base + ".glb", "zip": _base + ".zip"}
    want = {"fbx"} if fmt == "fbx" else ({"glb"} if fmt == "glb" else ({"zip"} if fmt == "zip" else {"fbx", "glb", "zip"}))
    os.makedirs(os.path.dirname(_base) or ".", exist_ok=True)
    made = []

    if "fbx" in want:
        _select_export()
        print("Exporting FBX (rig baked in, COPY + Embed, FBX Scale Units, triangulated)...")
        try:
            bpy.ops.export_scene.fbx(
                filepath=_paths["fbx"],
                use_selection=True,
                path_mode="COPY",
                embed_textures=True,
                apply_scale_options="FBX_SCALE_UNITS",
                bake_space_transform=True,
                use_mesh_modifiers=True,
                use_triangles=True,
                mesh_smooth_type="FACE",
                add_leaf_bones=False,
                bake_anim=False,
                axis_forward="-Z",
                axis_up="Y",
            )
            if os.path.isfile(_paths["fbx"]):
                made.append(_paths["fbx"])
        except Exception as e:
            print(f"  ERROR: FBX export failed ({e})")

    if "glb" in want:
        _select_export()
        print("Exporting GLB (fixed model only, textures embedded)...")
        try:
            bpy.ops.export_scene.gltf(
                filepath=_paths["glb"],
                export_format="GLB",
                use_selection=True,
            )
            if os.path.isfile(_paths["glb"]):
                made.append(_paths["glb"])
        except Exception as e:
            print(f"  ERROR: GLB export failed ({e})")

    if "zip" in want:
        import shutil as _shutil
        import tempfile as _tf
        import json as _js
        import datetime as _dt
        try:
            _stage = _tf.mkdtemp(prefix="roblox_fix_")
            _select_export()
            _glb_name = os.path.basename(_base) + ".glb"
            bpy.ops.export_scene.gltf(
                filepath=os.path.join(_stage, _glb_name),
                export_format="GLB",
                use_selection=True,
            )
            _maps_dir = os.path.join(_stage, "maps")
            os.makedirs(_maps_dir, exist_ok=True)
            _seen = set()
            for _o in meshes:
                for _m in _o.data.materials:
                    if not _m or not getattr(_m, "use_nodes", False):
                        continue
                    try:
                        _nodes = _m.node_tree.nodes
                    except Exception:
                        continue
                    for _n in _nodes:
                        try:
                            if getattr(_n, "type", "") != "TEX_IMAGE" or not _n.image:
                                continue
                            _key = (_n.label or _n.image.name or "map")
                            if _key in _seen:
                                continue
                            _seen.add(_key)
                            _safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in _key)[:40] or "map"
                            _fp = os.path.join(_maps_dir, _safe + ".png")
                            _n.image.filepath_raw = _fp
                            _n.image.file_format = "PNG"
                            _n.image.save()
                        except Exception as e:
                            print(f"  WARNING: could not stage map ({e})")
            _settings = {
                "tool": "roblox_fix.py",
                "date": _dt.datetime.now().isoformat(timespec="seconds"),
                "input": a.input,
                "maps": {"albedo": a.albedo, "normal": a.normal, "roughness": a.roughness,
                         "metalness": a.metalness, "emissive": a.emissive},
                "flags": {"flip_normal_y": bool(a.flip_normal_y), "no_resize": bool(a.no_resize),
                          "keep_separate": bool(a.keep_separate),
                          "force_rebuild": bool(getattr(a, "force_rebuild", False)),
                          "no_transform": bool(getattr(a, "no_transform", False))},
                "uv_statuses": statuses,
                "format": fmt,
            }
            with open(os.path.join(_stage, "settings.json"), "w", encoding="utf-8") as _f:
                _js.dump(_settings, _f, indent=2)
            print(f"  Staged {len(_seen)} map(s) + settings.json")
            _shutil.make_archive(_base, "zip", _stage)
            if os.path.isfile(_paths["zip"]):
                made.append(_paths["zip"])
            try:
                _shutil.rmtree(_stage, ignore_errors=True)
            except Exception:
                pass
        except Exception as e:
            print(f"  ERROR: ZIP export failed ({e})")

    if not made:
        print("ERROR: export failed (no file written)"); sys.exit(1)
    for _p in made:
        try:
            print(f"SUCCESS: {_p} ({os.path.getsize(_p) // 1024} KB)")
        except Exception:
            print(f"SUCCESS: {_p}")
    if "fbx" in want and _paths["fbx"] in made:
        print("Next: Roblox Studio > Plugins > 3D Importer > pick this FBX. Textures come embedded.")


if __name__ == "__main__":
    if INSIDE_BLENDER:
        inside_main()
    else:
        launcher_main()
